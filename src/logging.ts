import { appendFile } from "node:fs/promises";

import {
  EXTENSION_ID,
  ensurePermissionSystemLogsDirectory,
  getPermissionSystemDebugLogPath,
  getPermissionSystemReviewLogPath,
  type PermissionSystemExtensionConfig,
} from "./extension-config.js";

export function safeJsonStringify(value: unknown): string | undefined {
  const seen = new WeakSet<object>();
  return JSON.stringify(value, (_key, currentValue) => {
    if (currentValue instanceof Error) {
      return {
        name: currentValue.name,
        message: currentValue.message,
        stack: currentValue.stack,
      };
    }

    if (typeof currentValue === "bigint") {
      return currentValue.toString();
    }

    if (typeof currentValue === "object" && currentValue !== null) {
      if (seen.has(currentValue)) {
        return "[Circular]";
      }
      seen.add(currentValue);
    }

    return currentValue;
  });
}

export interface PermissionSystemLogger {
  debug: (event: string, details?: Record<string, unknown>) => string | undefined;
  review: (event: string, details?: Record<string, unknown>) => string | undefined;
  flush: () => Promise<void>;
}

interface PermissionSystemLoggerOptions {
  getConfig: () => PermissionSystemExtensionConfig;
  debugLogPath?: string;
  reviewLogPath?: string;
  ensureLogsDirectory?: () => string | undefined;
}

function redactReviewDetails(details: Record<string, unknown>): Record<string, unknown> {
  if (typeof details.command !== "string") {
    return details;
  }

  return {
    ...details,
    command: null,
  };
}

export function createPermissionSystemLogger(options: PermissionSystemLoggerOptions): PermissionSystemLogger {
  const getDebugLogPath = (): string => options.debugLogPath ?? getPermissionSystemDebugLogPath();
  const getReviewLogPath = (): string => options.reviewLogPath ?? getPermissionSystemReviewLogPath();
  const ensureLogsDirectory = options.ensureLogsDirectory ?? (() => ensurePermissionSystemLogsDirectory());
  let writeQueue: Promise<void> = Promise.resolve();

  const enqueueAppend = (path: string, line: string): void => {
    writeQueue = writeQueue.then(
      () => appendFile(path, `${line}\n`, "utf-8"),
      () => appendFile(path, `${line}\n`, "utf-8"),
    );
    void writeQueue.catch(() => {
      // Permission-system logging must never write to stdout/stderr or interrupt permission handling.
    });
  };

  const writeLine = (stream: "debug" | "review", path: string, event: string, details: Record<string, unknown>): string | undefined => {
    const directoryError = ensureLogsDirectory();
    if (directoryError) {
      return directoryError;
    }

    try {
      const line = safeJsonStringify({
        timestamp: new Date().toISOString(),
        extension: EXTENSION_ID,
        stream,
        event,
        ...details,
      });
      if (!line) {
        return `Failed to write permission-system ${stream} log '${path}': event could not be serialized.`;
      }
      enqueueAppend(path, line);
      return undefined;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return `Failed to write permission-system ${stream} log '${path}': ${message}`;
    }
  };

  const debug = (event: string, details: Record<string, unknown> = {}): string | undefined => {
    if (!options.getConfig().debugLog) {
      return undefined;
    }

    return writeLine("debug", getDebugLogPath(), event, details);
  };

  const review = (event: string, details: Record<string, unknown> = {}): string | undefined => {
    const config = options.getConfig();
    if (!config.permissionReviewLog) {
      return undefined;
    }

    const reviewDetails = config.logPlaintextBashCommands ? details : redactReviewDetails(details);
    return writeLine("review", getReviewLogPath(), event, reviewDetails);
  };

  const flush = (): Promise<void> => writeQueue.catch(() => undefined);

  return { debug, review, flush };
}
