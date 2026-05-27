import { getAgentDir, isToolCallEventType, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, renameSync, rmdirSync, unlinkSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, dirname, join, normalize, relative } from "node:path";

import { getNonEmptyString, isPathWithinDirectory, normalizePathForComparison, toRecord } from "./common.js";
import {
  createActiveToolsCacheKey,
  createBeforeAgentStartPromptStateKey,
  shouldApplyCachedAgentStartState,
} from "./before-agent-start-cache.js";
import {
  isPermissionDecisionState,
  requestPermissionDecisionFromUi,
  type PermissionPromptDecision,
} from "./permission-dialog.js";
import {
  DEFAULT_EXTENSION_CONFIG,
  getPermissionSystemConfigPath,
  loadPermissionSystemConfig,
  normalizePermissionSystemConfig,
  savePermissionSystemConfig,
  type PermissionSystemExtensionConfig,
} from "./extension-config.js";
import { createPermissionSystemLogger, safeJsonStringify } from "./logging.js";
import { registerPermissionSystemCommand } from "./config-modal.js";
import {
  createPermissionForwardingLocation,
  isForwardedPermissionRequestForSession,
  PERMISSION_FORWARDING_POLL_INTERVAL_MS,
  PERMISSION_FORWARDING_WATCH_DEBOUNCE_MS,
  PERMISSION_FORWARDING_TIMEOUT_MS,
  resolvePermissionForwardingRootDir,
  resolvePermissionForwardingTargetSessionId,
  SUBAGENT_ENV_HINT_KEYS,
  type ForwardedPermissionRequest,
  type ForwardedPermissionResponse,
  type PermissionForwardingLocation,
} from "./permission-forwarding.js";
import { PermissionManager } from "./permission-manager.js";
import {
  findSkillPathMatch,
  resolveSkillPromptEntries,
  type SkillPromptEntry,
} from "./skill-prompt-sanitizer.js";
import { sanitizeAvailableToolsSection } from "./system-prompt-sanitizer.js";
import { checkRequestedToolRegistration, getToolNameFromValue } from "./tool-registry.js";
import type { PermissionCheckResult } from "./types.js";
import { PERMISSION_SYSTEM_STATUS_KEY, syncPermissionSystemStatus } from "./status.js";
import { canResolveAskPermissionRequest, shouldAutoApprovePermissionState } from "./yolo-mode.js";
import {
  registerPiPermissionSystemRuntimeApi,
  unregisterPiPermissionSystemRuntimeApi,
  type PiPermissionSystemRuntimeApi,
  type YoloModeControlOptions,
  type YoloModeControlResult,
} from "./yolo-mode-api.js";
import { registerModelOptionCompatibilityGuard } from "./model-option-compatibility.js";

const PI_AGENT_DIR = getAgentDir();
const SUBAGENT_SESSIONS_DIR = join(PI_AGENT_DIR, "subagent-sessions");
let cachedSubagentEnvHint: { signature: string; value: boolean } | undefined;

function hasSubagentEnvHint(): boolean {
  const values = SUBAGENT_ENV_HINT_KEYS.map((key) => process.env[key]?.trim() ?? "");
  const signature = values.join("\u0000");
  if (cachedSubagentEnvHint?.signature === signature) {
    return cachedSubagentEnvHint.value;
  }

  const value = values.some((entry) => entry.length > 0);
  cachedSubagentEnvHint = { signature, value };
  return value;
}

const ACTIVE_AGENT_TAG_REGEX = /<active_agent\s+name=["']([^"']+)["'][^>]*>/i;

type PermissionRequestSource = "tool_call" | "skill_input" | "skill_read";
type PermissionRequestState = "waiting" | "approved" | "denied";

type PermissionRequestEvent = {
  requestId: string;
  source: PermissionRequestSource;
  state: PermissionRequestState;
  message: string;
  toolCallId?: string;
  toolName?: string;
  skillName?: string;
  path?: string;
  command?: string;
  target?: string;
  toolInputPreview?: string;
  agentName?: string | null;
};

type SensitiveLogMetadata = {
  present: boolean;
  length: number;
  sha256: string;
};

const PERMISSION_REQUEST_EVENT_CHANNEL = "pi-permission-system:permission-request";
const PATH_BEARING_TOOLS = new Set(["read", "write", "edit", "find", "grep", "ls"]);
const STRUCTURED_EDIT_OPERATION_NAMES = new Set(["replace", "append", "prepend", "replace_text", "delete"]);
const FILESYSTEM_TOOL_NAME_SUFFIXES = ["read", "write", "edit", "find", "grep", "search", "list", "ls"] as const;
const SKILLS_DIR_PARTS = [".pi", "agent", "skills"] as const;

let extensionConfig: PermissionSystemExtensionConfig = { ...DEFAULT_EXTENSION_CONFIG };
let runtimeApi: PiPermissionSystemRuntimeApi | null = null;
const extensionLogger = createPermissionSystemLogger({
  getConfig: () => extensionConfig,
});
const reportedLoggingWarnings = new Set<string>();
let loggingWarningReporter: ((message: string) => void) | null = null;

function setExtensionConfig(config: PermissionSystemExtensionConfig): void {
  extensionConfig = normalizePermissionSystemConfig(config);
}

function setLoggingWarningReporter(reporter: ((message: string) => void) | null): void {
  loggingWarningReporter = reporter;
}

function reportLoggingWarning(message: string): void {
  if (!loggingWarningReporter || reportedLoggingWarnings.has(message)) {
    return;
  }

  reportedLoggingWarnings.add(message);
  loggingWarningReporter(message);
}

function writeDebugLog(event: string, details: Record<string, unknown> = {}): void {
  const warning = extensionLogger.debug(event, details);
  if (warning) {
    reportLoggingWarning(warning);
  }
}

function writeReviewLog(event: string, details: Record<string, unknown> = {}): void {
  const warning = extensionLogger.review(event, details);
  if (warning) {
    reportLoggingWarning(warning);
  }
}

function getStructuredEditPayloads(inputRecord: Record<string, unknown>): unknown[] {
  if (Array.isArray(inputRecord.edits)) {
    return inputRecord.edits;
  }

  if (typeof inputRecord.oldText === "string" && typeof inputRecord.newText === "string") {
    return [{ op: "replace_text", oldText: inputRecord.oldText, newText: inputRecord.newText }];
  }

  return [];
}

function hasStructuredEditPayload(inputRecord: Record<string, unknown>): boolean {
  return getStructuredEditPayloads(inputRecord).some((edit) => {
    const editRecord = toRecord(edit);
    const op = typeof editRecord.op === "string" ? editRecord.op : "replace_text";
    return STRUCTURED_EDIT_OPERATION_NAMES.has(op)
      || (typeof editRecord.oldText === "string" && typeof editRecord.newText === "string");
  });
}

function isLikelyFilesystemToolName(toolName: string): boolean {
  const normalized = toolName.trim().toLowerCase();
  if (!normalized) {
    return false;
  }

  const nameParts = normalized.split(/[^a-z0-9]+/).filter(Boolean);
  return FILESYSTEM_TOOL_NAME_SUFFIXES.some((suffix) =>
    normalized.endsWith(suffix) || nameParts.includes(suffix),
  );
}

function getPathBearingToolPath(toolName: string, input: unknown): string | null {
  const inputRecord = toRecord(input);
  const path = getNonEmptyString(inputRecord.path) ?? getNonEmptyString(inputRecord.file_path);
  if (!path) {
    return null;
  }

  if (PATH_BEARING_TOOLS.has(toolName)) {
    return path;
  }

  if (hasStructuredEditPayload(inputRecord) || isLikelyFilesystemToolName(toolName)) {
    return path;
  }

  return null;
}

function isPathOutsideWorkingDirectory(pathValue: string, cwd: string): boolean {
  const normalizedCwd = normalizePathForComparison(cwd, cwd);
  const normalizedPath = normalizePathForComparison(pathValue, cwd);
  return Boolean(normalizedCwd && normalizedPath && !isPathWithinDirectory(normalizedPath, normalizedCwd));
}


function extractSkillNameFromInput(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/skill:")) {
    return null;
  }

  const afterPrefix = trimmed.slice("/skill:".length);
  if (!afterPrefix) {
    return null;
  }

  const firstWhitespace = afterPrefix.search(/\s/);
  const skillName = (firstWhitespace === -1 ? afterPrefix : afterPrefix.slice(0, firstWhitespace)).trim();
  return skillName || null;
}

function getEventToolName(event: unknown): string | null {
  return getToolNameFromValue(event);
}

function getEventInput(event: unknown): unknown {
  const record = toRecord(event);

  if (record.input !== undefined) {
    return record.input;
  }

  if (record.arguments !== undefined) {
    return record.arguments;
  }

  return {};
}

function normalizeAgentName(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function getActiveAgentName(ctx: ExtensionContext): string | null {
  const entries = ctx.sessionManager.getEntries();
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i] as { type: string; customType?: string; data?: unknown };
    if (entry.type !== "custom" || entry.customType !== "active_agent") {
      continue;
    }

    const data = entry.data as { name?: unknown } | undefined;
    const normalizedName = normalizeAgentName(data?.name);
    if (normalizedName) {
      return normalizedName;
    }

    if (data?.name === null) {
      return null;
    }
  }

  return null;
}

function getActiveAgentNameFromSystemPrompt(systemPrompt: string | undefined): string | null {
  if (!systemPrompt) {
    return null;
  }

  const match = systemPrompt.match(ACTIVE_AGENT_TAG_REGEX);
  if (!match || !match[1]) {
    return null;
  }

  return normalizeAgentName(match[1]);
}

function getContextSystemPrompt(ctx: ExtensionContext): string | undefined {
  const getSystemPrompt = toRecord(ctx).getSystemPrompt;
  if (typeof getSystemPrompt !== "function") {
    return undefined;
  }

  try {
    const systemPrompt = getSystemPrompt.call(ctx);
    return typeof systemPrompt === "string" ? systemPrompt : undefined;
  } catch (error) {
    logPermissionForwardingWarning("Failed to read context system prompt for forwarded permission metadata", error);
    return undefined;
  }
}

function formatMissingToolNameReason(): string {
  return "Tool call was blocked because no tool name was provided. Use a registered tool name from pi.getAllTools().";
}

function formatUnknownToolReason(toolName: string, availableToolNames: readonly string[]): string {
  const preview = availableToolNames.slice(0, 10);
  const suffix = availableToolNames.length > preview.length ? ", ..." : "";
  const availableList = preview.length > 0 ? `${preview.join(", ")}${suffix}` : "none";

  const mcpHint = toolName === "mcp"
    ? ""
    : " If this was intended as an MCP server tool, call the registered 'mcp' tool when available (for example: {\"tool\":\"server:tool\"}).";

  return `Tool '${toolName}' is not registered in this runtime and was blocked before permission checks.${mcpHint} Registered tools: ${availableList}.`;
}

function formatPermissionHardStopHint(result: PermissionCheckResult): string {
  if ((result.source === "mcp" || result.toolName === "mcp") && result.target) {
    return "Hard stop: this MCP permission denial is policy-enforced. Do not retry this target, do not run discovery/investigation to bypass it, and report the block to the user.";
  }

  return "Hard stop: this permission denial is policy-enforced. Do not retry or investigate bypasses; report the block to the user.";
}

function formatDenyReason(result: PermissionCheckResult, agentName?: string): string {
  const parts: string[] = [];

  if (agentName) {
    parts.push(`Agent '${agentName}'`);
  }

  if ((result.source === "mcp" || result.toolName === "mcp") && result.target) {
    parts.push(`is not permitted to run MCP target '${result.target}'`);
  } else {
    parts.push(`is not permitted to run '${result.toolName}'`);
  }

  if (result.command) {
    parts.push(`command '${result.command}'`);
  }

  if (result.matchedPattern) {
    parts.push(`(matched '${result.matchedPattern}')`);
  }

  return `${parts.join(" ")}. ${formatPermissionHardStopHint(result)}`;
}

function formatUserDeniedReason(result: PermissionCheckResult, denialReason?: string): string {
  const base = (result.source === "mcp" || result.toolName === "mcp") && result.target
    ? `User denied MCP target '${result.target}'.`
    : result.toolName === "bash" && result.command
      ? `User denied bash command '${result.command}'.`
      : `User denied tool '${result.toolName}'.`;
  const reasonSuffix = denialReason ? ` Reason: ${denialReason}.` : "";

  return `${base}${reasonSuffix} ${formatPermissionHardStopHint(result)}`;
}

const TOOL_INPUT_PREVIEW_MAX_LENGTH = 200;
const TOOL_INPUT_LOG_PREVIEW_MAX_LENGTH = 1000;
const TOOL_TEXT_SUMMARY_MAX_LENGTH = 80;

function truncateInlineText(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}…` : value;
}

function sanitizeInlineText(value: string, maxLength = TOOL_TEXT_SUMMARY_MAX_LENGTH): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized ? truncateInlineText(normalized, maxLength) : "empty text";
}

function countTextLines(value: string): number {
  if (!value) {
    return 0;
  }

  return value.split(/\r\n|\r|\n/).length;
}

function formatCount(value: number, singular: string, plural: string): string {
  return `${value} ${value === 1 ? singular : plural}`;
}

function getPromptPath(input: Record<string, unknown>): string | null {
  return getNonEmptyString(input.path) ?? getNonEmptyString(input.file_path);
}

function countEditPayloadLines(value: unknown): number {
  if (Array.isArray(value)) {
    return value.filter((line) => typeof line === "string").length;
  }
  if (typeof value === "string") {
    return countTextLines(value.endsWith("\n") ? value.slice(0, -1) : value);
  }
  return 0;
}

function formatEditReference(value: unknown): string {
  return typeof value === "string" && value.trim()
    ? sanitizeInlineText(value, 40)
    : "anchor";
}

function formatStructuredEditSummary(edit: Record<string, unknown>, index: number): string | null {
  const ordinal = `edit #${index + 1}`;
  const op = typeof edit.op === "string" ? edit.op : "replace_text";

  if (typeof edit.oldText === "string" && typeof edit.newText === "string" && op === "replace_text") {
    return `${ordinal} replaces ${formatCount(countTextLines(edit.oldText), "line", "lines")} with ${formatCount(countTextLines(edit.newText), "line", "lines")}`;
  }

  const lineCount = formatCount(countEditPayloadLines(edit.lines), "line", "lines");
  switch (op) {
    case "replace": {
      const start = formatEditReference(edit.pos);
      const end = typeof edit.end === "string" && edit.end.trim()
        ? ` through ${formatEditReference(edit.end)}`
        : "";
      return `${ordinal} replaces ${lineCount} at ${start}${end}`;
    }
    case "append":
      return `${ordinal} appends ${lineCount}${typeof edit.pos === "string" ? ` after ${formatEditReference(edit.pos)}` : " at EOF"}`;
    case "prepend":
      return `${ordinal} prepends ${lineCount}${typeof edit.pos === "string" ? ` before ${formatEditReference(edit.pos)}` : " at BOF"}`;
    case "delete": {
      const start = formatEditReference(edit.pos);
      const end = typeof edit.end === "string" && edit.end.trim()
        ? ` through ${formatEditReference(edit.end)}`
        : "";
      return `${ordinal} deletes at ${start}${end}`;
    }
    default:
      return null;
  }
}

function formatStructuredEditInputForPrompt(input: Record<string, unknown>, fallback?: string): string | null {
  const path = getPromptPath(input);
  const editSummaries = getStructuredEditPayloads(input)
    .map((edit, index) => formatStructuredEditSummary(toRecord(edit), index))
    .filter((summary): summary is string => typeof summary === "string" && summary.length > 0);

  const pathPart = path ? `for '${path}'` : "";
  if (editSummaries.length === 0) {
    if (!fallback) {
      return null;
    }
    return pathPart ? `${pathPart} ${fallback}` : fallback;
  }

  const extraEdits = editSummaries.length > 1 ? `, plus ${formatCount(editSummaries.length - 1, "additional edit", "additional edits")}` : "";
  const summary = `(${formatCount(editSummaries.length, "edit", "edits")}: ${editSummaries[0]}${extraEdits})`;
  return pathPart ? `${pathPart} ${summary}` : summary;
}

function formatEditInputForPrompt(input: Record<string, unknown>): string {
  return formatStructuredEditInputForPrompt(input, "with edit input") ?? "with edit input";
}

function formatWriteInputForPrompt(input: Record<string, unknown>): string {
  const path = getPromptPath(input);
  const content = typeof input.content === "string" ? input.content : "";
  const summary = `(${formatCount(countTextLines(content), "line", "lines")}, ${formatCount(content.length, "character", "characters")})`;
  return path ? `for '${path}' ${summary}` : summary;
}

function formatReadInputForPrompt(input: Record<string, unknown>): string {
  const path = getPromptPath(input);
  const parts = path ? [`path '${path}'`] : [];
  if (typeof input.offset === "number") {
    parts.push(`offset ${input.offset}`);
  }
  if (typeof input.limit === "number") {
    parts.push(`limit ${input.limit}`);
  }
  return parts.length > 0 ? `for ${parts.join(", ")}` : "";
}

function formatSearchInputForPrompt(toolName: string, input: Record<string, unknown>): string {
  const parts: string[] = [];
  const path = getPromptPath(input);
  const pattern = getNonEmptyString(input.pattern);
  const glob = getNonEmptyString(input.glob);

  if (pattern) {
    parts.push(`pattern '${sanitizeInlineText(pattern)}'`);
  }
  if (glob) {
    parts.push(`glob '${sanitizeInlineText(glob)}'`);
  }
  if (path) {
    parts.push(`path '${path}'`);
  } else if (toolName === "find" || toolName === "grep" || toolName === "ls") {
    parts.push("current working directory");
  }

  return parts.length > 0 ? `for ${parts.join(", ")}` : "";
}

function serializeToolInputPreview(input: unknown): string {
  const serialized = safeJsonStringify(input);
  if (!serialized || serialized === "{}" || serialized === "null") {
    return "";
  }

  return serialized.replace(/\s+/g, " ").trim();
}

function formatJsonInputForPrompt(input: unknown): string {
  const inline = serializeToolInputPreview(input);
  return inline ? `with input ${truncateInlineText(inline, TOOL_INPUT_PREVIEW_MAX_LENGTH)}` : "";
}

function formatToolInputForPrompt(toolName: string, input: unknown): string {
  const inputRecord = toRecord(input);

  switch (toolName) {
    case "edit":
      return formatEditInputForPrompt(inputRecord);
    case "write":
      return formatWriteInputForPrompt(inputRecord);
    case "read":
      return formatReadInputForPrompt(inputRecord);
    case "find":
    case "grep":
    case "ls":
      return formatSearchInputForPrompt(toolName, inputRecord);
    default: {
      const structuredEditPreview = formatStructuredEditInputForPrompt(inputRecord);
      return structuredEditPreview ?? formatJsonInputForPrompt(input);
    }
  }
}

function formatAskPrompt(result: PermissionCheckResult, agentName?: string, input?: unknown): string {
  const subject = agentName ? `Agent '${agentName}'` : "Current agent";

  if (result.toolName === "bash") {
    const patternInfo = result.matchedPattern ? ` (matched '${result.matchedPattern}')` : "";
    return `${subject} requested bash command '${result.command || ""}'${patternInfo}. Allow this command?`;
  }

  if ((result.source === "mcp" || result.toolName === "mcp") && result.target) {
    const patternInfo = result.matchedPattern ? ` (matched '${result.matchedPattern}')` : "";
    return `${subject} requested MCP target '${result.target}'${patternInfo}. Allow this call?`;
  }

  const patternInfo = result.matchedPattern ? ` (matched '${result.matchedPattern}')` : "";
  const inputPreview = formatToolInputForPrompt(result.toolName, input);
  const inputSuffix = inputPreview ? ` ${inputPreview}` : "";
  return `${subject} requested tool '${result.toolName}'${patternInfo}${inputSuffix}. Allow this call?`;
}

function formatSkillAskPrompt(skillName: string, agentName?: string): string {
  const subject = agentName ? `Agent '${agentName}'` : "Current agent";
  return `${subject} requested skill '${skillName}'. Allow loading this skill?`;
}

function formatSkillPathAskPrompt(skill: SkillPromptEntry, readPath: string, agentName?: string): string {
  const subject = agentName ? `Agent '${agentName}'` : "Current agent";
  return `${subject} requested access to skill '${skill.name}' via '${readPath}'. Allow this read?`;
}

function formatSkillPathDenyReason(skill: SkillPromptEntry, readPath: string, agentName?: string): string {
  const subject = agentName ? `Agent '${agentName}'` : "Current agent";
  return `${subject} is not permitted to access this skill.`;
}

function extractSkillNameUnderRoot(normalizedReadPath: string, normalizedSkillsRoot: string): string | null {
  if (!isPathWithinDirectory(normalizedReadPath, normalizedSkillsRoot)) {
    return null;
  }

  const relativeSkillPath = relative(normalizedSkillsRoot, normalizedReadPath);
  const skillName = relativeSkillPath.split(/[\\/]+/).find((part) => part.length > 0);
  return skillName ?? null;
}

function inferSkillEntryFromReadPath(
  readPath: string,
  cwd: string,
  state: SkillPromptEntry["state"],
): SkillPromptEntry | null {
  const normalizedReadPath = normalizePathForComparison(readPath, cwd);
  if (!normalizedReadPath) {
    return null;
  }

  const candidateSkillRoots = [
    join(PI_AGENT_DIR, "skills"),
    join(cwd, ...SKILLS_DIR_PARTS),
  ];

  for (const skillRoot of candidateSkillRoots) {
    const normalizedSkillRoot = normalizePathForComparison(skillRoot, cwd);
    const skillName = extractSkillNameUnderRoot(normalizedReadPath, normalizedSkillRoot);
    if (!skillName) {
      continue;
    }

    return {
      name: skillName,
      description: "",
      location: readPath,
      state,
      normalizedLocation: normalizedReadPath,
      normalizedBaseDir: normalizePathForComparison(dirname(readPath), cwd),
    };
  }

  return null;
}

function formatExternalDirectoryHardStopHint(): string {
  return "Hard stop: this external directory permission denial is policy-enforced. Do not retry this path, do not attempt a filesystem bypass, and report the block to the user.";
}

function formatExternalDirectoryAskPrompt(
  toolName: string,
  pathValue: string,
  cwd: string,
  agentName?: string,
): string {
  const subject = agentName ? `Agent '${agentName}'` : "Current agent";
  return `${subject} requested tool '${toolName}' for path '${pathValue}' outside working directory '${cwd}'. Allow this external directory access?`;
}

function formatExternalDirectoryDenyReason(
  toolName: string,
  pathValue: string,
  cwd: string,
  agentName?: string,
): string {
  const subject = agentName ? `Agent '${agentName}'` : "Current agent";
  return `${subject} is not permitted to run tool '${toolName}' for path '${pathValue}' outside working directory '${cwd}'. ${formatExternalDirectoryHardStopHint()}`;
}

function formatExternalDirectoryUserDeniedReason(
  toolName: string,
  pathValue: string,
  denialReason?: string,
): string {
  const reasonSuffix = denialReason ? ` Reason: ${denialReason}.` : "";
  return `User denied external directory access for tool '${toolName}' path '${pathValue}'.${reasonSuffix} ${formatExternalDirectoryHardStopHint()}`;
}

function formatGenericToolInputForLog(input: unknown): string | undefined {
  const inline = serializeToolInputPreview(input);
  return inline ? `input ${truncateInlineText(inline, TOOL_INPUT_LOG_PREVIEW_MAX_LENGTH)}` : undefined;
}

function getToolInputPreviewForLog(result: PermissionCheckResult, input: unknown): string | undefined {
  if (result.toolName === "bash" || result.toolName === "mcp" || result.source === "mcp") {
    return undefined;
  }

  if (PATH_BEARING_TOOLS.has(result.toolName)) {
    const inputPreview = formatToolInputForPrompt(result.toolName, input);
    return inputPreview ? truncateInlineText(inputPreview, TOOL_INPUT_LOG_PREVIEW_MAX_LENGTH) : undefined;
  }

  return formatGenericToolInputForLog(input);
}

function createSensitiveLogMetadata(value: string | undefined): SensitiveLogMetadata | null {
  if (value === undefined) {
    return null;
  }

  return {
    present: true,
    length: value.length,
    sha256: createHash("sha256").update(value).digest("hex"),
  };
}

function getPermissionLogContext(
  result: PermissionCheckResult,
  input: unknown,
): {
  command?: string;
  commandMetadata: SensitiveLogMetadata | null;
  target?: string;
  toolInputPreviewMetadata: SensitiveLogMetadata | null;
} {
  return {
    command: result.toolName === "bash" && result.command ? result.command : undefined,
    commandMetadata: createSensitiveLogMetadata(result.command),
    target: result.target,
    toolInputPreviewMetadata: createSensitiveLogMetadata(getToolInputPreviewForLog(result, input)),
  };
}

function waitForForwardedPermissionResponseFile(responsePath: string, deadline: number): Promise<void> {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) {
    return Promise.resolve();
  }

  const timeoutMs = Math.min(PERMISSION_FORWARDING_POLL_INTERVAL_MS, remainingMs);
  const responseDir = dirname(responsePath);
  const responseFileName = basename(responsePath);

  return new Promise((resolve) => {
    let watcher: FSWatcher | null = null;
    let timer: NodeJS.Timeout | null = null;
    let finished = false;
    const finish = (): void => {
      if (finished) {
        return;
      }
      finished = true;
      if (timer) {
        clearTimeout(timer);
      }
      if (watcher) {
        try {
          watcher.close();
        } catch {
          // Ignore watcher cleanup errors; polling fallback covers missed events.
        }
      }
      resolve();
    };
    timer = setTimeout(finish, timeoutMs);

    try {
      watcher = watch(responseDir, { persistent: false }, (_eventType: unknown, fileName: unknown) => {
        if (!fileName || String(fileName) === responseFileName) {
          finish();
        }
      });
      watcher.on("error", finish);
    } catch {
      // Directory watches are best-effort across filesystems; the timeout preserves safe fallback polling.
    }
  });
}

function normalizeFilesystemPath(pathValue: string): string {
  const normalizedPath = normalize(pathValue);
  return process.platform === "win32" ? normalizedPath.toLowerCase() : normalizedPath;
}

function getSessionId(ctx: ExtensionContext): string {
  try {
    const sessionId = ctx.sessionManager.getSessionId();
    if (typeof sessionId === "string" && sessionId.trim()) {
      return sessionId.trim();
    }
  } catch {
  }

  return "unknown";
}

function isSubagentExecutionContext(ctx: ExtensionContext): boolean {
  if (hasSubagentEnvHint()) {
    return true;
  }

  const sessionDir = ctx.sessionManager.getSessionDir();
  if (!sessionDir) {
    return false;
  }

  const normalizedSessionDir = normalizeFilesystemPath(sessionDir);
  const normalizedSubagentRoot = normalizeFilesystemPath(SUBAGENT_SESSIONS_DIR);
  return isPathWithinDirectory(normalizedSessionDir, normalizedSubagentRoot);
}

function canRequestPermissionConfirmation(ctx: ExtensionContext): boolean {
  return canResolveAskPermissionRequest({
    config: extensionConfig,
    hasUI: ctx.hasUI,
    isSubagent: isSubagentExecutionContext(ctx),
  });
}

function formatUnknownErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return String(error);
}

function isErrnoCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: string }).code === code);
}

function logPermissionForwardingWarning(message: string, error?: unknown): void {
  const details = typeof error === "undefined"
    ? { message }
    : { message, error: formatUnknownErrorMessage(error) };

  writeReviewLog("permission_forwarding.warning", details);
  writeDebugLog("permission_forwarding.warning", details);
}

function logPermissionForwardingError(message: string, error?: unknown): void {
  const details = typeof error === "undefined"
    ? { message }
    : { message, error: formatUnknownErrorMessage(error) };

  writeReviewLog("permission_forwarding.error", details);
  writeDebugLog("permission_forwarding.error", details);
}

function setRestrictiveFileSystemMode(path: string, mode: number, description: string): void {
  try {
    chmodSync(path, mode);
  } catch (error) {
    logPermissionForwardingWarning(`Failed to restrict ${description} permissions for '${path}'`, error);
  }
}

function ensureDirectoryExists(path: string, description: string): boolean {
  try {
    mkdirSync(path, { recursive: true, mode: 0o700 });
    setRestrictiveFileSystemMode(path, 0o700, description);
    return true;
  } catch (error) {
    logPermissionForwardingError(`Failed to create ${description} directory '${path}'`, error);
    return false;
  }
}

function getPermissionForwardingRootDir(ctx: ExtensionContext): string {
  return resolvePermissionForwardingRootDir({
    defaultAgentDir: PI_AGENT_DIR,
    isSubagent: isSubagentExecutionContext(ctx),
    env: process.env,
  });
}

function getPermissionForwardingLocationForSession(
  sessionId: string,
  ctx: ExtensionContext,
): PermissionForwardingLocation {
  return createPermissionForwardingLocation(getPermissionForwardingRootDir(ctx), sessionId);
}

function ensurePermissionForwardingLocation(
  sessionId: string,
  ctx: ExtensionContext,
): PermissionForwardingLocation | null {
  let location: PermissionForwardingLocation;
  try {
    location = getPermissionForwardingLocationForSession(sessionId, ctx);
  } catch (error) {
    logPermissionForwardingError("Failed to resolve permission forwarding location", error);
    return null;
  }

  const sessionRootReady = ensureDirectoryExists(location.sessionRootDir, "permission forwarding session root");
  const requestsReady = ensureDirectoryExists(location.requestsDir, "permission forwarding requests");
  const responsesReady = ensureDirectoryExists(location.responsesDir, "permission forwarding responses");

  return sessionRootReady && requestsReady && responsesReady ? location : null;
}

function getExistingPermissionForwardingLocation(
  sessionId: string,
  ctx: ExtensionContext,
): PermissionForwardingLocation | null {
  let location: PermissionForwardingLocation;
  try {
    location = getPermissionForwardingLocationForSession(sessionId, ctx);
  } catch {
    return null;
  }

  return existsSync(location.requestsDir) ? location : null;
}

function tryRemoveDirectoryIfEmpty(path: string, description: string): void {
  if (!existsSync(path)) {
    return;
  }

  let entries: string[];
  try {
    entries = readdirSync(path);
  } catch (error) {
    logPermissionForwardingWarning(`Failed to inspect ${description} directory '${path}'`, error);
    return;
  }

  if (entries.length > 0) {
    return;
  }

  try {
    rmdirSync(path);
  } catch (error) {
    if (isErrnoCode(error, "ENOENT") || isErrnoCode(error, "ENOTEMPTY")) {
      return;
    }

    logPermissionForwardingWarning(`Failed to remove empty ${description} directory '${path}'`, error);
  }
}

function cleanupPermissionForwardingLocationIfEmpty(location: PermissionForwardingLocation): void {
  tryRemoveDirectoryIfEmpty(location.requestsDir, `${location.label} permission forwarding requests`);
  tryRemoveDirectoryIfEmpty(location.responsesDir, `${location.label} permission forwarding responses`);
  tryRemoveDirectoryIfEmpty(location.sessionRootDir, `${location.label} permission forwarding session root`);
}

function safeDeleteFile(filePath: string, description: string): void {
  try {
    unlinkSync(filePath);
  } catch (error) {
    if (isErrnoCode(error, "ENOENT")) {
      return;
    }

    logPermissionForwardingWarning(`Failed to delete ${description} file '${filePath}'`, error);
  }
}

function createPermissionForwardingNonce(): string {
  return randomBytes(32).toString("base64url");
}

function safeEqualString(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function isForwardedPermissionResponseBoundToRequest(
  response: ForwardedPermissionResponse | null,
  request: Pick<ForwardedPermissionRequest, "id" | "responseNonce">,
  responsePath: string,
  targetSessionId: string,
  responderSessionId?: string,
): response is ForwardedPermissionResponse {
  if (!response) {
    return false;
  }
  if (response.requestId !== request.id || !safeEqualString(response.responseNonce, request.responseNonce)) {
    logPermissionForwardingWarning(`Ignoring forwarded permission response '${responsePath}' because it is not bound to request '${request.id}'`);
    return false;
  }
  if (response.responderSessionId !== (responderSessionId ?? targetSessionId)) {
    logPermissionForwardingWarning(`Ignoring forwarded permission response '${responsePath}' because responder session '${response.responderSessionId}' does not match target session '${targetSessionId}'`);
    return false;
  }
  return true;
}

function writeJsonFileAtomic(filePath: string, value: unknown): void {
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;

  try {
    writeFileSync(tempPath, JSON.stringify(value), { encoding: "utf-8", flag: "wx", mode: 0o600 });
    setRestrictiveFileSystemMode(tempPath, 0o600, "temporary permission-forwarding file");
    renameSync(tempPath, filePath);
    setRestrictiveFileSystemMode(filePath, 0o600, "permission-forwarding file");
  } catch (error) {
    safeDeleteFile(tempPath, "temporary permission-forwarding");
    throw error;
  }
}

async function readForwardedPermissionRequest(filePath: string): Promise<ForwardedPermissionRequest | null> {
  try {
    const raw = await readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<ForwardedPermissionRequest>;
    if (
      !parsed
      || typeof parsed.id !== "string"
      || typeof parsed.responseNonce !== "string"
      || typeof parsed.createdAt !== "number"
      || typeof parsed.requesterSessionId !== "string"
      || typeof parsed.targetSessionId !== "string"
      || typeof parsed.requesterAgentName !== "string"
      || typeof parsed.message !== "string"
    ) {
      logPermissionForwardingWarning(`Ignoring invalid forwarded permission request format in '${filePath}'`);
      return null;
    }

    return {
      id: parsed.id,
      responseNonce: parsed.responseNonce,
      createdAt: parsed.createdAt,
      requesterSessionId: parsed.requesterSessionId,
      targetSessionId: parsed.targetSessionId,
      requesterAgentName: parsed.requesterAgentName,
      message: parsed.message,
    };
  } catch (error) {
    logPermissionForwardingWarning(`Failed to read forwarded permission request '${filePath}'`, error);
    return null;
  }
}

async function readForwardedPermissionResponse(filePath: string): Promise<ForwardedPermissionResponse | null> {
  try {
    const raw = await readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<ForwardedPermissionResponse>;
    if (
      !parsed
      || typeof parsed.requestId !== "string"
      || typeof parsed.responseNonce !== "string"
      || typeof parsed.approved !== "boolean"
      || !isPermissionDecisionState(parsed.state)
      || typeof parsed.responderSessionId !== "string"
    ) {
      logPermissionForwardingWarning(`Ignoring invalid forwarded permission response format in '${filePath}'`);
      return null;
    }

    return {
      requestId: parsed.requestId,
      responseNonce: parsed.responseNonce,
      approved: parsed.approved,
      state: parsed.state,
      denialReason: typeof parsed.denialReason === "string" ? parsed.denialReason : undefined,
      responderSessionId: parsed.responderSessionId,
      respondedAt: typeof parsed.respondedAt === "number" ? parsed.respondedAt : Date.now(),
    };
  } catch (error) {
    logPermissionForwardingWarning(`Failed to read forwarded permission response '${filePath}'`, error);
    return null;
  }
}

function formatForwardedPermissionPrompt(request: ForwardedPermissionRequest): string {
  const agentName = request.requesterAgentName || "unknown";
  const sessionId = request.requesterSessionId || "unknown";
  return [
    `Subagent '${agentName}' requested permission.`,
    `Session ID: ${sessionId}`,
    "",
    request.message,
  ].join("\n");
}

async function waitForForwardedPermissionApproval(
  ctx: ExtensionContext,
  message: string,
): Promise<PermissionPromptDecision> {
  const requesterSessionId = getSessionId(ctx);
  const targetSessionId = resolvePermissionForwardingTargetSessionId({
    hasUI: ctx.hasUI,
    isSubagent: isSubagentExecutionContext(ctx),
    currentSessionId: requesterSessionId,
    env: process.env,
  });

  if (!targetSessionId) {
    logPermissionForwardingError(
      "Permission forwarding target session could not be resolved from subagent runtime metadata (expected PI_AGENT_ROUTER_PARENT_SESSION_ID)",
    );
    return { approved: false, state: "denied" };
  }

  const location = ensurePermissionForwardingLocation(targetSessionId, ctx);
  if (!location) {
    logPermissionForwardingError(
      `Permission forwarding is unavailable because session-scoped directories could not be prepared for '${targetSessionId}'`,
    );
    return { approved: false, state: "denied" };
  }

  const requestId = randomUUID();
  const responseNonce = createPermissionForwardingNonce();
  const requesterAgentName = getActiveAgentName(ctx) || getActiveAgentNameFromSystemPrompt(getContextSystemPrompt(ctx)) || "unknown";
  const request: ForwardedPermissionRequest = {
    id: requestId,
    responseNonce,
    createdAt: Date.now(),
    requesterSessionId,
    targetSessionId,
    requesterAgentName,
    message,
  };

  const requestPath = join(location.requestsDir, `${requestId}.json`);
  const responsePath = join(location.responsesDir, `${requestId}.json`);

  writeReviewLog("forwarded_permission.request_created", {
    requestId,
    requesterAgentName,
    requesterSessionId: request.requesterSessionId,
    targetSessionId,
    requestPath,
    responsePath,
  });

  try {
    writeJsonFileAtomic(requestPath, request);
  } catch (error) {
    logPermissionForwardingError(`Failed to write forwarded permission request '${requestPath}'`, error);
    return { approved: false, state: "denied" };
  }

  const deadline = Date.now() + PERMISSION_FORWARDING_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (existsSync(responsePath)) {
      const response = await readForwardedPermissionResponse(responsePath);
      const boundResponse = isForwardedPermissionResponseBoundToRequest(
        response,
        request,
        responsePath,
        targetSessionId,
      ) ? response : null;
      writeReviewLog("forwarded_permission.response_received", {
        requestId,
        approved: boundResponse?.approved ?? null,
        state: boundResponse?.state ?? null,
        denialReasonMetadata: createSensitiveLogMetadata(boundResponse?.denialReason),
        responderSessionId: boundResponse?.responderSessionId ?? null,
        targetSessionId,
        responsePath,
      });
      safeDeleteFile(responsePath, "forwarded permission response");
      if (!boundResponse) {
        continue;
      }
      safeDeleteFile(requestPath, "forwarded permission request");
      cleanupPermissionForwardingLocationIfEmpty(location);
      return boundResponse;
    }

    await waitForForwardedPermissionResponseFile(responsePath, deadline);
  }

  logPermissionForwardingWarning(`Timed out waiting for forwarded permission response '${responsePath}'`);
  writeReviewLog("forwarded_permission.response_timed_out", {
    requestId,
    requesterAgentName,
    targetSessionId,
    responsePath,
  });
  safeDeleteFile(requestPath, "forwarded permission request");
  cleanupPermissionForwardingLocationIfEmpty(location);
  return { approved: false, state: "denied" };
}

async function processForwardedPermissionRequests(
  ctx: ExtensionContext,
  options: { preserveLocation?: boolean } = {},
): Promise<void> {
  if (!ctx.hasUI) {
    return;
  }

  const currentSessionId = getSessionId(ctx);
  const location = getExistingPermissionForwardingLocation(currentSessionId, ctx);
  if (!location) {
    return;
  }

  let requestFiles: string[] = [];
  try {
    requestFiles = readdirSync(location.requestsDir)
      .filter((name) => name.endsWith(".json"))
      .sort();
  } catch (error) {
    logPermissionForwardingWarning(`Failed to read ${location.label} permission forwarding requests from '${location.requestsDir}'`, error);
    return;
  }

  const pendingRequests = await Promise.all(
    requestFiles.map(async (fileName) => {
      const requestPath = join(location.requestsDir, fileName);
      return {
        requestPath,
        request: await readForwardedPermissionRequest(requestPath),
      };
    }),
  );

  for (const { requestPath, request } of pendingRequests) {
    if (!request) {
      safeDeleteFile(requestPath, `${location.label} forwarded permission request`);
      continue;
    }

    if (!isForwardedPermissionRequestForSession(request, currentSessionId)) {
      logPermissionForwardingWarning(
        `Ignoring forwarded permission request '${request.id}' because it targets session '${request.targetSessionId}' instead of '${currentSessionId}'`,
      );
      safeDeleteFile(requestPath, `${location.label} forwarded permission request`);
      continue;
    }

    const forwardedPermissionLogDetails = {
      requestId: request.id,
      source: location.label,
      requesterAgentName: request.requesterAgentName,
      requesterSessionId: request.requesterSessionId,
      targetSessionId: request.targetSessionId,
      requestPath,
    };

    let decision: PermissionPromptDecision = { approved: false, state: "denied" };
    if (shouldAutoApprovePermissionState("ask", extensionConfig)) {
      writeReviewLog("forwarded_permission.auto_approved", forwardedPermissionLogDetails);
      decision = { approved: true, state: "approved" };
    } else {
      writeReviewLog("forwarded_permission.prompted", forwardedPermissionLogDetails);
      try {
        decision = await requestPermissionDecisionFromUi(
          ctx.ui,
          "Permission Required (Subagent)",
          formatForwardedPermissionPrompt(request),
        );
      } catch (error) {
        logPermissionForwardingError("Failed to show forwarded permission confirmation dialog", error);
        decision = { approved: false, state: "denied" };
      }
    }

    const responsePath = join(location.responsesDir, `${request.id}.json`);
    writeReviewLog(decision.approved ? "forwarded_permission.approved" : "forwarded_permission.denied", {
      requestId: request.id,
      source: location.label,
      requesterAgentName: request.requesterAgentName,
      requesterSessionId: request.requesterSessionId,
      targetSessionId: request.targetSessionId,
      responsePath,
      resolution: decision.state,
      denialReasonMetadata: createSensitiveLogMetadata(decision.denialReason),
    });
    try {
      writeJsonFileAtomic(responsePath, {
        requestId: request.id,
        responseNonce: request.responseNonce,
        approved: decision.approved,
        state: decision.state,
        denialReason: decision.denialReason,
        responderSessionId: currentSessionId,
        respondedAt: Date.now(),
      } satisfies ForwardedPermissionResponse);
    } catch (error) {
      logPermissionForwardingError(`Failed to write ${location.label} forwarded permission response '${responsePath}'`, error);
      continue;
    }

    safeDeleteFile(requestPath, `${location.label} forwarded permission request`);
  }

  if (!options.preserveLocation) {
    cleanupPermissionForwardingLocationIfEmpty(location);
  }
}

async function confirmPermission(
  ctx: ExtensionContext,
  message: string,
): Promise<PermissionPromptDecision> {
  if (ctx.hasUI) {
    return requestPermissionDecisionFromUi(ctx.ui, "Permission Required", message);
  }

  if (!isSubagentExecutionContext(ctx)) {
    return { approved: false, state: "denied" };
  }

  return waitForForwardedPermissionApproval(ctx, message);
}

function derivePiProjectPaths(cwd: string | undefined | null): {
  projectGlobalConfigPath: string;
  projectAgentsDir: string;
} | null {
  if (!cwd) {
    return null;
  }

  const projectAgentRoot = join(cwd, ".pi", "agent");
  return {
    projectGlobalConfigPath: join(projectAgentRoot, "pi-permissions.jsonc"),
    projectAgentsDir: join(projectAgentRoot, "agents"),
  };
}

function createPermissionManagerForCwd(
  cwd: string | undefined | null,
  onWarning?: (message: string) => void,
): PermissionManager {
  const projectPaths = derivePiProjectPaths(cwd);
  if (!projectPaths) {
    return new PermissionManager({ onWarning });
  }

  return new PermissionManager({
    projectGlobalConfigPath: projectPaths.projectGlobalConfigPath,
    projectAgentsDir: projectPaths.projectAgentsDir,
    onWarning,
  });
}

export default function piPermissionSystemExtension(pi: ExtensionAPI): void {
  let activeSkillEntries: SkillPromptEntry[] = [];
  const explicitlyRequestedSkillNames = new Set<string>();
  let lastKnownActiveAgentName: string | null = null;
  let lastActiveToolsCacheKey: string | null = null;
  let lastPromptStateCacheKey: string | null = null;
  let permissionForwardingContext: ExtensionContext | null = null;
  let permissionForwardingWatcher: FSWatcher | null = null;
  let permissionForwardingFallbackTimer: NodeJS.Timeout | null = null;
  let permissionForwardingScanTimer: NodeJS.Timeout | null = null;
  let watchedPermissionForwardingRequestsDir: string | null = null;
  let isProcessingForwardedRequests = false;
  let pendingForwardedRequestScan = false;
  let runtimeContext: ExtensionContext | null = null;
  let lastConfigWarning: string | null = null;
  const shownWarnings = new Set<string>();

  const invalidateAgentStartCache = (): void => {
    activeSkillEntries = [];
    lastActiveToolsCacheKey = null;
    lastPromptStateCacheKey = null;
  };

  const resetShownWarnings = (): void => {
    shownWarnings.clear();
  };

  const notifyWarning = (message: string): void => {
    if (!runtimeContext?.hasUI || shownWarnings.has(message)) {
      return;
    }

    shownWarnings.add(message);
    runtimeContext.ui.notify(message, "warning");
  };

  let permissionManager = createPermissionManagerForCwd(undefined, notifyWarning);

  const refreshExtensionConfig = (ctx?: ExtensionContext): void => {
    if (ctx) {
      runtimeContext = ctx;
    }

    const result = loadPermissionSystemConfig();
    setExtensionConfig(result.config);

    if (runtimeContext?.hasUI) {
      syncPermissionSystemStatus(runtimeContext, result.config);
    }

    if (result.warning && result.warning !== lastConfigWarning) {
      lastConfigWarning = result.warning;
      notifyWarning(result.warning);
    } else if (!result.warning) {
      lastConfigWarning = null;
    }

    writeDebugLog("config.loaded", {
      created: result.created,
      warning: result.warning ?? null,
      debugLog: result.config.debugLog,
      permissionReviewLog: result.config.permissionReviewLog,
      logPlaintextBashCommands: result.config.logPlaintextBashCommands,
      yoloMode: result.config.yoloMode,
    });
  };

  const syncPermissionSystemStatusWhenPossible = (
    config: PermissionSystemExtensionConfig,
    ctx?: ExtensionCommandContext | ExtensionContext,
  ): void => {
    if (ctx) {
      syncPermissionSystemStatus(ctx, config);
      return;
    }

    if (runtimeContext?.hasUI) {
      syncPermissionSystemStatus(runtimeContext, config);
    }
  };

  const saveExtensionConfig = (next: PermissionSystemExtensionConfig, ctx: ExtensionCommandContext): void => {
    const normalized = normalizePermissionSystemConfig(next);
    const saved = savePermissionSystemConfig(normalized);
    if (!saved.success) {
      if (saved.error) {
        ctx.ui.notify(saved.error, "error");
      }
      return;
    }

    setExtensionConfig(normalized);
    syncPermissionSystemStatusWhenPossible(normalized, ctx);
    lastConfigWarning = null;

    writeDebugLog("config.saved", {
      debugLog: normalized.debugLog,
      permissionReviewLog: normalized.permissionReviewLog,
      logPlaintextBashCommands: normalized.logPlaintextBashCommands,
      yoloMode: normalized.yoloMode,
    });
  };

  const setYoloModeFromRuntimeApi = (enabled: boolean, options: YoloModeControlOptions = {}): YoloModeControlResult => {
    if (typeof enabled !== "boolean") {
      return {
        yoloMode: extensionConfig.yoloMode,
        changed: false,
        persisted: false,
        error: "setYoloMode(enabled) requires a boolean value.",
      };
    }

    const normalized = normalizePermissionSystemConfig({ ...extensionConfig, yoloMode: enabled });
    const persisted = options.persist !== false;
    const changed = extensionConfig.yoloMode !== normalized.yoloMode;

    if (persisted) {
      const saved = savePermissionSystemConfig(normalized);
      if (!saved.success) {
        const error = saved.error ?? "Failed to persist pi-permission-system config.";
        writeDebugLog("yolo_mode.update_failed", {
          error,
          requestedYoloMode: normalized.yoloMode,
          source: getNonEmptyString(options.source) ?? "runtime-api",
        });
        return {
          yoloMode: extensionConfig.yoloMode,
          changed: false,
          persisted: false,
          error,
        };
      }
      lastConfigWarning = null;
    }

    setExtensionConfig(normalized);
    syncPermissionSystemStatusWhenPossible(normalized);
    writeDebugLog("yolo_mode.updated", {
      changed,
      persisted,
      source: getNonEmptyString(options.source) ?? "runtime-api",
      yoloMode: normalized.yoloMode,
    });

    return {
      yoloMode: normalized.yoloMode,
      changed,
      persisted,
    };
  };

  setLoggingWarningReporter(notifyWarning);
  refreshExtensionConfig();
  runtimeApi = registerPiPermissionSystemRuntimeApi({
    getYoloMode: () => extensionConfig.yoloMode,
    setYoloMode: setYoloModeFromRuntimeApi,
    toggleYoloMode: (options?: YoloModeControlOptions) => setYoloModeFromRuntimeApi(!extensionConfig.yoloMode, options),
  });
  registerModelOptionCompatibilityGuard(pi);

  registerPermissionSystemCommand(pi, {
    getConfig: () => extensionConfig,
    setConfig: saveExtensionConfig,
    getConfigPath: getPermissionSystemConfigPath,
  });

  const createPermissionRequestId = (prefix: string): string => {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}-${process.pid}`;
  };

  const emitPermissionRequestEvent = (event: PermissionRequestEvent): void => {
    try {
      pi.events.emit(PERMISSION_REQUEST_EVENT_CHANNEL, event);
    } catch (error) {
      writeDebugLog("permission_request.event_emit_failed", {
        requestId: event.requestId,
        source: event.source,
        state: event.state,
        error: formatUnknownErrorMessage(error),
      });
    }
  };

  const reviewPermissionDecision = (
    event: string,
    details: {
      requestId: string;
      source: PermissionRequestSource;
      agentName: string | null;
      message: string;
      toolCallId?: string;
      toolName?: string;
      skillName?: string;
      path?: string;
      command?: string;
      commandMetadata?: SensitiveLogMetadata | null;
      target?: string;
      toolInputPreviewMetadata?: SensitiveLogMetadata | null;
      resolution?: string;
      denialReason?: string;
    },
  ): void => {
    writeReviewLog(event, {
      requestId: details.requestId,
      source: details.source,
      agentName: details.agentName,
      promptMetadata: createSensitiveLogMetadata(details.message),
      toolCallId: details.toolCallId ?? null,
      toolName: details.toolName ?? null,
      skillName: details.skillName ?? null,
      path: details.path ?? null,
      command: details.command ?? null,
      commandMetadata: details.commandMetadata ?? null,
      target: details.target ?? null,
      toolInputPreviewMetadata: details.toolInputPreviewMetadata ?? null,
      resolution: details.resolution ?? null,
      denialReasonMetadata: createSensitiveLogMetadata(details.denialReason),
    });
  };

  const promptPermission = async (
    ctx: ExtensionContext,
    details: {
      requestId: string;
      source: PermissionRequestSource;
      agentName: string | null;
      message: string;
      toolCallId?: string;
      toolName?: string;
      skillName?: string;
      path?: string;
      command?: string;
      commandMetadata?: SensitiveLogMetadata | null;
      target?: string;
      toolInputPreviewMetadata?: SensitiveLogMetadata | null;
    },
  ): Promise<PermissionPromptDecision> => {
    if (shouldAutoApprovePermissionState("ask", extensionConfig)) {
      reviewPermissionDecision("permission_request.auto_approved", details);
      emitPermissionRequestEvent({
        requestId: details.requestId,
        source: details.source,
        state: "approved",
        message: details.message,
        toolCallId: details.toolCallId,
        toolName: details.toolName,
        skillName: details.skillName,
        path: details.path,
        command: details.command,
        target: details.target,
        agentName: details.agentName,
      });
      return { approved: true, state: "approved" };
    }

    reviewPermissionDecision("permission_request.waiting", details);
    emitPermissionRequestEvent({
      requestId: details.requestId,
      source: details.source,
      state: "waiting",
      message: details.message,
      toolCallId: details.toolCallId,
      toolName: details.toolName,
      skillName: details.skillName,
      path: details.path,
      command: details.command,
      target: details.target,
      agentName: details.agentName,
    });

    const decision = await confirmPermission(ctx, details.message);
    reviewPermissionDecision(decision.approved ? "permission_request.approved" : "permission_request.denied", {
      ...details,
      resolution: decision.state,
      denialReason: decision.denialReason,
    });
    emitPermissionRequestEvent({
      requestId: details.requestId,
      source: details.source,
      state: decision.approved ? "approved" : "denied",
      message: details.message,
      toolCallId: details.toolCallId,
      toolName: details.toolName,
      skillName: details.skillName,
      path: details.path,
      command: details.command,
      target: details.target,
      agentName: details.agentName,
    });

    return decision;
  };

  const closePermissionForwardingWatcher = (): void => {
    if (permissionForwardingWatcher) {
      try {
        permissionForwardingWatcher.close();
      } catch (error) {
        logPermissionForwardingWarning("Failed to close permission forwarding watcher", error);
      }
      permissionForwardingWatcher = null;
    }
    watchedPermissionForwardingRequestsDir = null;
  };

  const stopPermissionForwardingFallbackTimer = (): void => {
    if (permissionForwardingFallbackTimer) {
      clearInterval(permissionForwardingFallbackTimer);
      permissionForwardingFallbackTimer = null;
    }
  };

  const runForwardedPermissionRequestScan = (): void => {
    const currentContext = permissionForwardingContext;
    if (!currentContext) {
      return;
    }

    if (isProcessingForwardedRequests) {
      pendingForwardedRequestScan = true;
      return;
    }

    isProcessingForwardedRequests = true;
    void processForwardedPermissionRequests(currentContext, { preserveLocation: true })
      .finally(() => {
        isProcessingForwardedRequests = false;
        if (pendingForwardedRequestScan) {
          pendingForwardedRequestScan = false;
          runForwardedPermissionRequestScan();
        }
      });
  };

  const queueForwardedPermissionRequestScan = (): void => {
    if (!permissionForwardingContext || permissionForwardingScanTimer) {
      return;
    }

    permissionForwardingScanTimer = setTimeout(() => {
      permissionForwardingScanTimer = null;
      runForwardedPermissionRequestScan();
    }, PERMISSION_FORWARDING_WATCH_DEBOUNCE_MS);
  };

  const startPermissionForwardingFallbackTimer = (): void => {
    if (permissionForwardingFallbackTimer) {
      return;
    }

    permissionForwardingFallbackTimer = setInterval(
      queueForwardedPermissionRequestScan,
      PERMISSION_FORWARDING_POLL_INTERVAL_MS,
    );
  };

  const stopForwardedPermissionPolling = (): void => {
    closePermissionForwardingWatcher();
    stopPermissionForwardingFallbackTimer();
    if (permissionForwardingScanTimer) {
      clearTimeout(permissionForwardingScanTimer);
      permissionForwardingScanTimer = null;
    }

    permissionForwardingContext = null;
    isProcessingForwardedRequests = false;
    pendingForwardedRequestScan = false;
  };

  const startForwardedPermissionPolling = (ctx: ExtensionContext): void => {
    if (!ctx.hasUI || isSubagentExecutionContext(ctx)) {
      stopForwardedPermissionPolling();
      return;
    }

    const sessionId = getSessionId(ctx);
    const location = ensurePermissionForwardingLocation(sessionId, ctx);
    if (!location) {
      return;
    }

    permissionForwardingContext = ctx;
    if (permissionForwardingWatcher && watchedPermissionForwardingRequestsDir === location.requestsDir) {
      queueForwardedPermissionRequestScan();
      return;
    }

    closePermissionForwardingWatcher();
    stopPermissionForwardingFallbackTimer();

    try {
      permissionForwardingWatcher = watch(location.requestsDir, { persistent: false }, (_eventType: unknown, fileName: unknown) => {
        const normalizedFileName = fileName ? String(fileName) : "";
        if (!normalizedFileName || normalizedFileName.endsWith(".json") || normalizedFileName.endsWith(".tmp")) {
          queueForwardedPermissionRequestScan();
        }
      });
      permissionForwardingWatcher.on("error", (error) => {
        logPermissionForwardingWarning(
          `Permission forwarding watcher failed for '${location.requestsDir}'; using reduced-frequency polling fallback`,
          error,
        );
        closePermissionForwardingWatcher();
        startPermissionForwardingFallbackTimer();
      });
      watchedPermissionForwardingRequestsDir = location.requestsDir;
    } catch (error) {
      logPermissionForwardingWarning(
        `Unable to watch permission forwarding requests at '${location.requestsDir}'; using reduced-frequency polling fallback`,
        error,
      );
      startPermissionForwardingFallbackTimer();
    }

    queueForwardedPermissionRequestScan();
  };

  const resolveAgentName = (ctx: ExtensionContext, systemPrompt?: string): string | null => {
    const fromSession = getActiveAgentName(ctx);
    if (fromSession) {
      lastKnownActiveAgentName = fromSession;
      return fromSession;
    }

    const fromSystemPrompt = getActiveAgentNameFromSystemPrompt(systemPrompt);
    if (fromSystemPrompt) {
      lastKnownActiveAgentName = fromSystemPrompt;
      return fromSystemPrompt;
    }

    return lastKnownActiveAgentName;
  };

  const shouldExposeTool = (toolName: string, agentName: string | null): boolean => {
    // Use tool-level permission check for tool injection decisions
    // This ensures that agent-specific tool deny rules (e.g., bash: deny) are respected
    // before any command-level permissions are considered
    const toolPermission = permissionManager.getToolPermission(toolName, agentName ?? undefined);
    if (toolPermission !== "deny") {
      return true;
    }

    // If the read tool is denied but the agent has explicitly allowed skills,
    // expose read anyway so the agent can read skill files. The tool_call handler
    // will restrict reads to skill paths only.
    if (toolName === "read" && permissionManager.hasAllowedSkills(agentName ?? undefined)) {
      return true;
    }

    return false;
  };

  const refreshSessionRuntimeState = (ctx: ExtensionContext): void => {
    runtimeContext = ctx;
    resetShownWarnings();
    refreshExtensionConfig(ctx);
    permissionManager = createPermissionManagerForCwd(ctx.cwd, notifyWarning);
    invalidateAgentStartCache();
    lastKnownActiveAgentName = getActiveAgentName(ctx);
    startForwardedPermissionPolling(ctx);
  };

  pi.on("session_start", async (event, ctx) => {
    refreshSessionRuntimeState(ctx);
    explicitlyRequestedSkillNames.clear();

    if (event.reason === "reload") {
      writeDebugLog("lifecycle.reload", {
        triggeredBy: "session_start",
        reason: event.reason,
        cwd: ctx.cwd,
      });
    }
  });

  pi.on("resources_discover", async (event, _ctx) => {
    if (event.reason === "reload") {
      resetShownWarnings();
      permissionManager = runtimeContext
        ? createPermissionManagerForCwd(runtimeContext.cwd, notifyWarning)
        : createPermissionManagerForCwd(undefined, notifyWarning);
      invalidateAgentStartCache();
      writeDebugLog("lifecycle.reload", {
        triggeredBy: "resources_discover",
        reason: event.reason,
        cwd: runtimeContext?.cwd ?? null,
      });
    }
  });


  pi.on("session_shutdown", async () => {
    runtimeContext?.ui.setStatus(PERMISSION_SYSTEM_STATUS_KEY, undefined);
    resetShownWarnings();
    runtimeContext = null;
    unregisterPiPermissionSystemRuntimeApi(runtimeApi ?? undefined);
    explicitlyRequestedSkillNames.clear();
    runtimeApi = null;
    invalidateAgentStartCache();
    stopForwardedPermissionPolling();
  });

  pi.on("before_agent_start", async (event, ctx) => {
    runtimeContext = ctx;
    refreshExtensionConfig(ctx);
    startForwardedPermissionPolling(ctx);
    const agentName = resolveAgentName(ctx, event.systemPrompt);
    const allTools = pi.getAllTools();
    const allowedTools: string[] = [];

    for (const tool of allTools) {
      const toolName = getEventToolName(tool);
      if (!toolName) {
        continue;
      }

      if (shouldExposeTool(toolName, agentName)) {
        allowedTools.push(toolName);
      }
    }

    const activeToolsCacheKey = createActiveToolsCacheKey(allowedTools);
    if (shouldApplyCachedAgentStartState(lastActiveToolsCacheKey, activeToolsCacheKey)) {
      pi.setActiveTools(allowedTools);
      lastActiveToolsCacheKey = activeToolsCacheKey;
    }

    const promptStateCacheKey = createBeforeAgentStartPromptStateKey({
      agentName,
      cwd: ctx.cwd,
      permissionStamp: permissionManager.getPolicyCacheStamp(agentName ?? undefined),
      systemPrompt: event.systemPrompt,
      allowedToolNames: allowedTools,
    });

    if (!shouldApplyCachedAgentStartState(lastPromptStateCacheKey, promptStateCacheKey)) {
      return {};
    }

    lastPromptStateCacheKey = promptStateCacheKey;
    const toolPromptResult = sanitizeAvailableToolsSection(event.systemPrompt, allowedTools);
    const skillPromptResult = resolveSkillPromptEntries(toolPromptResult.prompt, permissionManager, agentName, ctx.cwd);
    activeSkillEntries = skillPromptResult.entries;

    if (skillPromptResult.prompt !== event.systemPrompt) {
      return { systemPrompt: skillPromptResult.prompt };
    }

    return {};
  });

  pi.on("input", async (event, ctx) => {
    runtimeContext = ctx;
    startForwardedPermissionPolling(ctx);
    const skillName = extractSkillNameFromInput(event.text);
    if (!skillName) {
      return { action: "continue" };
    }

    // A slash command is a direct user action, not an agent-initiated skill use.
    // Let Pi handle the command even when the active agent hides or denies skills
    // in frontmatter, and remember the explicit request for skill file reads that
    // happen while the command-provided skill is active.
    explicitlyRequestedSkillNames.add(skillName);
    return { action: "continue" };
  });

  pi.on("tool_call", async (event, ctx) => {
    runtimeContext = ctx;
    startForwardedPermissionPolling(ctx);
    const agentName = resolveAgentName(ctx);
    const toolName = getEventToolName(event);

    if (!toolName) {
      return { block: true, reason: formatMissingToolNameReason() };
    }

    const registrationCheck = checkRequestedToolRegistration(toolName, pi.getAllTools());
    if (registrationCheck.status === "missing-tool-name") {
      return { block: true, reason: formatMissingToolNameReason() };
    }

    if (registrationCheck.status === "unregistered") {
      return {
        block: true,
        reason: formatUnknownToolReason(registrationCheck.requestedToolName, registrationCheck.availableToolNames),
      };
    }

    if (isToolCallEventType("read", event)) {
      const normalizedReadPath = normalizePathForComparison(event.input.path, ctx.cwd);
      const matchedSkill = findSkillPathMatch(normalizedReadPath, activeSkillEntries);
      const inferredSkill = matchedSkill
        ? null
        : inferSkillEntryFromReadPath(event.input.path, ctx.cwd, "ask");
      const inferredSkillCheck = inferredSkill
        ? permissionManager.checkPermission("skill", { name: inferredSkill.name }, agentName ?? undefined)
        : null;
      const readSkill = matchedSkill ?? (inferredSkill && inferredSkillCheck
        ? { ...inferredSkill, state: inferredSkillCheck.state }
        : null);

      if (readSkill && !explicitlyRequestedSkillNames.has(readSkill.name)) {
        if (readSkill.state === "deny") {
          writeReviewLog("permission_request.blocked", {
            source: "skill_read",
            skillName: readSkill.name,
            agentName,
            path: event.input.path,
            resolution: "policy_denied",
          });
          return {
            block: true,
            reason: formatSkillPathDenyReason(readSkill, event.input.path, agentName ?? undefined),
          };
        }

        if (readSkill.state === "ask") {
          const message = formatSkillPathAskPrompt(readSkill, event.input.path, agentName ?? undefined);
          if (!canRequestPermissionConfirmation(ctx)) {
            writeReviewLog("permission_request.blocked", {
              source: "skill_read",
              skillName: readSkill.name,
              agentName,
              path: event.input.path,
              promptMetadata: createSensitiveLogMetadata(message),
              resolution: "confirmation_unavailable",
            });
            return {
              block: true,
              reason: `Accessing this skill requires approval, but no interactive UI is available.`,
            };
          }

          const decision = await promptPermission(ctx, {
            requestId: event.toolCallId,
            source: "skill_read",
            agentName,
            message,
            toolCallId: event.toolCallId,
            toolName: toolName,
            skillName: readSkill.name,
            path: event.input.path,
          });
          if (!decision.approved) {
            const denialReason = decision.denialReason ? ` Reason: ${decision.denialReason}.` : "";
            return { block: true, reason: `User denied access to this skill.${denialReason}` };
          }
        }
      }

      if (readSkill) {
        return {};
      }
    }

    const input = getEventInput(event);
    const externalDirectoryPath = ctx.cwd ? getPathBearingToolPath(toolName, input) : null;

    if (ctx.cwd && externalDirectoryPath && isPathOutsideWorkingDirectory(externalDirectoryPath, ctx.cwd)) {
      const extCheck = permissionManager.checkPermission("external_directory", {}, agentName ?? undefined);

      if (extCheck.state === "deny") {
        writeReviewLog("permission_request.blocked", {
          source: "tool_call",
          toolCallId: event.toolCallId,
          toolName,
          agentName,
          path: externalDirectoryPath,
          resolution: "policy_denied",
        });
        return {
          block: true,
          reason: formatExternalDirectoryDenyReason(
            toolName,
            externalDirectoryPath,
            ctx.cwd,
            agentName ?? undefined,
          ),
        };
      }

      if (extCheck.state === "ask") {
        const message = formatExternalDirectoryAskPrompt(
          toolName,
          externalDirectoryPath,
          ctx.cwd,
          agentName ?? undefined,
        );
        if (!canRequestPermissionConfirmation(ctx)) {
          writeReviewLog("permission_request.blocked", {
            source: "tool_call",
            toolCallId: event.toolCallId,
            toolName,
            agentName,
            path: externalDirectoryPath,
            promptMetadata: createSensitiveLogMetadata(message),
            resolution: "confirmation_unavailable",
          });
          return {
            block: true,
            reason: `Accessing '${externalDirectoryPath}' outside the working directory requires approval, but no interactive UI is available.`,
          };
        }

        const extDecision = await promptPermission(ctx, {
          requestId: event.toolCallId,
          source: "tool_call",
          agentName,
          message,
          toolCallId: event.toolCallId,
          toolName,
          path: externalDirectoryPath,
        });

        if (!extDecision.approved) {
          return {
            block: true,
            reason: formatExternalDirectoryUserDeniedReason(
              toolName,
              externalDirectoryPath,
              extDecision.denialReason,
            ),
          };
        }
      }
      // state === "allow" → fall through to normal permission check
    }

    // Hardcoded: .env files always require approval regardless of tool-level config.
    if (PATH_BEARING_TOOLS.has(toolName)) {
      const filePath = getPathBearingToolPath(toolName, input);
      if (filePath && /\.env$/.test(filePath)) {
        const envCheck = { toolName, state: "ask" as const, source: "tool" as const, matchedPattern: "*.env (hardcoded)" };
        const envLogContext = getPermissionLogContext(envCheck, input);
        const envMessage = `Reading '.env' file '${filePath}' requires approval.`;

        if (!canRequestPermissionConfirmation(ctx)) {
          writeReviewLog("permission_request.blocked", {
            source: "tool_call",
            toolCallId: event.toolCallId,
            toolName,
            agentName,
            ...envLogContext,
            resolution: "confirmation_unavailable",
          });
          return { block: true, reason: envMessage };
        }

        const envDecision = await promptPermission(ctx, {
          requestId: event.toolCallId,
          source: "tool_call",
          agentName,
          message: envMessage,
          toolCallId: event.toolCallId,
          toolName,
          path: filePath,
        });

        if (!envDecision.approved) {
          writeReviewLog("permission_request.resolved", {
            source: "tool_call",
            toolCallId: event.toolCallId,
            toolName,
            agentName,
            ...envLogContext,
            resolution: "user_denied",
          });
          return {
            block: true,
            reason: formatUserDeniedReason(envCheck, envDecision.denialReason),
          };
        }

        return { action: "continue" };
      }
    }

    const check = permissionManager.checkPermission(toolName, input, agentName ?? undefined);
    const permissionLogContext = getPermissionLogContext(check, input);

    if (check.state === "deny") {
      writeReviewLog("permission_request.blocked", {
        source: "tool_call",
        toolCallId: event.toolCallId,
        toolName,
        agentName,
        ...permissionLogContext,
        resolution: "policy_denied",
      });
      return { block: true, reason: formatDenyReason(check, agentName ?? undefined) };
    }

    if (check.state === "ask") {
      const unavailableReason = toolName === "bash" && isToolCallEventType("bash", event)
        ? `Running bash command '${event.input.command}' requires approval, but no interactive UI is available.`
        : toolName === "mcp"
          ? "Using tool 'mcp' requires approval, but no interactive UI is available."
          : `Using tool '${toolName}' requires approval, but no interactive UI is available.`;

      const message = formatAskPrompt(check, agentName ?? undefined, input);
      if (!canRequestPermissionConfirmation(ctx)) {
        writeReviewLog("permission_request.blocked", {
          source: "tool_call",
          toolCallId: event.toolCallId,
          toolName,
          agentName,
          promptMetadata: createSensitiveLogMetadata(message),
          ...permissionLogContext,
          resolution: "confirmation_unavailable",
        });
        return {
          block: true,
          reason: unavailableReason,
        };
      }

      const decision = await promptPermission(ctx, {
        requestId: event.toolCallId,
        source: "tool_call",
        agentName,
        message,
        toolCallId: event.toolCallId,
        toolName,
        ...permissionLogContext,
      });
      if (!decision.approved) {
        return { block: true, reason: formatUserDeniedReason(check, decision.denialReason) };
      }
    }

    return {};
  });
}
