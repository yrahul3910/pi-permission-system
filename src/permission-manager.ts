import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import {
  extractFrontmatter,
  findFirstMatchForNames,
  getNonEmptyString,
  isPermissionState,
  normalizePathResourceForPermission,
  parseSimpleYamlMap,
  toRecord,
} from "./common.js";
import {
  DEFAULT_BASH_SYNTAX_POLICY,
  evaluateBashCommand,
  parseBashRulePrefix,
  type BashEvaluationContext,
  type BashRuleSets,
  type BashSyntaxPolicy,
} from "./bash-evaluator.js";
import { formatJsoncConfigLoadWarning, parseJsoncConfig } from "./jsonc-config.js";
import {
  compileRegistry,
  createProtectedPathMatcher,
  type CompiledRegistry,
  type ProtectedPathMatcher,
} from "./safe-commands.js";
import type {
  AgentPermissions,
  BashPermissionSection,
  GlobalPermissionConfig,
  PermissionCheckResult,
  PermissionDefaultPolicy,
  PermissionState,
} from "./types.js";
import {
  compileWildcardPatternEntries,
  findCompiledWildcardMatch,
  type CompiledWildcardPattern,
} from "./wildcard-matcher.js";

const PERMISSION_POLICY_AGENT_DIR_ENV_KEY = "PI_PERMISSION_SYSTEM_POLICY_AGENT_DIR";

function defaultPolicyAgentDir(): string {
  const override = process.env[PERMISSION_POLICY_AGENT_DIR_ENV_KEY]?.trim();
  return override ? resolve(override) : getAgentDir();
}

function defaultGlobalConfigPath(): string { return join(defaultPolicyAgentDir(), "pi-permissions.jsonc"); }
function defaultAgentsDir(): string { return join(defaultPolicyAgentDir(), "agents"); }
function defaultLegacyGlobalSettingsPath(): string { return join(defaultPolicyAgentDir(), "settings.json"); }
function defaultGlobalMcpConfigPath(): string { return join(defaultPolicyAgentDir(), "mcp.json"); }

const BUILT_IN_TOOL_PERMISSION_NAMES = new Set(["bash", "read", "write", "edit", "grep", "find", "ls"]);
const SPECIAL_PERMISSION_KEYS = new Set(["doom_loop", "external_directory"]);
const MCP_BASELINE_TARGETS = new Set(["mcp_status", "mcp_list", "mcp_search", "mcp_describe", "mcp_connect"]);

const DEFAULT_POLICY: PermissionDefaultPolicy = {
  tools: "ask",
  bash: "ask",
  mcp: "ask",
  skills: "ask",
  special: "ask",
};

function createEmptyBashSection(): BashPermissionSection {
  return { allow: [], ask: [], deny: [], syntax: {}, registryOverrides: {} };
}

const EMPTY_GLOBAL_CONFIG: GlobalPermissionConfig = {
  defaultPolicy: DEFAULT_POLICY,
  tools: {},
  bash: createEmptyBashSection(),
  protectedPaths: [],
  mcp: {},
  skills: {},
  special: {},
};

/** Temp locations where redirection writes are allowed by default. */
const DEFAULT_WRITABLE_PREFIXES = ["/tmp/", "/private/tmp/", "/var/folders/"];

function normalizePolicy(value: unknown): PermissionDefaultPolicy {
  const record = toRecord(value);
  return {
    tools: isPermissionState(record.tools) ? record.tools : DEFAULT_POLICY.tools,
    bash: isPermissionState(record.bash) ? record.bash : DEFAULT_POLICY.bash,
    mcp: isPermissionState(record.mcp) ? record.mcp : DEFAULT_POLICY.mcp,
    skills: isPermissionState(record.skills) ? record.skills : DEFAULT_POLICY.skills,
    special: isPermissionState(record.special) ? record.special : DEFAULT_POLICY.special,
  };
}

function normalizePartialPolicy(value: unknown): Partial<PermissionDefaultPolicy> {
  const record = toRecord(value);
  const normalized: Partial<PermissionDefaultPolicy> = {};

  if (isPermissionState(record.tools)) {
    normalized.tools = record.tools;
  }

  if (isPermissionState(record.bash)) {
    normalized.bash = record.bash;
  }

  if (isPermissionState(record.mcp)) {
    normalized.mcp = record.mcp;
  }

  if (isPermissionState(record.skills)) {
    normalized.skills = record.skills;
  }

  if (isPermissionState(record.special)) {
    normalized.special = record.special;
  }

  return normalized;
}

function normalizePermissionRecord(value: unknown): Record<string, PermissionState> {
  const record = toRecord(value);
  const normalized: Record<string, PermissionState> = {};
  for (const [key, state] of Object.entries(record)) {
    if (isPermissionState(state)) {
      normalized[key] = state;
    }
  }
  return normalized;
}

function readConfiguredMcpServerNamesFromConfigPath(configPath: string): string[] {
  try {
    const raw = readFileSync(configPath, "utf-8");
    const parsed = parseJsoncConfig(raw, configPath, "permission config");
    const root = toRecord(parsed);
    const serverRecord = toRecord(root.mcpServers ?? root["mcp-servers"]);

    return Object.keys(serverRecord)
      .map((name) => name.trim())
      .filter((name) => name.length > 0);
  } catch {
    return [];
  }
}

function getConfiguredMcpServerNamesFromPaths(paths: readonly string[]): string[] {
  const seen = new Set<string>();

  for (const path of paths) {
    for (const name of readConfiguredMcpServerNamesFromConfigPath(path)) {
      seen.add(name);
    }
  }

  return [...seen].sort((left, right) => right.length - left.length || left.localeCompare(right));
}

/**
 * Rule lists accept arrays of prefix strings and, for the minimal YAML agent
 * frontmatter that cannot express arrays, a single comma-separated string
 * ("cargo test, bun test").
 */
function normalizeBashRuleList(value: unknown): string[][] {
  const entries = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : [];
  const rules: string[][] = [];
  for (const entry of entries) {
    if (typeof entry !== "string") {
      continue;
    }
    const prefix = parseBashRulePrefix(entry);
    if (prefix.length > 0) {
      rules.push(prefix);
    }
  }
  return rules;
}

function suggestBashRuleFromLegacyPattern(pattern: string): string | null {
  // "rg *" and "git diff *" style patterns translate directly to prefixes;
  // anything with mid-pattern wildcards or operators has no equivalent.
  const withoutTrailingWildcard = pattern.replace(/\s+\*$/, "").trim();
  if (!withoutTrailingWildcard || /[*?|;&<>$`]/.test(withoutTrailingWildcard)) {
    return null;
  }
  return withoutTrailingWildcard;
}

/**
 * Parse the `bash` config section: `{ allow, ask, deny, syntax,
 * registryOverrides }` with prefix-rule string lists. The pre-redesign
 * glob-map format (`"rg *": "allow"`) is detected and reported once with
 * suggested replacements, and is otherwise ignored.
 */
function normalizeBashSection(value: unknown, onWarning?: (message: string) => void): BashPermissionSection {
  const section = createEmptyBashSection();
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return section;
  }

  const record = value as Record<string, unknown>;
  const legacyEntries = Object.entries(record).filter(([, state]) => isPermissionState(state));
  if (legacyEntries.length > 0) {
    const suggestions: Record<string, string[]> = { allow: [], ask: [], deny: [] };
    for (const [pattern, state] of legacyEntries) {
      const suggested = suggestBashRuleFromLegacyPattern(pattern);
      if (suggested && isPermissionState(state)) {
        suggestions[state]?.push(`"${suggested}"`);
      }
    }
    const suggestionText = (["allow", "ask", "deny"] as const)
      .filter((state) => suggestions[state].length > 0)
      .map((state) => `"${state}": [${suggestions[state].join(", ")}]`)
      .join(", ");
    onWarning?.(
      `The bash permission config format changed: glob patterns like "rg *" are now prefix rule lists, `
      + `and read-only commands are allowed by default via the built-in safe-command registry. `
      + `Ignoring ${legacyEntries.length} legacy entr${legacyEntries.length === 1 ? "y" : "ies"}.`
      + (suggestionText ? ` Suggested replacement: "bash": { ${suggestionText} } (registry-covered commands can be omitted).` : ""),
    );
  }

  section.allow = normalizeBashRuleList(record.allow);
  section.ask = normalizeBashRuleList(record.ask);
  section.deny = normalizeBashRuleList(record.deny);

  const syntax = toRecord(record.syntax);
  if (isPermissionState(syntax.subshells)) {
    section.syntax.subshells = syntax.subshells;
  }
  if (isPermissionState(syntax.unanalyzable)) {
    section.syntax.unanalyzable = syntax.unanalyzable;
  }

  if (record.registryOverrides && typeof record.registryOverrides === "object" && !Array.isArray(record.registryOverrides)) {
    section.registryOverrides = record.registryOverrides as Record<string, unknown>;
  }

  return section;
}

function normalizeProtectedPaths(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function normalizeRawPermission(raw: unknown, onWarning?: (message: string) => void): AgentPermissions {
  const record = toRecord(raw);
  const normalizedTools = normalizePermissionRecord(record.tools);

  if (record.bashSafety && typeof record.bashSafety === "object") {
    onWarning?.(
      "The bashSafety config section was removed: syntax, substitutions, redirections, and risky "
      + "options are now evaluated per command piece. Use \"bash\": { \"syntax\": ... } and "
      + "registryOverrides instead; see the README.",
    );
  }

  const normalized: AgentPermissions = {
    defaultPolicy: normalizePartialPolicy(record.defaultPolicy),
    tools: normalizedTools,
    bash: normalizeBashSection(record.bash, onWarning),
    protectedPaths: normalizeProtectedPaths(record.protectedPaths),
    mcp: normalizePermissionRecord(record.mcp),
    skills: normalizePermissionRecord(record.skills),
    special: normalizePermissionRecord(record.special),
  };

  for (const [key, value] of Object.entries(record)) {
    if (!isPermissionState(value)) {
      continue;
    }

    if (BUILT_IN_TOOL_PERMISSION_NAMES.has(key)) {
      normalized.tools = { ...(normalized.tools || {}), [key]: value };
      continue;
    }

    if (SPECIAL_PERMISSION_KEYS.has(key)) {
      normalized.special = { ...(normalized.special || {}), [key]: value };
    }
  }

  return normalized;
}

function parseQualifiedMcpToolName(value: string): { server: string; tool: string } | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const colonIndex = trimmed.indexOf(":");
  if (colonIndex <= 0 || colonIndex >= trimmed.length - 1) {
    return null;
  }

  const server = trimmed.slice(0, colonIndex).trim();
  const tool = trimmed.slice(colonIndex + 1).trim();
  if (!server || !tool) {
    return null;
  }

  return { server, tool };
}

function addDerivedMcpServerTargets(
  toolName: string,
  configuredServerNames: readonly string[],
  pushTarget: (value: string | null) => void,
): void {
  const trimmedToolName = toolName.trim();
  if (!trimmedToolName) {
    return;
  }

  for (const serverName of configuredServerNames) {
    const trimmedServerName = serverName.trim();
    if (!trimmedServerName) {
      continue;
    }

    if (!trimmedToolName.endsWith(`_${trimmedServerName}`)) {
      continue;
    }

    if (trimmedToolName.startsWith(`${trimmedServerName}_`)) {
      continue;
    }

    pushTarget(`${trimmedServerName}_${trimmedToolName}`);
    pushTarget(`${trimmedServerName}:${trimmedToolName}`);
    pushTarget(trimmedServerName);
  }
}

function pushMcpToolPermissionTargets(
  rawReference: string,
  serverHint: string | null,
  configuredServerNames: readonly string[],
  pushTarget: (value: string | null) => void,
): void {
  const qualified = parseQualifiedMcpToolName(rawReference);
  const resolvedServer = serverHint ?? qualified?.server ?? null;
  const resolvedTool = qualified?.tool ?? rawReference;

  if (resolvedServer) {
    pushTarget(`${resolvedServer}_${resolvedTool}`);
    pushTarget(`${resolvedServer}:${resolvedTool}`);
    pushTarget(resolvedServer);
  } else {
    addDerivedMcpServerTargets(resolvedTool, configuredServerNames, pushTarget);
  }

  pushTarget(resolvedTool);
  pushTarget(rawReference);
}

function createMcpPermissionTargets(input: unknown, configuredServerNames: readonly string[] = []): string[] {
  const record = toRecord(input);
  const tool = getNonEmptyString(record.tool);
  const server = getNonEmptyString(record.server);
  const connect = getNonEmptyString(record.connect);
  const describe = getNonEmptyString(record.describe);
  const search = getNonEmptyString(record.search);

  const targets: string[] = [];
  const pushTarget = (value: string | null) => {
    if (!value) {
      return;
    }
    if (!targets.includes(value)) {
      targets.push(value);
    }
  };

  if (tool) {
    pushMcpToolPermissionTargets(tool, server, configuredServerNames, pushTarget);
    pushTarget("mcp_call");
    return targets;
  }

  if (connect) {
    pushTarget(`mcp_connect_${connect}`);
    pushTarget(connect);
    pushTarget("mcp_connect");
    return targets;
  }

  if (describe) {
    pushMcpToolPermissionTargets(describe, server, configuredServerNames, pushTarget);
    pushTarget("mcp_describe");
    return targets;
  }

  if (search) {
    if (server) {
      pushTarget(`mcp_server_${server}`);
      pushTarget(server);
    }

    pushTarget(search);
    pushTarget("mcp_search");
    return targets;
  }

  if (server) {
    pushTarget(`mcp_server_${server}`);
    pushTarget(server);
    pushTarget("mcp_list");
    return targets;
  }

  pushTarget("mcp_status");
  return targets;
}

type PermissionLayerName = "global" | "project" | "agent" | "projectAgent";

type PermissionLayer = {
  name: PermissionLayerName;
  permissions: GlobalPermissionConfig | AgentPermissions;
  trusted: boolean;
};

type LayeredPermissionState = {
  state: PermissionState;
  layer: PermissionLayerName;
  trusted: boolean;
};

type LayeredPermissionResolution = LayeredPermissionState;

type LayeredPermissionMatch = {
  state: PermissionState;
  matchedPattern: string;
  matchedName: string;
};

type PermissionRecordCategory = "tools" | "mcp" | "skills" | "special";
type PermissionDefaultCategory = keyof PermissionDefaultPolicy;
type CompiledPermissionPatterns = readonly CompiledWildcardPattern<LayeredPermissionState>[];

type ResolvedBashPolicy = {
  rules: BashRuleSets;
  registry: CompiledRegistry;
  protectedPaths: ProtectedPathMatcher;
  syntax: BashSyntaxPolicy;
};

type ResolvedPermissions = {
  globalConfig: GlobalPermissionConfig;
  agentConfig: AgentPermissions;
  merged: GlobalPermissionConfig;
  layers: readonly PermissionLayer[];
  compiledTools: CompiledPermissionPatterns;
  compiledSpecial: CompiledPermissionPatterns;
  compiledSkills: CompiledPermissionPatterns;
  compiledMcp: CompiledPermissionPatterns;
  bashPolicy: ResolvedBashPolicy;
};

function createPermissionLayers(
  globalConfig: GlobalPermissionConfig,
  projectConfig: AgentPermissions,
  agentConfig: AgentPermissions,
  projectAgentConfig: AgentPermissions,
): readonly PermissionLayer[] {
  return [
    { name: "global", permissions: globalConfig, trusted: true },
    { name: "project", permissions: projectConfig, trusted: false },
    { name: "agent", permissions: agentConfig, trusted: true },
    { name: "projectAgent", permissions: projectAgentConfig, trusted: false },
  ];
}

function compilePermissionPatternsFromLayers(
  category: PermissionRecordCategory,
  layers: readonly PermissionLayer[],
): CompiledPermissionPatterns {
  const entries: Array<readonly [string, LayeredPermissionState]> = [];

  for (const layer of layers) {
    const source = layer.permissions[category];
    if (!source) {
      continue;
    }

    for (const [pattern, state] of Object.entries(source)) {
      entries.push([pattern, { state, layer: layer.name, trusted: layer.trusted }]);
    }
  }

  if (entries.length === 0) {
    return [];
  }

  return compileWildcardPatternEntries(entries);
}

function toLayeredPermissionMatch(match: {
  state: LayeredPermissionState;
  matchedPattern: string;
  matchedName: string;
}): LayeredPermissionMatch {
  return {
    state: match.state.state,
    matchedPattern: match.matchedPattern,
    matchedName: match.matchedName,
  };
}

function toLayeredMatchFromPattern(
  pattern: { state: LayeredPermissionState; pattern: string },
  name: string,
): LayeredPermissionMatch {
  return {
    state: pattern.state.state,
    matchedPattern: pattern.pattern,
    matchedName: name,
  };
}

function findLatestTrustedPatternMatching(
  patterns: CompiledPermissionPatterns,
  isMatch: (pattern: CompiledWildcardPattern<LayeredPermissionState>) => string | null,
): LayeredPermissionMatch | null {
  for (let index = patterns.length - 1; index >= 0; index -= 1) {
    const pattern = patterns[index];
    if (!pattern.state.trusted) {
      continue;
    }
    const matchedName = isMatch(pattern);
    if (matchedName !== null) {
      return toLayeredMatchFromPattern(pattern, matchedName);
    }
  }

  return null;
}

function findLatestTrustedPermissionMatch(
  patterns: CompiledPermissionPatterns,
  name: string,
): LayeredPermissionMatch | null {
  return findLatestTrustedPatternMatching(patterns, (pattern) =>
    pattern.regex.test(name) ? name : null,
  );
}

const PERMISSION_RESTRICTION_ORDER: Record<PermissionState, number> = {
  allow: 0,
  ask: 1,
  deny: 2,
};

function permissionStateIsMoreRestrictive(candidate: PermissionState, baseline: PermissionState): boolean {
  return PERMISSION_RESTRICTION_ORDER[candidate] > PERMISSION_RESTRICTION_ORDER[baseline];
}

function findCompiledPermissionMatch(
  patterns: CompiledPermissionPatterns,
  name: string,
): LayeredPermissionMatch | null {
  if (patterns.length === 0) {
    return null;
  }

  const match = findCompiledWildcardMatch(patterns, name);
  if (!match) {
    return null;
  }

  if (match.state.state !== "deny" && !match.state.trusted) {
    const trustedFloor = findLatestTrustedPermissionMatch(patterns, name);
    if (trustedFloor?.state === "deny") {
      return trustedFloor;
    }
  }

  return toLayeredPermissionMatch(match);
}

function findCompiledPermissionMatchForNames(
  patterns: CompiledPermissionPatterns,
  names: readonly string[],
): LayeredPermissionMatch | null {
  return findFirstMatchForNames(names, (name) => findCompiledPermissionMatch(patterns, name));
}

function findLatestTrustedPermissionMatchForNames(
  patterns: CompiledPermissionPatterns,
  names: readonly string[],
): LayeredPermissionMatch | null {
  return findLatestTrustedPatternMatching(patterns, (pattern) => {
    for (const name of names) {
      if (pattern.regex.test(name.replaceAll("\\", "/"))) {
        return name;
      }
    }
    return null;
  });
}

function findCompiledPermissionMatchByPatternOrderForNames(
  patterns: CompiledPermissionPatterns,
  names: readonly string[],
): LayeredPermissionMatch | null {
  if (patterns.length === 0) {
    return null;
  }

  const normalizedNames = names.map((value) => value.trim()).filter((value) => value.length > 0);
  if (normalizedNames.length === 0) {
    return null;
  }

  for (let index = patterns.length - 1; index >= 0; index -= 1) {
    const pattern = patterns[index];
    for (const name of normalizedNames) {
      if (!pattern.regex.test(name.replaceAll("\\", "/"))) {
        continue;
      }

      if (pattern.state.state !== "deny" && !pattern.state.trusted) {
        const trustedFloor = findLatestTrustedPermissionMatchForNames(patterns, normalizedNames);
        if (trustedFloor?.state === "deny") {
          return trustedFloor;
        }
      }

      return toLayeredMatchFromPattern(pattern, name);
    }
  }

  return null;
}

function getPathResourceFromInput(input: unknown): string | null {
  const record = toRecord(input);
  const pathValue = getNonEmptyString(record.path) ?? getNonEmptyString(record.file_path);
  if (!pathValue) {
    return null;
  }

  const cwd = getNonEmptyString(record.cwd) ?? process.cwd();
  const resource = normalizePathResourceForPermission(pathValue, cwd);
  return resource || null;
}

function createActionResourceTargets(action: string, input: unknown): string[] {
  const resource = getPathResourceFromInput(input);
  return resource ? [`${action}:${resource}`] : [];
}

function resolveLayeredPermissionValue(
  layers: readonly PermissionLayer[],
  selectState: (layer: PermissionLayer) => PermissionState | undefined,
): LayeredPermissionResolution | null {
  let current: LayeredPermissionResolution | null = null;
  let trustedFloor: LayeredPermissionResolution | null = null;

  for (const layer of layers) {
    const state = selectState(layer);
    if (!state) {
      continue;
    }

    const candidate: LayeredPermissionResolution = {
      state,
      layer: layer.name,
      trusted: layer.trusted,
    };

    if (!candidate.trusted && candidate.state !== "deny" && trustedFloor?.state === "deny") {
      current = trustedFloor;
      continue;
    }

    current = candidate;
    if (candidate.trusted) {
      trustedFloor = candidate;
    }
  }

  return current;
}

function resolveLayeredRecordPermission(
  layers: readonly PermissionLayer[],
  category: PermissionRecordCategory,
  key: string,
): LayeredPermissionResolution | null {
  return resolveLayeredPermissionValue(layers, (layer) => layer.permissions[category]?.[key]);
}

function resolveLayeredDefaultPermission(
  layers: readonly PermissionLayer[],
  category: PermissionDefaultCategory,
): LayeredPermissionResolution | null {
  return resolveLayeredPermissionValue(layers, (layer) => layer.permissions.defaultPolicy?.[category]);
}

type FileCacheEntry<TValue> = {
  stamp: string;
  value: TValue;
};

function getFileStamp(path: string): string {
  try {
    return String(statSync(path).mtimeMs);
  } catch {
    return "missing";
  }
}

function resolveAgentMarkdownPath(dir: string | null, agentName?: string): string | null {
  if (!dir || !agentName) {
    return null;
  }

  const root = resolve(dir);
  const filePath = resolve(root, `${agentName}.md`);
  const relativePath = relative(root, filePath);
  if (relativePath.startsWith("..") || resolve(relativePath) === relativePath) {
    return null;
  }

  return filePath;
}

export class PermissionManager {
  private readonly globalConfigPath: string;
  private readonly agentsDir: string;
  private readonly projectGlobalConfigPath: string | null;
  private readonly projectAgentsDir: string | null;
  private readonly legacyGlobalSettingsPath: string;
  private readonly globalMcpConfigPath: string;
  private readonly configuredMcpServerNamesOverride: readonly string[] | null;
  private globalConfigCache: FileCacheEntry<GlobalPermissionConfig> | null = null;
  private projectGlobalConfigCache: FileCacheEntry<AgentPermissions> | null = null;
  private readonly agentConfigCache = new Map<string, FileCacheEntry<AgentPermissions>>();
  private readonly projectAgentConfigCache = new Map<string, FileCacheEntry<AgentPermissions>>();
  private readonly resolvedPermissionsCache = new Map<string, FileCacheEntry<ResolvedPermissions>>();
  private configuredMcpServerNamesCache: FileCacheEntry<readonly string[]> | null = null;
  private readonly onWarning: ((message: string) => void) | null;

  constructor(
    options: {
      globalConfigPath?: string;
      agentsDir?: string;
      projectGlobalConfigPath?: string;
      projectAgentsDir?: string;
      legacyGlobalSettingsPath?: string;
      globalMcpConfigPath?: string;
      mcpServerNames?: readonly string[];
      onWarning?: (message: string) => void;
    } = {},
  ) {
    this.globalConfigPath = options.globalConfigPath || defaultGlobalConfigPath();
    this.agentsDir = options.agentsDir || defaultAgentsDir();
    this.projectGlobalConfigPath = options.projectGlobalConfigPath || null;
    this.projectAgentsDir = options.projectAgentsDir || null;
    this.legacyGlobalSettingsPath = options.legacyGlobalSettingsPath || defaultLegacyGlobalSettingsPath();
    this.globalMcpConfigPath = options.globalMcpConfigPath || defaultGlobalMcpConfigPath();
    this.configuredMcpServerNamesOverride = options.mcpServerNames
      ? [...new Set(options.mcpServerNames.map((name) => name.trim()).filter((name) => name.length > 0))]
      : null;
    this.onWarning = options.onWarning || null;
  }

  private notifyWarning(message: string): void {
    this.onWarning?.(message);
  }

  private loadGlobalConfig(): GlobalPermissionConfig {
    const stamp = getFileStamp(this.globalConfigPath);
    if (this.globalConfigCache?.stamp === stamp) {
      return this.globalConfigCache.value;
    }

    let value: GlobalPermissionConfig;
    try {
      const raw = readFileSync(this.globalConfigPath, "utf-8");
      const parsed = parseJsoncConfig(raw, this.globalConfigPath, "permission config");
      const normalized = normalizeRawPermission(parsed, (message) => this.notifyWarning(message));

      value = {
        defaultPolicy: normalizePolicy(normalized.defaultPolicy),
        tools: normalized.tools || {},
        bash: normalized.bash || createEmptyBashSection(),
        protectedPaths: normalized.protectedPaths || [],
        mcp: normalized.mcp || {},
        skills: normalized.skills || {},
        special: normalized.special || {},
      };
    } catch (error) {
      const warning = formatJsoncConfigLoadWarning(
        this.globalConfigPath,
        error,
        "permission config",
        "using ask fallback",
      );
      if (warning) {
        this.notifyWarning(warning);
      }
      value = EMPTY_GLOBAL_CONFIG;
    }

    this.globalConfigCache = { stamp, value };
    return value;
  }

  private loadProjectGlobalConfig(): AgentPermissions {
    if (!this.projectGlobalConfigPath) {
      return {};
    }

    const stamp = getFileStamp(this.projectGlobalConfigPath);
    if (this.projectGlobalConfigCache?.stamp === stamp) {
      return this.projectGlobalConfigCache.value;
    }

    let value: AgentPermissions;
    try {
      const raw = readFileSync(this.projectGlobalConfigPath, "utf-8");
      const parsed = parseJsoncConfig(raw, this.projectGlobalConfigPath, "permission config");
      value = normalizeRawPermission(parsed, (message) => this.notifyWarning(message));
    } catch (error) {
      const warning = formatJsoncConfigLoadWarning(
        this.projectGlobalConfigPath,
        error,
        "permission config",
        "ignoring project permission overrides",
      );
      if (warning) {
        this.notifyWarning(warning);
      }
      value = {};
    }

    this.projectGlobalConfigCache = { stamp, value };
    return value;
  }

  private loadAgentPermissionsFrom(
    dir: string | null,
    cache: Map<string, FileCacheEntry<AgentPermissions>>,
    agentName?: string,
  ): AgentPermissions {
    const filePath = resolveAgentMarkdownPath(dir, agentName);
    if (!filePath || !agentName) {
      return {};
    }

    const stamp = getFileStamp(filePath);
    const cached = cache.get(agentName);
    if (cached?.stamp === stamp) {
      return cached.value;
    }

    let value: AgentPermissions;
    try {
      const markdown = readFileSync(filePath, "utf-8");
      const frontmatter = extractFrontmatter(markdown);
      if (!frontmatter) {
        value = {};
      } else {
        const parsed = parseSimpleYamlMap(frontmatter);
        value = normalizeRawPermission(parsed.permission, (message) => this.notifyWarning(message));
      }
    } catch {
      value = {};
    }

    cache.set(agentName, { stamp, value });
    return value;
  }

  private loadAgentPermissions(agentName?: string): AgentPermissions {
    return this.loadAgentPermissionsFrom(this.agentsDir, this.agentConfigCache, agentName);
  }

  private loadProjectAgentPermissions(agentName?: string): AgentPermissions {
    return this.loadAgentPermissionsFrom(this.projectAgentsDir, this.projectAgentConfigCache, agentName);
  }

  private mergePermissions(globalConfig: GlobalPermissionConfig, agentConfig: AgentPermissions): GlobalPermissionConfig {
    return {
      defaultPolicy: {
        ...globalConfig.defaultPolicy,
        ...(agentConfig.defaultPolicy || {}),
      },
      tools: {
        ...(globalConfig.tools || {}),
        ...(agentConfig.tools || {}),
      },
      bash: {
        allow: [...(globalConfig.bash?.allow || []), ...(agentConfig.bash?.allow || [])],
        ask: [...(globalConfig.bash?.ask || []), ...(agentConfig.bash?.ask || [])],
        deny: [...(globalConfig.bash?.deny || []), ...(agentConfig.bash?.deny || [])],
        syntax: {
          ...(globalConfig.bash?.syntax || {}),
          ...(agentConfig.bash?.syntax || {}),
        },
        registryOverrides: {
          ...(globalConfig.bash?.registryOverrides || {}),
          ...(agentConfig.bash?.registryOverrides || {}),
        },
      },
      protectedPaths: [...(globalConfig.protectedPaths || []), ...(agentConfig.protectedPaths || [])],
      mcp: {
        ...(globalConfig.mcp || {}),
        ...(agentConfig.mcp || {}),
      },
      skills: {
        ...(globalConfig.skills || {}),
        ...(agentConfig.skills || {}),
      },
      special: {
        ...(globalConfig.special || {}),
        ...(agentConfig.special || {}),
      },
    };
  }

  getPolicyCacheStamp(agentName?: string): string {
    const agentPath = resolveAgentMarkdownPath(this.agentsDir, agentName);
    const projectAgentPath = resolveAgentMarkdownPath(this.projectAgentsDir, agentName);
    const agentStamp = agentPath ? getFileStamp(agentPath) : "missing";
    const projectStamp = this.projectGlobalConfigPath ? getFileStamp(this.projectGlobalConfigPath) : "none";
    const projectAgentStamp = projectAgentPath ? getFileStamp(projectAgentPath) : "none";

    return `${getFileStamp(this.globalConfigPath)}|${projectStamp}|${agentStamp}|${projectAgentStamp}`;
  }

  private resolvePermissions(agentName?: string): ResolvedPermissions {
    const cacheKey = agentName || "__global__";
    const stamp = this.getPolicyCacheStamp(agentName);
    const cached = this.resolvedPermissionsCache.get(cacheKey);
    if (cached?.stamp === stamp) {
      return cached.value;
    }

    const globalConfig = this.loadGlobalConfig();
    const projectConfig = this.loadProjectGlobalConfig();
    const agentConfig = this.loadAgentPermissions(agentName);
    const projectAgentConfig = this.loadProjectAgentPermissions(agentName);

    const mergedWithProject = this.mergePermissions(globalConfig, projectConfig);
    const mergedWithAgent = this.mergePermissions(mergedWithProject, agentConfig);
    const merged = this.mergePermissions(mergedWithAgent, projectAgentConfig);
    const layers = createPermissionLayers(globalConfig, projectConfig, agentConfig, projectAgentConfig);

    const registry = compileRegistry(merged.bash?.registryOverrides || {});
    for (const warning of registry.warnings) {
      this.notifyWarning(warning);
    }

    const value: ResolvedPermissions = {
      globalConfig,
      agentConfig,
      merged,
      layers,
      compiledTools: compilePermissionPatternsFromLayers("tools", layers),
      compiledSpecial: compilePermissionPatternsFromLayers("special", layers),
      compiledSkills: compilePermissionPatternsFromLayers("skills", layers),
      compiledMcp: compilePermissionPatternsFromLayers("mcp", layers),
      bashPolicy: {
        rules: {
          allow: merged.bash?.allow || [],
          ask: merged.bash?.ask || [],
          deny: merged.bash?.deny || [],
        },
        registry,
        protectedPaths: createProtectedPathMatcher(merged.protectedPaths || []),
        syntax: {
          subshells: merged.bash?.syntax.subshells ?? DEFAULT_BASH_SYNTAX_POLICY.subshells,
          unanalyzable: merged.bash?.syntax.unanalyzable ?? DEFAULT_BASH_SYNTAX_POLICY.unanalyzable,
        },
      },
    };

    this.resolvedPermissionsCache.set(cacheKey, { stamp, value });
    return value;
  }

  getBashPermissions(agentName?: string): BashPermissionSection {
    const { merged } = this.resolvePermissions(agentName);
    return merged.bash || createEmptyBashSection();
  }

  /**
   * Check whether the resolved permission config has any explicitly allowed skills.
   * Used to decide if path-bearing tools like `read` should remain exposed to an agent
   * even when the tool-level permission is `deny`, so the agent can read skill files.
   *
   * Returns true when any of these conditions holds:
   * - The default skills policy is not "deny" (allows all skills by default)
   * - At least one individual skill entry has state "allow"
   */
  hasAllowedSkills(agentName?: string): boolean {
    const { merged } = this.resolvePermissions(agentName);
    const defaultPolicy = merged.defaultPolicy.skills;
    if (defaultPolicy !== "deny") {
      return true;
    }
    const skillsRecord = merged.skills || {};
    return Object.values(skillsRecord).some((state) => state === "allow");
  }

  private getConfiguredMcpServerNames(): readonly string[] {
    if (this.configuredMcpServerNamesOverride) {
      return this.configuredMcpServerNamesOverride;
    }

    const paths = [this.globalMcpConfigPath, this.legacyGlobalSettingsPath];
    const stamp = paths.map((path) => `${path}:${getFileStamp(path)}`).join("|");
    if (this.configuredMcpServerNamesCache?.stamp === stamp) {
      return this.configuredMcpServerNamesCache.value;
    }

    const value = getConfiguredMcpServerNamesFromPaths(paths);
    this.configuredMcpServerNamesCache = { stamp, value };
    return value;
  }

  /**
   * Get the tool-level permission state for a tool, without considering command-level rules.
   * This is used for tool injection decisions where we need to know if a tool is allowed/denied
   * at the tool level before checking specific command permissions.
   *
   * Exact-name entries in `tools` work for arbitrary registered extension tools.
   * Canonical Pi tools with dedicated categories still use their specialized fallbacks.
   *
   * @param toolName - The name of the tool (for example "bash", "read", or a third-party tool name)
   * @param agentName - Optional agent name to check agent-specific permissions
   * @returns The permission state for the tool at the tool level
   */
  getToolPermission(toolName: string, agentName?: string): PermissionState {
    const { layers, compiledTools } = this.resolvePermissions(agentName);
    const normalizedToolName = toolName.trim();

    if (SPECIAL_PERMISSION_KEYS.has(normalizedToolName)) {
      return resolveLayeredDefaultPermission(layers, "special")?.state ?? DEFAULT_POLICY.special;
    }

    if (normalizedToolName === "skill") {
      return resolveLayeredDefaultPermission(layers, "skills")?.state ?? DEFAULT_POLICY.skills;
    }

    const toolMatch = findCompiledPermissionMatch(compiledTools, normalizedToolName);

    if (normalizedToolName === "bash") {
      return toolMatch?.state
        ?? resolveLayeredDefaultPermission(layers, "bash")?.state
        ?? DEFAULT_POLICY.bash;
    }

    if (normalizedToolName === "mcp") {
      return toolMatch?.state
        ?? resolveLayeredDefaultPermission(layers, "mcp")?.state
        ?? DEFAULT_POLICY.mcp;
    }

    return toolMatch?.state
      ?? resolveLayeredDefaultPermission(layers, "tools")?.state
      ?? DEFAULT_POLICY.tools;
  }

  /**
   * Evaluate a bash command piece by piece (see bash-evaluator.ts).
   * `sessionAllowPrefixes` are session-approved allow prefixes; callers with
   * a session approval store use checkBashCommand to include them.
   */
  private evaluateBash(
    command: string,
    cwd: string,
    toolName: string,
    agentName: string | undefined,
    sessionAllowPrefixes: readonly string[][],
  ): PermissionCheckResult {
    const { layers, compiledTools, bashPolicy } = this.resolvePermissions(agentName);
    const toolMatch = findCompiledPermissionMatch(compiledTools, "bash");
    const defaultState = toolMatch?.state
      ?? resolveLayeredDefaultPermission(layers, "bash")?.state
      ?? DEFAULT_POLICY.bash;

    const context: BashEvaluationContext = {
      rules: bashPolicy.rules,
      sessionAllowPrefixes,
      registry: bashPolicy.registry,
      protectedPaths: bashPolicy.protectedPaths,
      syntax: bashPolicy.syntax,
      defaultState,
      resolveWriteState: (target) => this.resolveBashWriteState(target, cwd, compiledTools, layers),
    };

    const evaluation = evaluateBashCommand(command, context);
    return {
      toolName,
      state: evaluation.state,
      command,
      source: "bash",
      bashEvaluation: evaluation,
    };
  }

  /**
   * Permission for a file written via bash redirection. Precedence:
   * explicit `write:<path>` tool rules, then the default temp-dir allowance,
   * then the bare `write` tool state, then ask.
   */
  private resolveBashWriteState(
    target: string,
    cwd: string,
    compiledTools: CompiledPermissionPatterns,
    layers: readonly PermissionLayer[],
  ): PermissionState {
    const resource = normalizePathResourceForPermission(target, cwd) || target;

    const pathRule = findCompiledPermissionMatchByPatternOrderForNames(compiledTools, [`write:${resource}`]);
    if (pathRule) {
      return pathRule.state;
    }

    const tmpDir = process.env.TMPDIR?.trim();
    const writablePrefixes = tmpDir
      ? [...DEFAULT_WRITABLE_PREFIXES, tmpDir.endsWith("/") ? tmpDir : `${tmpDir}/`]
      : DEFAULT_WRITABLE_PREFIXES;
    if (writablePrefixes.some((prefix) => resource.startsWith(prefix))) {
      return "allow";
    }

    const writeToolRule = findCompiledPermissionMatch(compiledTools, "write");
    return writeToolRule?.state
      ?? resolveLayeredDefaultPermission(layers, "tools")?.state
      ?? "ask";
  }

  /**
   * Public bash entry point for callers holding session approvals (the
   * extension's permission flow): re-evaluates with session allow prefixes
   * included so approved families silence matching pieces of compounds too.
   */
  checkBashCommand(
    command: string,
    options: { agentName?: string; cwd?: string; sessionAllowPrefixes?: readonly string[][] } = {},
  ): PermissionCheckResult {
    return this.evaluateBash(
      command,
      options.cwd ?? process.cwd(),
      "bash",
      options.agentName,
      options.sessionAllowPrefixes ?? [],
    );
  }

  checkPermission(toolName: string, input: unknown, agentName?: string): PermissionCheckResult {
    const { merged, layers, compiledTools, compiledSpecial, compiledSkills, compiledMcp } = this.resolvePermissions(agentName);
    const normalizedToolName = toolName.trim();
    const toolMatch = findCompiledPermissionMatch(compiledTools, normalizedToolName);

    if (SPECIAL_PERMISSION_KEYS.has(normalizedToolName)) {
      const targets = [...createActionResourceTargets(normalizedToolName, input), normalizedToolName];
      const result = findCompiledPermissionMatchByPatternOrderForNames(compiledSpecial, targets);
      return {
        toolName,
        state: result?.state ?? resolveLayeredDefaultPermission(layers, "special")?.state ?? DEFAULT_POLICY.special,
        matchedPattern: result?.matchedPattern,
        target: result?.matchedName,
        source: "special",
      };
    }

    if (normalizedToolName === "skill") {
      const skillName = toRecord(input).name;
      if (typeof skillName === "string") {
        const result = findCompiledPermissionMatch(compiledSkills, skillName);
        return {
          toolName,
          state: result?.state ?? resolveLayeredDefaultPermission(layers, "skills")?.state ?? DEFAULT_POLICY.skills,
          matchedPattern: result?.matchedPattern,
          source: "skill",
        };
      }

      return {
        toolName,
        state: resolveLayeredDefaultPermission(layers, "skills")?.state ?? DEFAULT_POLICY.skills,
        source: "skill",
      };
    }

    if (normalizedToolName === "bash") {
      const record = toRecord(input);
      const command = typeof record.command === "string" ? record.command : "";
      const cwd = getNonEmptyString(record.cwd) ?? process.cwd();
      return this.evaluateBash(command, cwd, toolName, agentName, []);
    }

    if (normalizedToolName === "mcp") {
      const mcpTargets = [...createMcpPermissionTargets(input, this.getConfiguredMcpServerNames()), "mcp"];
      const fallbackTarget = mcpTargets[0] || "mcp";
      const defaultMcpState = resolveLayeredDefaultPermission(layers, "mcp")?.state ?? DEFAULT_POLICY.mcp;

      const mcpMatch = findCompiledPermissionMatchForNames(compiledMcp, mcpTargets);
      if (mcpMatch) {
        return {
          toolName,
          state: mcpMatch.state,
          matchedPattern: mcpMatch.matchedPattern,
          target: mcpMatch.matchedName,
          source: "mcp",
        };
      }

      if (toolMatch) {
        return {
          toolName,
          state: toolMatch.state,
          matchedPattern: toolMatch.matchedPattern,
          target: fallbackTarget,
          source: "tool",
        };
      }

      const baselineTarget = mcpTargets.find((target) => MCP_BASELINE_TARGETS.has(target));
      if (baselineTarget) {
        const hasAnyMcpAllowRule = Object.values(merged.mcp || {}).some((state) => state === "allow");
        if (hasAnyMcpAllowRule || defaultMcpState === "allow") {
          return {
            toolName,
            state: "allow",
            target: baselineTarget,
            source: "mcp",
          };
        }
      }

      return {
        toolName,
        state: defaultMcpState,
        target: fallbackTarget,
        source: "default",
      };
    }

    if (BUILT_IN_TOOL_PERMISSION_NAMES.has(normalizedToolName)) {
      const result = findCompiledPermissionMatchByPatternOrderForNames(
        compiledTools,
        [...createActionResourceTargets(normalizedToolName, input), normalizedToolName],
      );
      return {
        toolName,
        state: result?.state
          ?? resolveLayeredDefaultPermission(layers, "tools")?.state
          ?? DEFAULT_POLICY.tools,
        matchedPattern: result?.matchedPattern,
        target: result?.matchedName,
        source: "tool",
      };
    }

    if (toolMatch) {
      return {
        toolName,
        state: toolMatch.state,
        matchedPattern: toolMatch.matchedPattern,
        source: "tool",
      };
    }

    return {
      toolName,
      state: resolveLayeredDefaultPermission(layers, "tools")?.state ?? DEFAULT_POLICY.tools,
      source: "default",
    };
  }
}
