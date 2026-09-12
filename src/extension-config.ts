import { randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { applyEdits, modify, parseTree } from "jsonc-parser";

import { toRecord } from "./common.js";
import {
  formatJsoncConfigLoadWarning,
  isNodeErrorWithCode,
  parseJsoncConfig,
} from "./jsonc-config.js";

export const EXTENSION_ID = "pi-permission-system";

export interface PermissionSystemExtensionConfig {
  /** Master switch. When false, the extension skips all registrations and startup work. */
  enabled?: boolean;
  debug: boolean;
  yoloMode: boolean;
  /** Allow YOLO to skip protected-path checks; explicit policy denies still apply. */
  yoloBypassProtectedPaths: boolean;
  desktopNotifications: boolean;
  forwardedPromptTimeoutSeconds: number | null;
}

export interface PermissionSystemConfigLoadResult {
  config: PermissionSystemExtensionConfig;
  created: boolean;
  warning?: string;
}

export interface PermissionSystemConfigSaveResult {
  success: boolean;
  error?: string;
}

export const DEFAULT_EXTENSION_CONFIG: PermissionSystemExtensionConfig = {
  enabled: true,
  debug: false,
  yoloMode: false,
  yoloBypassProtectedPaths: false,
  desktopNotifications: true,
  forwardedPromptTimeoutSeconds: 600,
};

export function resolveExtensionRoot(moduleUrl = import.meta.url): string {
  return join(dirname(fileURLToPath(moduleUrl)), "..");
}

export const EXTENSION_ROOT = resolveExtensionRoot();
export const CONFIG_PATH = join(getAgentDir(), "pi-permissions.jsonc");
export const LOGS_DIR = join(EXTENSION_ROOT, "logs");
export const CONFIG_PATH_ENV_KEY = "PI_PERMISSION_SYSTEM_CONFIG_PATH";
export const LOGS_DIR_ENV_KEY = "PI_PERMISSION_SYSTEM_LOGS_DIR";

function resolveOverridablePath(
  explicitValue: string | undefined,
  envKey: string,
  defaultValue: string,
): string {
  const overridePath = process.env[envKey]?.trim();
  return explicitValue || overridePath || defaultValue;
}

/** Resolve the user settings file, honoring explicit and router policy paths. */
export function getPermissionSystemConfigPath(configPath?: string): string {
  const agentDir =
    process.env.PI_PERMISSION_SYSTEM_POLICY_AGENT_DIR?.trim() || getAgentDir();
  return resolveOverridablePath(
    configPath,
    CONFIG_PATH_ENV_KEY,
    join(agentDir, "pi-permissions.jsonc"),
  );
}

export function getPermissionSystemLogsDir(logsDir?: string): string {
  return resolveOverridablePath(logsDir, LOGS_DIR_ENV_KEY, LOGS_DIR);
}

export function getPermissionSystemDebugPath(
  logsDir = getPermissionSystemLogsDir(),
): string {
  return join(logsDir, `${EXTENSION_ID}-debug.jsonl`);
}

export function cloneDefaultConfig(): PermissionSystemExtensionConfig {
  return {
    enabled: DEFAULT_EXTENSION_CONFIG.enabled,
    debug: DEFAULT_EXTENSION_CONFIG.debug,
    yoloMode: DEFAULT_EXTENSION_CONFIG.yoloMode,
    yoloBypassProtectedPaths: DEFAULT_EXTENSION_CONFIG.yoloBypassProtectedPaths,
    desktopNotifications: DEFAULT_EXTENSION_CONFIG.desktopNotifications,
    forwardedPromptTimeoutSeconds:
      DEFAULT_EXTENSION_CONFIG.forwardedPromptTimeoutSeconds,
  };
}

/** Parse optional JSONC settings, using defaults for missing or invalid values. */
export function normalizePermissionSystemConfig(
  raw: unknown,
): PermissionSystemExtensionConfig {
  const record = toRecord(raw);
  const rawTimeout = record.forwardedPromptTimeoutSeconds;
  let forwardedPromptTimeoutSeconds: number | null =
    DEFAULT_EXTENSION_CONFIG.forwardedPromptTimeoutSeconds;

  if (rawTimeout === null || rawTimeout === false) {
    forwardedPromptTimeoutSeconds = null;
  } else if (Value.Check(Type.Number({ exclusiveMinimum: 0 }), rawTimeout)) {
    forwardedPromptTimeoutSeconds = rawTimeout;
  }

  return {
    enabled: record.enabled !== false,
    debug: record.debug === true,
    yoloMode: record.yoloMode === true,
    yoloBypassProtectedPaths: record.yoloBypassProtectedPaths === true,
    // Defaults to enabled; only an explicit `false` turns it off.
    desktopNotifications: record.desktopNotifications !== false,
    forwardedPromptTimeoutSeconds,
  };
}

function ensureConfigDirectory(configPath: string): void {
  mkdirSync(dirname(configPath), { recursive: true });
}

/** Create the user settings file when missing; existing permission rules remain untouched. */
export function ensurePermissionSystemConfig(
  configPath = getPermissionSystemConfigPath(),
) {
  if (existsSync(configPath)) return { created: false };

  const saved = saveConfigFields(DEFAULT_EXTENSION_CONFIG, configPath);
  return { created: saved.success, warning: saved.error };
}

/** Read extension settings from the user permission file, using defaults for absent fields. */
export function loadPermissionSystemConfig(
  configPath = getPermissionSystemConfigPath(),
): PermissionSystemConfigLoadResult {
  const ensureResult = ensurePermissionSystemConfig(configPath);

  try {
    const raw = readFileSync(configPath, "utf-8");
    const parsed = parseJsoncConfig(
      raw,
      configPath,
      "permission-system config",
    );
    const config = normalizePermissionSystemConfig(parsed);
    return {
      config,
      created: ensureResult.created,
      warning: ensureResult.warning,
    };
  } catch (error) {
    return {
      config: cloneDefaultConfig(),
      created: ensureResult.created,
      warning:
        ensureResult.warning ??
        formatJsoncConfigLoadWarning(
          configPath,
          error,
          "permission-system config",
          "using default extension config",
        ) ??
        undefined,
    };
  }
}

/**
 * Reads the existing config file and returns a parsed object plus a flag
 * indicating whether the file was readable and parseable.
 *
 * - A missing file returns a null record and empty-object JSONC content.
 * - parseError is true for unreadable, malformed, or non-object roots.
 *   The caller MUST NOT overwrite a corrupt file with only extension defaults.
 */
function readExistingConfig(configPath: string) {
  if (!existsSync(configPath)) {
    return { record: null, content: "{}\n", parseError: false };
  }

  try {
    const raw = readFileSync(configPath, "utf-8");
    // Strip a UTF-8 BOM if present so the JSONC parser can handle it.
    const bomStripped = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
    const parsed = parseJsoncConfig(
      bomStripped,
      configPath,
      "permission-system config",
    );
    const record = toRecord(parsed);
    return { record, content: bomStripped, parseError: record !== parsed };
  } catch {
    return { record: null, content: "", parseError: true };
  }
}

/**
 * Resolves the actual write target. If configPath is a symlink, returns the
 * realpath so that the symlink relationship is preserved (we write through to
 * the target instead of replacing the symlink with a regular file).
 */
function resolveWriteTarget(configPath: string): {
  writePath: string;
  isSymlink: boolean;
} {
  try {
    const stats = lstatSync(configPath);
    if (stats.isSymbolicLink()) {
      const realPath = realpathSync(configPath);
      return { writePath: realPath, isSymlink: true };
    }
  } catch (error) {
    // A missing file is expected (first write); any other lstat/realpath failure
    // falls through to writing configPath directly as a safe default.
    if (!isNodeErrorWithCode(error, "ENOENT")) {
      return { writePath: configPath, isSymlink: false };
    }
  }
  return { writePath: configPath, isSymlink: false };
}

/** Save synced settings while leaving the startup YOLO default and all permission rules untouched. */
export function savePermissionSystemConfig(
  config: PermissionSystemExtensionConfig,
  configPath = getPermissionSystemConfigPath(),
): PermissionSystemConfigSaveResult {
  const normalized = normalizePermissionSystemConfig(config);
  return saveConfigFields(
    {
      debug: normalized.debug,
      yoloBypassProtectedPaths: normalized.yoloBypassProtectedPaths,
      desktopNotifications: normalized.desktopNotifications,
      forwardedPromptTimeoutSeconds: normalized.forwardedPromptTimeoutSeconds,
    },
    configPath,
  );
}

/** Update only the supplied JSONC fields atomically, preserving comments, rules, and symlinks. */
function saveConfigFields(
  fields: Partial<PermissionSystemExtensionConfig>,
  configPath: string,
): PermissionSystemConfigSaveResult {
  // Read the existing file to preserve all non-extension keys.
  const existing = readExistingConfig(configPath);

  if (existing.parseError) {
    // The file exists but cannot be parsed. We MUST NOT overwrite it with
    // only the extension fields, as that would destroy potentially salvageable
    // permission data. Return a failure so the caller can inform the user.
    return {
      success: false,
      error: `Refusing to save permission-system config at '${configPath}': the existing file is corrupt or unparseable. Manual intervention is required to preserve existing permission data.`,
    };
  }

  let content = existing.content;
  const formattingOptions = { insertSpaces: true, tabSize: 2, eol: "\n" };
  for (const [key, value] of Object.entries(fields)) {
    const values = (parseTree(content)?.children ?? [])
      .filter((property) => property.children?.[0]?.value === key)
      .flatMap((property) => property.children?.slice(1) ?? []);
    const edits =
      values.length > 0
        ? values.map((node) => ({
            offset: node.offset,
            length: node.length,
            content: JSON.stringify(value),
          }))
        : modify(content, [key], value, { formattingOptions });
    content = applyEdits(content, edits);
  }
  for (const key of ["__proto__", "constructor", "prototype"]) {
    if (Object.hasOwn(existing.record ?? {}, key)) {
      content = applyEdits(
        content,
        modify(content, [key], undefined, { formattingOptions }),
      );
    }
  }

  // Resolve the write target (handle symlinks by writing through to the real path).
  const { writePath } = resolveWriteTarget(configPath);
  const tmpPath = `${writePath}.${process.pid}.${randomUUID()}.tmp`;

  try {
    ensureConfigDirectory(writePath);
    writeFileSync(tmpPath, content, "utf-8");
    renameSync(tmpPath, writePath);
    return { success: true };
  } catch (error) {
    try {
      if (existsSync(tmpPath)) {
        unlinkSync(tmpPath);
      }
    } catch (cleanupError) {
      // Temp-file cleanup is best-effort; the OS will reclaim orphaned temp
      // files. Surface non-ENOENT failures so they are not silently lost.
      if (!isNodeErrorWithCode(cleanupError, "ENOENT")) {
        // Intentionally not propagated: the primary save error below is more
        // actionable to the caller than a leftover temp-file cleanup failure.
        void cleanupError;
      }
    }

    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      error: `Failed to save permission-system config at '${configPath}': ${message}`,
    };
  }
}

export function ensurePermissionSystemLogsDirectory(
  logsDir = getPermissionSystemLogsDir(),
): string | undefined {
  try {
    mkdirSync(logsDir, { recursive: true });
    return undefined;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `Failed to create permission-system log directory '${logsDir}': ${message}`;
  }
}
