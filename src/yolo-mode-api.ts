export interface YoloModeControlOptions {
  source?: string;
}

export interface YoloModeControlResult {
  yoloMode: boolean;
  changed: boolean;
  persisted: boolean;
  error?: string;
}

export interface PiPermissionSystemRuntimeApi {
  getYoloMode(): boolean;
  setYoloMode(
    enabled: boolean,
    options?: YoloModeControlOptions,
  ): YoloModeControlResult;
  toggleYoloMode(options?: YoloModeControlOptions): YoloModeControlResult;
}

const INTERACTIVE_RUNTIME_KEY = Symbol.for(
  "pi-permission-system.interactive-runtime",
);

interface InteractivePermissionRuntime {
  api: PiPermissionSystemRuntimeApi | null;
  forwardingSessionId: string | null;
  stopForwarding: (() => void) | null;
}

type GlobalWithPermissionSystemRuntimeApi = typeof globalThis & {
  __piPermissionSystem?: PiPermissionSystemRuntimeApi;
  [INTERACTIVE_RUNTIME_KEY]?: InteractivePermissionRuntime;
};

export function getInteractivePermissionRuntime(): InteractivePermissionRuntime {
  // Pi re-imports extensions when cwd changes. The owner must survive those
  // module instances without sharing each child's session-local YOLO setting.
  // SAFETY: This module owns the symbol-keyed runtime registration in this process.
  const globalScope = globalThis as GlobalWithPermissionSystemRuntimeApi;
  return (globalScope[INTERACTIVE_RUNTIME_KEY] ??= {
    api: null,
    forwardingSessionId: null,
    stopForwarding: null,
  });
}

export function registerPiPermissionSystemRuntimeApi(
  api: PiPermissionSystemRuntimeApi,
): PiPermissionSystemRuntimeApi {
  const globalScope = globalThis as GlobalWithPermissionSystemRuntimeApi;
  globalScope.__piPermissionSystem = api;
  return api;
}

export function unregisterPiPermissionSystemRuntimeApi(
  api?: PiPermissionSystemRuntimeApi,
): void {
  const globalScope = globalThis as GlobalWithPermissionSystemRuntimeApi;
  if (
    api !== undefined &&
    globalScope.__piPermissionSystem !== undefined &&
    globalScope.__piPermissionSystem !== api
  ) {
    return;
  }

  delete globalScope.__piPermissionSystem;
}

export function getPiPermissionSystemRuntimeApi(): PiPermissionSystemRuntimeApi | null {
  const globalScope = globalThis as GlobalWithPermissionSystemRuntimeApi;
  return globalScope.__piPermissionSystem ?? null;
}
