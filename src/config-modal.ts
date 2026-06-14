import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { SettingItem } from "@earendil-works/pi-tui";

import type { PermissionSystemExtensionConfig } from "./extension-config.js";
import { ZellijModal, ZellijSettingsModal } from "./zellij-modal.js";

interface PermissionSystemConfigController {
  getConfig(): PermissionSystemExtensionConfig;
  setConfig(next: PermissionSystemExtensionConfig, ctx: ExtensionCommandContext): void;
  getConfigPath(): string;
}

interface SettingValueSyncTarget {
  updateValue(id: string, value: string): void;
}

const ON_OFF = ["on", "off"];

function toOnOff(value: boolean): string {
  return value ? "on" : "off";
}

function buildSettingItems(config: PermissionSystemExtensionConfig): SettingItem[] {
  return [
    {
      id: "debug",
      label: "Debug logging",
      description: "Write diagnostics and permission review entries to the extension debug file",
      currentValue: toOnOff(config.debug),
      values: ON_OFF,
    },
    {
      id: "yoloMode",
      label: "YOLO mode",
      description: "Auto-approve ask-state permission checks, including subagent approval forwarding",
      currentValue: toOnOff(config.yoloMode),
      values: ON_OFF,
    },
  ];
}

function applySetting(
  config: PermissionSystemExtensionConfig,
  id: string,
  value: string,
): PermissionSystemExtensionConfig {
  switch (id) {
    case "debug":
      return { ...config, debug: value === "on" };
    case "yoloMode":
      return { ...config, yoloMode: value === "on" };
    default:
      return config;
  }
}

function syncSettingValues(settingsList: SettingValueSyncTarget, config: PermissionSystemExtensionConfig): void {
  settingsList.updateValue("debug", toOnOff(config.debug));
  settingsList.updateValue("yoloMode", toOnOff(config.yoloMode));
}

export async function openPermissionSystemSettingsModal(ctx: ExtensionCommandContext, controller: PermissionSystemConfigController): Promise<void> {
  const overlayOptions = { anchor: "center" as const, width: 82, maxHeight: "85%" as const, margin: 1 };

  await ctx.ui.custom<void>(
    (tui, theme, _keybindings, done) => {
      let current = controller.getConfig();
      let settingsModal: ZellijSettingsModal | null = null;

      settingsModal = new ZellijSettingsModal(
        {
          title: "Permission System Settings",
          description: "Local extension options for debug logging and auto-approval behavior",
          settings: buildSettingItems(current),
          onChange: (id, newValue) => {
            current = applySetting(current, id, newValue);
            controller.setConfig(current, ctx);
            current = controller.getConfig();
            if (settingsModal) {
              syncSettingValues(settingsModal, current);
            }
          },
          onClose: () => done(),
          helpText: `Config file: ${controller.getConfigPath()}`,
          enableSearch: true,
        },
        theme,
      );

      const modal = new ZellijModal(
        settingsModal,
        {
          borderStyle: "rounded",
          titleBar: {
            left: "Permission System Settings",
            right: "pi-permission-system",
          },
          helpUndertitle: {
            text: "Esc: close | ↑↓: navigate | Space: toggle",
            color: "dim",
          },
          overlay: overlayOptions,
        },
        theme,
      );

      return {
        render(width: number) {
          return modal.renderModal(width).lines;
        },
        invalidate() {
          modal.invalidate();
        },
        handleInput(data: string) {
          modal.handleInput(data);
          tui.requestRender();
        },
      };
    },
    { overlay: true, overlayOptions },
  );
}

export function registerPermissionSystemCommand(pi: ExtensionAPI, controller: PermissionSystemConfigController): void {
  pi.registerCommand("permission-system", {
    description: "Configure pi-permission-system debug logging and yolo-mode behavior",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("/permission-system requires interactive TUI mode.", "warning");
        return;
      }

      await openPermissionSystemSettingsModal(ctx, controller);
    },
  });
}
