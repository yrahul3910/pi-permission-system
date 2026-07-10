import assert from "node:assert/strict";

// Imports the real config-modal module: it pulls pi-tui/pi-coding-agent values
// only through zellij-modal, which is import-safe, and the settings modal
// renderer is never invoked here (the custom() stub below does not run it), so
// no module mocking is required to run under bun.
import { registerPermissionSystemCommand } from "../src/config-modal.js";
import type { PermissionSystemExtensionConfig } from "../src/extension-config.js";
import { runAsyncTest, runTest } from "./test-harness.js";

type Notification = { message: string; level: "info" | "warning" | "error" };

type RegisteredCommandDefinition = {
  description: string;
  getArgumentCompletions?: (argumentPrefix: string) => Array<{ value: string; label: string; description?: string }> | null;
  handler: (args: string, ctx: CommandContextStub) => Promise<void>;
};

type CommandContextStub = {
  hasUI: boolean;
  ui: {
    notify(message: string, level: "info" | "warning" | "error"): void;
    custom<T>(renderer: (...args: unknown[]) => unknown, options?: unknown): Promise<T>;
  };
};

function createCommandContext(
  hasUI: boolean,
): { ctx: CommandContextStub; notifications: Notification[]; getCustomCalls(): number } {
  const notifications: Notification[] = [];
  let customCalls = 0;

  return {
    ctx: {
      hasUI,
      ui: {
        notify(message: string, level: "info" | "warning" | "error") {
          notifications.push({ message, level });
        },
        async custom<T>(_renderer: (...args: unknown[]) => unknown, _options?: unknown): Promise<T> {
          customCalls += 1;
          return undefined as T;
        },
      },
    },
    notifications,
    getCustomCalls: () => customCalls,
  };
}

function lastNotification(notifications: Notification[]): Notification {
  return notifications[notifications.length - 1] as Notification;
}

function getRegisteredDefinition(definition: RegisteredCommandDefinition | null): RegisteredCommandDefinition {
  assert.ok(definition !== null);
  return definition;
}

function registerForTest(config: PermissionSystemExtensionConfig): RegisteredCommandDefinition {
  let definition: RegisteredCommandDefinition | null = null;

  registerPermissionSystemCommand(
    {
      registerCommand(_name: string, nextDefinition: RegisteredCommandDefinition) {
        definition = nextDefinition;
      },
    } as never,
    {
      getConfig: () => config,
      setConfig: (next: PermissionSystemExtensionConfig) => {
        config = next;
      },
      getConfigPath: () => "C:/tmp/pi-permission-system/config.json",
    } as never,
  );

  return getRegisteredDefinition(definition);
}

runTest("permission-system command exposes no subcommand completions", () => {
  const registeredDefinition = registerForTest({
    debug: false,
    yoloMode: false,
    desktopNotifications: true,
  });

  assert.equal(registeredDefinition.getArgumentCompletions, undefined);
});

await runAsyncTest("permission-system command only opens the settings modal", async () => {
  const config: PermissionSystemExtensionConfig = {
    debug: true,
    yoloMode: true,
    desktopNotifications: false,
  };
  const registeredDefinition = registerForTest(config);

  assert.ok(registeredDefinition.description.includes("Configure pi-permission-system"));

  const headlessCtx = createCommandContext(false);
  await registeredDefinition.handler("", headlessCtx.ctx);
  assert.equal(lastNotification(headlessCtx.notifications).message, "/permission-system requires interactive TUI mode.");
  assert.equal(headlessCtx.getCustomCalls(), 0);

  const modalCtx = createCommandContext(true);
  await registeredDefinition.handler("", modalCtx.ctx);
  assert.equal(modalCtx.getCustomCalls(), 1);
  assert.equal(modalCtx.notifications.length, 0);

  const subcommandCtx = createCommandContext(true);
  await registeredDefinition.handler("yolo off", subcommandCtx.ctx);
  await registeredDefinition.handler("show", subcommandCtx.ctx);
  await registeredDefinition.handler("reset", subcommandCtx.ctx);
  assert.equal(subcommandCtx.getCustomCalls(), 3);
  assert.equal(subcommandCtx.notifications.length, 0);
  assert.deepEqual(config, {
    debug: true,
    yoloMode: true,
    desktopNotifications: false,
  });
});

console.log("All permission-system config-modal tests passed.");
