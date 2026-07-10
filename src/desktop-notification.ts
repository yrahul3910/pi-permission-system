import { spawn, spawnSync } from "node:child_process";

/**
 * Desktop notifications + terminal focus tracking for pi-permission-system.
 *
 * Focus tracking uses the DEC private mode 1004 "focus reporting" escape
 * sequence. When enabled, terminals emit `ESC [ I` when the window/tab gains
 * focus and `ESC [ O` when it loses focus. We observe these via the extension
 * `onTerminalInput` hook and strip them so they never leak into the editor.
 *
 * IMPORTANT for tmux users: tmux only forwards focus events to the running
 * program when `focus-events` is enabled in the tmux config:
 *
 *     set -g focus-events on
 *
 * Ghostty (and most modern terminals) support focus reporting natively, so with
 * that tmux option set the full chain Ghostty -> tmux -> pi works. Without it,
 * tmux swallows the focus events and this module conservatively assumes the tab
 * is focused (so it simply never fires a "background" notification rather than
 * firing spuriously).
 *
 * Desktop notifications are delivered by spawning the platform notifier
 * (osascript / notify-send / PowerShell). This intentionally bypasses the
 * terminal + tmux entirely, so tmux passthrough configuration is not required
 * for the notification itself, only for focus detection.
 */

const ENABLE_FOCUS_REPORTING = "\x1b[?1004h";
const DISABLE_FOCUS_REPORTING = "\x1b[?1004l";

// Focus-in / focus-out sequences. Some terminals also emit the SS3 form
// (ESC O I / ESC O O), so we match both CSI and SS3 introducers.
const FOCUS_EVENT_REGEX = /\x1b[\[O]([IO])/g;

export type NotificationSender = (title: string, message: string) => void;

export interface TerminalFocusTrackerOptions {
  /** Registers a raw terminal input observer. Return value unsubscribes. */
  onTerminalInput?: (
    handler: (
      data: string,
    ) => { consume?: boolean; data?: string } | undefined,
  ) => () => void;
  /** Writes a raw control sequence to the terminal (defaults to process.stdout). */
  write?: (data: string) => void;
}

export interface TerminalFocusTracker {
  /** Whether the terminal tab/window currently has focus. */
  isFocused(): boolean;
  /** Whether we have observed at least one real focus event from the terminal. */
  hasObservedFocusEvents(): boolean;
  /** Tear down: stop observing input and disable focus reporting. */
  dispose(): void;
}

/**
 * Starts tracking terminal focus. Safe to call when `onTerminalInput` is
 * unavailable (e.g. non-TUI mode) — in that case the tracker reports "focused"
 * and observes nothing.
 */
export function startTerminalFocusTracker(
  options: TerminalFocusTrackerOptions,
): TerminalFocusTracker {
  const write =
    options.write ??
    ((data: string) => {
      try {
        process.stdout.write(data);
      } catch {
        // Terminal output is best-effort; ignore write failures.
      }
    });

  // Default to focused so we never notify until we actually see a focus-out.
  let focused = true;
  let observedFocusEvents = false;
  let unsubscribe: (() => void) | null = null;
  let disposed = false;

  if (typeof options.onTerminalInput === "function") {
    write(ENABLE_FOCUS_REPORTING);

    unsubscribe = options.onTerminalInput((data) => {
      if (!data.includes("\x1b")) {
        return undefined;
      }

      let sawFocusEvent = false;
      FOCUS_EVENT_REGEX.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = FOCUS_EVENT_REGEX.exec(data)) !== null) {
        sawFocusEvent = true;
        observedFocusEvents = true;
        focused = match[1] === "I";
      }

      if (!sawFocusEvent) {
        return undefined;
      }

      // Strip focus events so they never reach the editor. If the chunk was
      // nothing but focus events, consume it entirely.
      const stripped = data.replace(FOCUS_EVENT_REGEX, "");
      if (stripped.length === 0) {
        return { consume: true };
      }

      return { data: stripped };
    });
  }

  return {
    isFocused: () => focused,
    hasObservedFocusEvents: () => observedFocusEvents,
    dispose: () => {
      if (disposed) {
        return;
      }
      disposed = true;
      if (unsubscribe) {
        try {
          unsubscribe();
        } catch {
          // ignore
        }
        unsubscribe = null;
      }
      write(DISABLE_FOCUS_REPORTING);
    },
  };
}

function spawnDetached(
  command: string,
  args: readonly string[],
  input?: string,
): void {
  try {
    const child = spawn(command, args, {
      stdio:
        input === undefined ? "ignore" : ["pipe", "ignore", "ignore"],
      detached: true,
      windowsHide: true,
    });
    child.on("error", () => {
      // Notifier binary missing or failed to launch; silently ignore.
    });
    if (input !== undefined && child.stdin) {
      try {
        child.stdin.end(input);
      } catch {
        // ignore
      }
    }
    child.unref();
  } catch {
    // Spawning failed (e.g. sandboxed environment); ignore.
  }
}

let cachedTerminalNotifierPath: string | null | undefined;

/**
 * Resolves the absolute path to `terminal-notifier` if it is installed, or null.
 * Result is cached for the process lifetime.
 *
 * terminal-notifier is preferred over `osascript` on macOS because osascript
 * posts notifications as "Script Editor": clicking one launches Script Editor
 * (which opens a file-picker dialog), and Script Editor must be granted
 * notification permission. terminal-notifier carries its own notification
 * identity and a click simply dismisses it.
 */
function resolveTerminalNotifierPath(): string | null {
  if (cachedTerminalNotifierPath !== undefined) {
    return cachedTerminalNotifierPath;
  }

  try {
    const result = spawnSync("command", ["-v", "terminal-notifier"], {
      shell: true,
      encoding: "utf-8",
    });
    const path =
      result.status === 0 && typeof result.stdout === "string"
        ? result.stdout.trim()
        : "";
    cachedTerminalNotifierPath = path.length > 0 ? path : null;
  } catch {
    cachedTerminalNotifierPath = null;
  }

  return cachedTerminalNotifierPath;
}

function escapeForAppleScript(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function escapeForPowerShell(value: string): string {
  return value.replace(/'/g, "''");
}

/**
 * Sends a desktop notification using the platform-native notifier. Best-effort:
 * failures are swallowed so a missing notifier never disrupts the agent.
 */
export const sendDesktopNotification: NotificationSender = (title, message) => {
  const platform = process.platform;

  if (platform === "darwin") {
    // Prefer terminal-notifier when available: unlike osascript it does not
    // hijack clicks into Script Editor's open-file dialog and does not depend
    // on Script Editor's notification permission.
    const terminalNotifierPath = resolveTerminalNotifierPath();
    if (terminalNotifierPath) {
      spawnDetached(terminalNotifierPath, [
        "-title",
        title,
        "-message",
        message,
        // Reactivate the terminal on click instead of opening a file.
        "-activate",
        process.env.__CFBundleIdentifier || "com.mitchellh.ghostty",
      ]);
      return;
    }

    const script = `display notification "${escapeForAppleScript(message)}" with title "${escapeForAppleScript(title)}"`;
    spawnDetached("osascript", ["-e", script]);
    return;
  }

  if (platform === "win32") {
    const script = [
      "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null;",
      "[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] > $null;",
      "$template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02);",
      "$texts = $template.GetElementsByTagName('text');",
      `$texts.Item(0).AppendChild($template.CreateTextNode('${escapeForPowerShell(title)}')) > $null;`,
      `$texts.Item(1).AppendChild($template.CreateTextNode('${escapeForPowerShell(message)}')) > $null;`,
      "$toast = [Windows.UI.Notifications.ToastNotification]::new($template);",
      "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('pi').Show($toast);",
    ].join(" ");
    spawnDetached("powershell", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      script,
    ]);
    return;
  }

  // Linux / BSD: prefer notify-send.
  spawnDetached("notify-send", ["--app-name=pi", title, message]);
};
