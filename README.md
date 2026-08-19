# pi-permission-system

## Important: read this

This is a fork of the pi-permission-system extension that's available on npm. This version makes a couple of changes:
* The built-in `read` tool will always ask for approval if .env is in the path, regardless of your config.
* Piped commands are handled a bit better: if all commands are in the allow-list, the command with pipes is allowed; if any of them are ask, it asks for permission.

The changes were mostly vibed using Opus 4.6. In my brief testing, it worked, but ymmv.

Below is the rest of the original README.

Permission enforcement extension for the Pi coding agent that provides centralized, deterministic permission gates for tool, bash, MCP, skill, and special operations.

<img width="1360" height="752" alt="image" src="https://github.com/user-attachments/assets/3e85190a-17fa-4d94-ac8e-efa54337df5d" />

## Coming from OpenCode?

Yes — this extension was designed so OpenCode-style agent permission policies can be ported into Pi with minimal friction.

### Start here

| If you have this in OpenCode | In Pi, use this |
|---|---|
| Agent markdown file | `~/.pi/agent/agents/<agent-name>.md` (respects `PI_CODING_AGENT_DIR`) |
| YAML frontmatter | Same place: top of the markdown file |
| Agent instructions / system prompt body | Same file, below frontmatter |
| Agent permission rules | `permission:` inside that same frontmatter |

### Important compatibility notes

- **Agents are still markdown files with YAML frontmatter.**
- **Wildcard permissions still use last-match-wins ordering.**
- **Resource-qualified path rules are supported for path-bearing tools.** Use action-scoped `tools` keys like `read:/home/alice/project/generated/*` and scoped special keys like `external_directory:/home/alice/shared/*` when you need OpenCode-style directory rules.
- **Keep frontmatter simple when porting.** This extension intentionally supports `key: value` scalars and nested maps, not full YAML features like arrays, anchors, or multiline scalars.

### Minimal Pi agent example

```md
---
name: my-agent
mode: primary
description: My ported agent
permission:
  tools:
    read: allow
    grep: allow
  bash:
    "*": ask
  mcp:
    "*": ask
---

Your agent instructions go here.
```

### Compatibility matrix

| OpenCode concept | Pi equivalent with this extension | Compatibility | Porting notes |
|---|---|---:|---|
| Agent markdown files with YAML frontmatter | `~/.pi/agent/agents/<agent-name>.md` | High | Your agent-local `permission:` frontmatter pattern carries over cleanly. |
| Wildcard precedence | Same last-declared-match-wins behavior | High | Broad rules first, specific overrides later. |
| `bash` permission rules | `permission.bash` | High | Command-pattern gating ports cleanly. |
| Per-tool permission rules like `read`, `grep`, `list`, `task`, or arbitrary extension tool names | `permission.tools` | Medium-High | Pi groups registered tool names under `tools`, including built-ins and extension tools. |
| `external_directory` | `permission.special.external_directory` or `permission.special.external_directory:<path>/*` | Medium-High | Coarse fallback stays supported; add resource-qualified rules for specific outside-worktree directories. |
| `doom_loop` | `permission.special.doom_loop` | Medium | Same idea, different location. |
| `skill` permission rules | `permission.skills` | Medium | Same purpose, but Pi uses a dedicated plural `skills` section. |
| MCP-related access | `permission.mcp` for proxy targets, `permission.tools` for direct registered tools | Medium | This is the biggest Pi-specific difference: proxy MCP targets and direct tool names are intentionally split. |
| OpenCode-specific permissions like `webfetch`, `websearch`, `question`, `lsp`, `todowrite` | Usually extension-specific Pi tool names under `permission.tools` | Low-Medium | These do not have universal built-in one-to-one Pi names; map them to the actual registered tools available in your Pi setup. |

### Most important difference

In OpenCode, many permission names live in one broad permission namespace. In Pi with this extension, there is a deliberate split:

| Use this when... | Put the rule here |
|---|---|
| You are targeting the registered **`mcp` proxy tool** and its internal server/tool targets | `permission.mcp` |
| You are targeting an actual registered tool name, including direct extension tools like `context7_*`, `github_*`, or `exa_*` | `permission.tools` |

### Fast porting guide

| If your OpenCode agent has... | In Pi, do this |
|---|---|
| `permission.bash` rules | Move them into `permission.bash` |
| `permission.external_directory` | Move it to `permission.special.external_directory` |
| `permission.doom_loop` | Move it to `permission.special.doom_loop` |
| `permission.skill` rules | Move them to `permission.skills` |
| Tool-ish permissions like `read`, `grep`, `list`, `task`, or third-party tool names | Put them in `permission.tools` |
| MCP server/tool target logic | Put proxy-target rules in `permission.mcp` |

### Practical takeaway

If you are coming from OpenCode, you usually do **not** need to rewrite your whole agent. In most cases, porting is just:

1. Keep the agent markdown/frontmatter structure.
2. Move OpenCode-style tool permissions into Pi's `tools` section.
3. Move `external_directory` and `doom_loop` into `special`.
4. Split MCP proxy target rules into `mcp` and direct registered tool rules into `tools`.

## Features

- **Tool Filtering** — Hides disallowed tools from the agent before it starts (reduces "try another tool" behavior)
- **System Prompt Sanitization** — Removes denied tool entries from the `Available tools:` system prompt section so the agent only sees tools it can actually call
- **Runtime Enforcement** — Blocks/asks/allows at tool call time with UI confirmation dialogs and readable approval summaries
- **Bash Command Decomposition** — Every bash invocation is parsed with the canonical bash grammar (mvdan-sh) and decomposed into the commands it actually executes (including inside `$(...)`, backticks, `bash -c` strings, and wrappers like `timeout`/`env`/`xargs`) and the files it reads and writes; each piece is evaluated on its own, so pipes and `&&` chains of allowed commands never prompt
- **Safe-Command Registry** — Read-only commands (`rg`, `cat`, `git log`, ...) are allowed out of the box by a declarative, overridable registry, so most agent traffic needs zero config; unsafe forms (`fd -x`, `sed -i`, `rg --pre`) fall out of the vouch and prompt
- **Protected Paths** — Secrets like `.env`, `.ssh/`, and `id_rsa*` are denied to every command by default — including via input redirection and `git show HEAD:.env` — outranking every allow rule
- **Session Family Approvals** — Approval prompts list exactly the blocking pieces and offer `Allow for this session: <families>`; approved families silence matching pieces of later compounds while everything else still gets checked
- **MCP Access Control** — Server and tool-level permissions for MCP operations
- **Skill Protection** — Controls which skills can be loaded or read from disk, including multi-block prompt sanitization and path-inferred reads under Pi skill directories
- **Per-Agent Overrides** — Agent-specific permission policies via YAML frontmatter
- **Subagent Permission Forwarding** — Forwards `ask` confirmations from non-UI subagents back to the main interactive session
- **Runtime YOLO Control** — Lets users toggle yolo mode from the settings modal and lets other extensions toggle it through the runtime API
- **Turn Runtime Indicator** — Adds active agent-run runtime to Pi's `Working...` spinner through tool calls, excluding time spent waiting for permission decisions
- **Thought Duration Annotation** — Adds a gray `Thought for <time>` line immediately before the final assistant response
- **File-Based Debug Logging** — Writes verbose diagnostics and permission request/denial review entries to one debug file when enabled in `config.json`, including the responsible agent and raw tool-call input
- **JSON Schema Validation** — Full schema for editor autocomplete and config validation
- **External Directory Guard** — Enforces `special.external_directory` for path-bearing file tools that target paths outside the active working directory

## Installation

### npm package

```bash
pi install npm:pi-permission-system
```

### Local extension folder

Place this folder in one of the following locations:

| Scope   | Path |
|---------|------|
| Global default | `~/.pi/agent/extensions/pi-permission-system` (respects `PI_CODING_AGENT_DIR`) |
| Project | `.pi/extensions/pi-permission-system` |

Pi auto-discovers extensions in these paths.

> **Tip:** All `~/.pi/agent` paths shown in this document are defaults. If the `PI_CODING_AGENT_DIR` environment variable is set, pi uses that directory instead. The extension automatically follows pi's `getAgentDir()` helper for extension installation, session directories, and extension-local config paths. If you need policy lookup to come from a different global agent root, set `PI_PERMISSION_SYSTEM_POLICY_AGENT_DIR`.

## Usage

### Quick Start

1. Create the global policy file at the Pi agent runtime root (default: `~/.pi/agent/pi-permissions.jsonc`, respects `PI_CODING_AGENT_DIR`):

```jsonc
{
  "defaultPolicy": {
    "tools": "ask",
    "bash": "ask",
    "mcp": "ask",
    "skills": "ask",
    "special": "ask"
  },
  "tools": {
    "read": "allow",
    "write": "deny"
  }
}
```

2. Start Pi — the extension automatically loads and enforces your policy.

### Permission States

All permissions use one of three states:

| State   | Behavior                                    |
|---------|---------------------------------------------|
| `allow` | Permits the action silently                 |
| `deny`  | Blocks the action with an error message     |
| `ask`   | Prompts the user for confirmation via UI    |

When an `ask` permission prompts, the confirmation UI offers `Allow Once`, `Allow Always`, `Reject`, and `Reject with Reason`. `Allow Once` approves only the current request. `Allow Always` records an explicit matching approval for the current session only (in-memory, not persisted to disk), while plain `Reject` and `Reject with Reason` deny only the current request and do not silently become future defaults. YOLO/auto-response approvals also do not create saved approval rules; after YOLO mode is disabled, matching `ask` requests require approval again. A configured `deny` remains a hard boundary and is not relaxed by prior one-shot, auto-response, or saved approvals.

For a bash prompt, the dialog additionally offers `Allow for this session: <families>` when every blocking piece is an ask with a clear plain-word command (for example `Allow for this session: wc` when approving `git log | wc -l`, or `Allow for this session: git push`). A family is the command word, extended to `<cmd> <subcommand>` for subcommand-structured tools (`git`, `gh`, `cargo`, `npm`, `uv`, ...). Choosing it records session-only allow prefixes that act exactly like config allow rules — which is safe by construction, because every piece of every later command is still evaluated individually: `wc $(evil)`, `wc > file`, and protected-path reads still prompt or deny. The families are always re-derived from the real evaluation of the command text before saving, never from a UI label or forwarded payload, and the option is omitted whenever any blocking piece is a deny, a write, a syntax finding, an opaque executable (`sudo`, `eval`, shells), or has no literal plain-word command.

### Pi Integration Hooks

The extension integrates via Pi's lifecycle hooks:

| Hook                 | Behavior                                                                                  |
|----------------------|-------------------------------------------------------------------------------------------|
| `before_agent_start` | Filters active tools, removes denied tool entries from the system prompt, and hides denied skills |
| `tool_call`          | Enforces permissions for every tool invocation                                            |
| `agent_start` / `agent_end` | Shows active runtime in Pi's `Working...` spinner until the final response is sent     |
| `message_end`        | Inserts the gray thought-duration annotation before a final assistant response            |
| `input`              | Tracks explicit `/skill:<name>` requests so user-invoked skill loads can proceed while agent-initiated reads remain policy-gated |

**Additional behaviors:**
- Unknown/unregistered tools are blocked before permission checks (prevents bypass attempts)
- The `Available tools:` system prompt section is rewritten to match the filtered active tool set
- Extension-provided tools like `task`, `mcp`, and third-party tools are handled through the same registered-tool permission layer instead of private built-in hardcodes
- When a subagent hits an `ask` permission without direct UI access, the request can be forwarded to the main interactive session for confirmation
- Generic extension-tool approval prompts include a bounded input preview; built-in file tools use concise human-readable summaries instead of raw multiline JSON
- Debug review entries include the responsible agent, raw prompt, raw tool-call input, command, target, and decision metadata for auditing.
- Path-bearing file tools (`read`, `write`, `edit`, `find`, `grep`, `ls`) evaluate `special.external_directory` before their normal tool permission when an explicit path points outside `ctx.cwd`
- `read` calls under global and project Pi skill directories are checked against `skills` policy even when the skill entry is inferred from the path rather than an active prompt block.
- Structured edit payloads are summarized by operation and line count in prompts so permission decisions do not require raw multiline JSON.
- The runtime spans tool-call turns and freezes while any local or forwarded permission decision is awaiting a response, so approval wait time is not counted.
- On Pi versions with entry-renderer support, a gray `Thought for <time>` annotation is inserted immediately before the final response without adding anything to LLM context.

## Configuration

### Extension Config File

**Location:** global Pi extension config (default: `~/.pi/agent/extensions/pi-permission-system/config.json`, respects `PI_CODING_AGENT_DIR`)

Set `PI_PERMISSION_SYSTEM_CONFIG_PATH` to point this extension at a specific config file when the default global path is not appropriate.

The extension creates this file automatically when it is missing. It controls extension-local debug logging behavior and yolo mode defaults:

```json
{
  "enabled": true,
  "debug": false,
  "yoloMode": false,
  "desktopNotifications": true
}
```

| Key | Default | Description |
|-----|---------|-------------|
| `enabled` | `true` | Master switch. When `false`, the extension skips all registrations and startup work (permission hooks, commands, runtime API, forwarding). |
| `debug` | `false` | Enables verbose diagnostics and permission review entries in `logs/pi-permission-system-debug.jsonl` |
| `yoloMode` | `false` | Startup default for yolo mode in new sessions. Runtime toggles (settings modal or runtime API) are session-scoped: they are never written back to this file and never propagate to other running sessions |
| `desktopNotifications` | `true` | Sends a native desktop notification when a permission prompt is waiting and this terminal tab is not focused |

Debug output writes only under the extension directory by default. Set `PI_PERMISSION_SYSTEM_LOGS_DIR` to redirect the debug file to a specific directory. No debug output is printed to the terminal.

### Desktop Notifications

When a tool call needs approval, the extension can pop a native desktop
notification so you are not left waiting on a tab you are not looking at.
Toggle it from the `/permission-system` settings modal or the `desktopNotifications`
config key.

Notifications are delivered with the platform-native notifier and therefore do
not depend on your terminal or multiplexer:

- **macOS** — [`terminal-notifier`](https://github.com/julienXX/terminal-notifier) if installed (recommended), otherwise `osascript` (Notification Center)
- **Linux/BSD** — `notify-send` (install `libnotify` if missing)
- **Windows** — PowerShell toast notification

> **Recommended on macOS: install `terminal-notifier`** (`brew install terminal-notifier`).
> When present, the extension uses it automatically. It is preferred over the
> `osascript` fallback because `osascript` posts notifications as "Script Editor":
> clicking one launches Script Editor's open-file dialog, and Script Editor must
> be granted notification permission in **System Settings → Notifications** or the
> notification is silently dropped. `terminal-notifier` has its own notification
> identity, and clicking a notification reactivates your terminal (e.g. Ghostty)
> instead of opening a file dialog.

**Focus detection.** To avoid notifying you when you *are* looking at the tab,
the extension enables terminal focus reporting (DEC private mode `1004`) and
watches for focus-in/out events. It only suppresses a notification once it has
positively observed that the tab is focused; if focus events never arrive, it
errs on the side of notifying.

> **tmux users (e.g. tmux inside Ghostty):** tmux only forwards focus events to
> pi when focus reporting is enabled in your tmux config. Add this to
> `~/.tmux.conf`:
>
> ```tmux
> set -g focus-events on
> ```
>
> Ghostty supports focus reporting natively, so with that option set the full
> chain (Ghostty -> tmux -> pi) works and off-tab detection is accurate. Without
> it, tmux swallows the focus events and the extension will notify on every
> waiting prompt regardless of which pane/window is active.

### Runtime YOLO Control

Use `/permission-system` to open the settings modal and inspect or change yolo mode interactively. In interactive TUI mode, the settings modal uses Pi's renderer-provided theme and does not require a separate global `initTheme()` call before opening.

Other extensions can toggle yolo mode immediately through the shared runtime API:

```ts
type PermissionSystemGlobal = typeof globalThis & {
  __piPermissionSystem?: {
    toggleYoloMode(options?: { source?: string }): { error?: string };
  };
};

pi.registerShortcut("f8", {
  description: "Toggle pi-permission-system YOLO mode",
  handler: () => {
    const permissionSystem = (globalThis as PermissionSystemGlobal).__piPermissionSystem;
    const result = permissionSystem?.toggleYoloMode({ source: "my-extension" });
    if (result?.error) {
      // Notify or log the error in your extension.
    }
  },
});
```

The runtime API exposes `getYoloMode()`, `setYoloMode(enabled, options?)`, and `toggleYoloMode(options?)`. Yolo mode is session-scoped: runtime updates apply to the current session's in-memory config only, are never written to `config.json`, and therefore never propagate to other sessions. Each new session starts from the `yoloMode` value in `config.json`, so edit the file by hand if you want yolo mode on by default.

### Global Policy File

**Location:** global Pi policy file (default: `~/.pi/agent/pi-permissions.jsonc`, respects `PI_PERMISSION_SYSTEM_POLICY_AGENT_DIR` when set and otherwise follows `PI_CODING_AGENT_DIR`)

The policy file is a JSON object with these sections:

| Section         | Description                                         |
|-----------------|-----------------------------------------------------|
| `defaultPolicy` | Fallback permissions per category                   |
| `tools`         | Pattern-based tool permissions for registered tools |
| `bash`          | Prefix rule lists (`allow`/`ask`/`deny`), syntax policy, and registry overrides |
| `protectedPaths` | Additional protected path patterns denied to every bash command |
| `mcp`           | MCP server/tool permissions for calls routed through a registered `mcp` tool |
| `skills`        | Skill name pattern permissions                      |
| `special`       | Reserved permission checks such as external directory access |

> **Note:** JSONC comments and trailing commas are supported. If parsing still fails, the extension falls back to `ask` for all categories and shows a warning in the TUI when available.

### Global Per-Agent Overrides

Override global permissions for specific agents via YAML frontmatter in the global Pi agents directory (default: `~/.pi/agent/agents/<agent-name>.md`, respects `PI_PERMISSION_SYSTEM_POLICY_AGENT_DIR` when set and otherwise follows `PI_CODING_AGENT_DIR`):

```yaml
---
name: my-agent
permission:
  tools:
    read: allow
    write: deny
    mcp: allow
  bash:
    allow: "cargo test, bun test"
    deny: "git push --force"
  mcp:
    chrome_devtools_*: deny
    exa_*: allow
  skills:
    "*": ask
---
```

**MCP behavior:** `permission.tools.mcp` is the coarse entry/fallback permission for a registered `mcp` tool when one is available. More specific `permission.mcp` target rules override that fallback when they match.

**Limitations:** The frontmatter parser is intentionally minimal. Use only `key: value` scalars and nested maps. Avoid arrays, multi-line scalars, and YAML anchors. If you are porting from OpenCode, simplify richer YAML frontmatter before expecting a clean migration.

### Project-Level Policy Files

The extension can also layer project-local permission files relative to the active session working directory:

| Scope | Path |
|-------|------|
| Project policy | `<cwd>/.pi/agent/pi-permissions.jsonc` |
| Project agent override | `<cwd>/.pi/agent/agents/<agent-name>.md` |

Project-local files use the same formats as the global policy file and global agent frontmatter. These project files are resolved from Pi's current session `cwd`, so they are workspace-specific and do **not** move under `PI_CODING_AGENT_DIR`.

**Precedence order:**
1. Global policy file
2. Project policy file
3. Global agent frontmatter
4. Project agent frontmatter

Later trusted layers override earlier layers within the same permission category, and project-local layers can tighten policy by adding `deny` rules. Project-local policy cannot relax a `deny` from the global policy file or global agent frontmatter: an `allow` or `ask` in a project policy is ignored when the latest matching trusted layer is `deny`. For wildcard-based sections like `tools`, `mcp`, `skills`, and `special`, matching still follows **last matching rule wins** within the applicable trust boundary, with global/system `deny` rules acting as floors for project-local overrides. Bash rule lists concatenate across layers and combine by rule type (`deny` > protected paths > `ask` > `allow`), so a project layer can add rules but a `deny` from any layer always wins.

---

## Policy Reference

### `defaultPolicy`

Sets fallback permissions when no specific rule matches:

```jsonc
{
  "defaultPolicy": {
    "tools": "ask",
    "bash": "ask",
    "mcp": "ask",
    "skills": "ask",
    "special": "ask"
  }
}
```

### `tools`

Controls tools by registered name pattern. This is the recommended standalone format for **all** tool entries, including Pi built-ins and arbitrary third-party extension tools. Patterns use `*` wildcards and follow last-declared-match semantics, so put broad fallbacks first and specific overrides later.

| Tool name example     | Description |
|-----------------------|-------------|
| `bash`                | Shell command execution (tool-level fallback before `bash` pattern rules) |
| `read` / `write`      | Canonical Pi built-in file tools |
| `mcp`                 | Registered MCP proxy tool entry/fallback when available |
| `task`                | Delegation tool handled like any other registered extension tool |
| `third_party_tool`    | Arbitrary registered extension tool |
| `context7_*`          | Wildcard for direct tools registered by another extension |
| `*`                   | Fallback for every registered tool not matched by a later rule |

```jsonc
{
  "tools": {
    "*": "ask",
    "context7_*": "ask",
    "third_party_tool": "ask",
    "mcp": "allow",
    "read": "allow",
    "write": "deny"
  }
}
```

Unknown or absent tools are not required in the config. If another extension is not installed, its tool simply will not be registered at runtime, and this extension will block attempts to call that missing tool before permission checks run. Wildcard `tools` rules apply to direct tools from any extension; no adapter-specific naming is required.

Path-bearing built-ins (`read`, `write`, `edit`, `find`, `grep`, `ls`) can also use action/resource keys in `tools` with normalized absolute paths. Use this when a tool should be allowed or denied only for a specific directory resource:

```jsonc
{
  "tools": {
    "read": "ask",
    "read:/home/alice/project/generated/*": "allow",
    "write": "deny"
  }
}
```

Action-scoped resource rules still respect normal permission guardrails: matching uses the same wildcard/last-match behavior as other tool rules, and outside-worktree paths must also satisfy the `special.external_directory` check.

> **Note:** Setting `tools.bash` affects the *default* for bash commands that nothing else matches; `bash` rules, the safe-command registry, and protected paths all take precedence over it.
>
> **Note:** Setting `tools.mcp` controls coarse access to a registered `mcp` proxy tool when one is available. Specific `mcp` rules still override it when a proxy target pattern matches. Direct MCP tools registered by extensions are regular registered tools and should be controlled with `tools` patterns such as `context7_*` or `github_*`.
>
> **Note:** Top-level shorthand is only supported for the canonical Pi built-ins (`bash`, `read`, `write`, `edit`, `grep`, `find`, `ls`) in agent frontmatter. Use `permission.tools.<name>` for `mcp`, `task`, and any third-party tool.

### `bash`

Bash permissions were redesigned around one idea: **a command is judged by what it actually does, not by what its string looks like.** Every invocation is parsed with the canonical bash grammar (via `mvdan-sh`) and decomposed into:

- the simple commands it executes — on either side of pipes and `&&`/`||`/`;` chains, inside `$(...)`/backtick/process substitutions, in loop and conditional bodies, inside `bash -c "..."` strings, and behind unwrapped wrappers (`env`, `timeout`, `nice`, `xargs`, `stdbuf`, `nohup`, `setsid`, `time`, `command`, and leading `VAR=x` assignments);
- the files it reads and writes through redirections (heredoc bodies are data, `2>&1`-style fd duplications and `/dev/null` are non-effects).

Each executed command is then resolved **individually**, in strict order:

1. a `deny` prefix rule matches → **deny**
2. any argv token or redirection target matches a protected path → **deny**
3. an `ask` prefix rule matches → **ask**
4. an `allow` prefix rule / session approval matches, or the built-in safe-command registry vouches → **allow**
5. otherwise → `defaultPolicy.bash` (`ask` out of the box)

Write redirection targets additionally need write permission (see below). The overall answer is the most restrictive across all pieces — and **when every piece resolves to allow, there is no prompt at all**: `rg foo | wc -l`, `git log --oneline | head`, `cmd >/dev/null 2>&1`, and `FOO=1 timeout 5 cargo test` run silently under an empty config.

Rules are **word-prefix lists**, not globs:

```jsonc
{
  "bash": {
    "allow": ["cargo clippy", "cargo test", "bun test", "uv run pytest"],
    "ask": ["git diff"],          // force a prompt even though the registry vouches
    "deny": ["git push --force"],
    "syntax": {                    // optional; these are the defaults
      // all default-denied constructs: `(...)`, `{ ...; }`,
      // function declarations, coprocesses
      "subshells": "deny",
      "unanalyzable": "ask"        // parse failures etc. (fails closed)
    },
    "registryOverrides": {}
  }
}
```

A rule matches when its words prefix the command's normalized argv: `"cargo test"` covers `cargo test --workspace`, `"rg"` covers any rg invocation. Quoting tricks don't evade matching (`cat .e''nv` normalizes to `cat .env`). In agent frontmatter, where the minimal YAML parser cannot express arrays, use a comma-separated string: `allow: "cargo test, bun test"`.

`sudo`, `doas`, `su`, `eval`, `exec`, `source`, and shells run on script files are **opaque**: they always prompt at minimum and cannot be covered by allow rules.

#### The safe-command registry

Most read-only commands need no config at all. A declarative registry (`src/safe-commands.ts`, reproduced under [Defaults](#bash-defaults)) **vouches** for the plain read-only invocation of common utilities. A row stops vouching when:

- an argument matches the row's `unsafeArgs` (`fd -x`, `sed -i`, `sort -o`, `find -exec`, `rg --pre`, ...), or an `unsafePatterns` regex (sed `e`-flag scripts);
- for subcommand-structured tools, the leading non-flag words don't start with a listed `safeSubcommands` word sequence (`git log` is vouched; `git push` is not).

An unvouched invocation is evaluated like any unknown command, with one guard: **an allow rule only covers an unsafe-argument invocation if the rule names the argument** — `"sed -i"` opts into in-place edits, plain `"sed"` does not. Unsafe-pattern and expansion-carrying invocations of restricted rows cannot be rule-covered at all; they always prompt.

#### Configuring `registryOverrides`

`registryOverrides` adjusts the registry per executable: `null` disables a built-in row, an object replaces or adds one (same fields: `safeSubcommands`, `unsafeArgs`, `unsafePatterns` as regex strings). It lives under the `bash` section of the global or project policy file:

```jsonc
// ~/.pi/agent/pi-permissions.jsonc
{
  "bash": {
    "registryOverrides": {
      // Disable a built-in row: sed loses its automatic vouch, so every sed
      // invocation is evaluated like an unknown command (your prefix rules,
      // then defaultPolicy.bash — i.e. it prompts under an empty config).
      "sed": null,

      // Add an unrestricted row for a command the registry doesn't know:
      // plain `bat` invocations are vouched read-only, so
      // `bat src/index.ts | head` runs without a prompt.
      "bat": {},

      // Add a restricted row: `yq` is vouched read-only, but in-place edits
      // void the vouch and prompt unless an allow rule names the flag
      // (`"yq -i"` would opt in, plain `"yq"` would not).
      "yq": { "unsafeArgs": ["-i", "--inplace"] },

      // Add a subcommand-structured row: only these read-only docker forms
      // are vouched; `docker run ...` still prompts.
      "docker": { "safeSubcommands": ["images", "inspect", "ps", "version"] },

      // An object REPLACES the built-in row wholesale, it does not merge
      // with it — to extend `jj` with `bookmark list`, restate the built-in
      // subcommands and unsafe args you want to keep:
      "jj": {
        "safeSubcommands": ["bookmark list", "diff", "file list", "file show", "log", "op log", "show", "status"],
        "unsafeArgs": ["--config", "--config-toml", "--config-file"]
      }
    }
  }
}
```

Notes:

- Keys are executable names (the command word after wrappers are unwrapped). Opaque executables (`sudo`, `eval`, shells on script files) cannot be made safe this way — they always prompt.
- A row only vouches for the plain read-only invocation; it never grants more. Deny rules, protected paths, and write-redirection policy still outrank a vouch, and rows with any restriction fields refuse to vouch for invocations carrying expansions like `$VAR`.
- `unsafePatterns` entries are regex strings (e.g. `"unsafePatterns": ["\\bsystem\\s*\\("]`) compiled at load; an invalid regex is skipped with a warning.
- Explicitly empty lists are treated as absent: `"cat": { "unsafeArgs": [] }` behaves like `"cat": {}`.
- Overrides merge per executable across policy layers (global → project → agent frontmatter), later layers winning per key. In practice, define them in the JSONC policy files: the minimal agent-frontmatter YAML parser cannot express the arrays or `null` values this section needs.

#### Write redirections

`>`-style redirection targets need write permission, resolved as: explicit `write:<path>` rules in `tools` → default temp-dir allowance (`/tmp`, `/private/tmp`, `$TMPDIR`, `/var/folders`) → the bare `write` tool state → ask. So out of the box `echo x > /tmp/scratch` runs silently while `echo x > src/index.ts` prompts, and `"write:./generated/*": "allow"` opens specific project paths.

### `protectedPaths`

Certain paths are secrets and are **denied to every bash command by default**, outranking every allow including the registry — covering plain arguments, input redirections (`tr x y < .env`), and repo-path forms (`git show HEAD:.env`). Patterns are globs matched against every argv token and redirection target, whole or per `/`- and `:`-segment. The built-in list (see [Defaults](#bash-defaults)) covers `.env` variants, `.ssh`/`.aws`/`.gnupg`/`.kube`/`.docker`, ssh keys, `*.pem`-style key files, shell history, and credential files. The top-level `protectedPaths` array appends to it:

```jsonc
{
  "protectedPaths": ["*.secret", "vault-*"]
}
```

Protected-path checks also see the **literal fragments** of arguments and redirect targets that contain expansions, so `cat "$HOME/.env"` and `tr x y < "$DIR/.env"` are denied even though the full path cannot be resolved statically. The residual limitation: a variable whose *entire value* names a protected file (`FILE=.env; cat $FILE`) cannot be caught without runtime dataflow — protected paths are a tripwire against accidental and casual access, not a sandbox. (Restricted registry rows already refuse to vouch for any invocation carrying expansions, and unknown commands with expansions still prompt.)

> **Migrating from the pre-redesign format:** glob maps like `"rg *": "allow"` and the `bashSafety` section are no longer read; loading a config that contains them logs a one-time warning with suggested prefix-rule replacements. Most old allow entries are simply covered by the registry and can be dropped; `.env`-style deny globs are covered by protected paths.

### Bash Defaults

Everything below ships built in and is what an **empty config** gives you. All of it is overridable ([`registryOverrides`](#configuring-registryoverrides), `protectedPaths`, `bash.syntax`, `write:<path>` rules).

**Registry — always vouched read-only (no restrictions):**

`basename`, `cat`, `cksum`, `cmp`, `column`, `comm`, `cut`, `df`, `diff`, `dirname`, `du`, `echo`, `expand`, `expr`, `false`, `file`, `fold`, `grep`, `head`, `hexdump`, `hostname`, `id`, `jq`, `ls`, `md5`, `md5sum`, `nl`, `od`, `printf`, `ps`, `pwd`, `readlink`, `realpath`, `seq`, `sha1sum`, `sha256sum`, `shasum`, `sleep`, `stat`, `strings`, `sw_vers`, `tail`, `test`, `tr`, `tree`, `true`, `type`, `uname`, `unexpand`, `uniq`, `uptime`, `wc`, `which`, `whoami`, `:`, `[`, `cd`, `export`, `hash`, `local`, `read`, `set`, `shift`, `unset`

**Registry — vouched with restrictions** (an unsafe argument or unlisted subcommand voids the vouch and the command prompts unless a rule explicitly names it):

| Command | Restrictions |
|---------|--------------|
| `date` | unsafe args: `-s`, `--set` |
| `sort` | unsafe args: `-o`, `--output` |
| `sed` | unsafe args: `-i`, `--in-place`; unsafe script patterns (execution expressions) |
| `rg` | unsafe args: `--pre`, `--hostname-bin` |
| `fd` | unsafe args: `-x`, `-X`, `--exec`, `--exec-batch` |
| `find` | unsafe args: `-exec`, `-execdir`, `-ok`, `-okdir`, `-delete`, `-fprintf`, `-fprint`, `-fprint0`, `-fls` |
| `git` | vouched subcommands: `blame`, `cat-file`, `describe`, `diff`, `grep`, `log`, `ls-files`, `ls-tree`, `reflog show`, `rev-list`, `rev-parse`, `shortlog`, `show`, `stash list`, `status`, `worktree list`; unsafe args: `-c`, `--exec-path`, `--ext-diff`, `--upload-pack`, `--receive-pack`, `--output`, `-o` |
| `jj` | vouched subcommands: `diff`, `file list`, `file show`, `log`, `op log`, `show`, `status`; unsafe args: `--config`, `--config-toml`, `--config-file` |

**Wrappers (unwrapped to the command they run):** `command`, `env`, `nice`, `nohup`, `setsid`, `stdbuf`, `time`, `timeout`, `xargs`, plus leading `VAR=x` assignments and `bash -c "..."` strings (parsed recursively).

**Opaque (always prompt, never rule-coverable):** `.`, `doas`, `eval`, `exec`, `source`, `su`, `sudo`.

**Subcommand-structured families (session approvals use `<cmd> <subcommand>`):** `bun`, `cargo`, `docker`, `gh`, `git`, `go`, `jj`, `kubectl`, `npm`, `npx`, `pip`, `pnpm`, `uv`, `uvx`, `yarn`.

**Protected paths (denied to every command):**

`.env`, `.env.*`, `*.env`, `.envrc`, `.netrc`, `.npmrc`, `.pypirc`, `id_rsa*`, `id_ed25519*`, `id_ecdsa*`, `id_dsa*`, `*.pem`, `*.p12`, `*.pfx`, `*.key`, `.ssh`, `.aws`, `.gnupg`, `.kube`, `.docker`, `*_history`, `.git-credentials`, `credentials`, `credentials.json`

**Write redirections:** allowed to `/dev/null`, `/dev/stdout`, `/dev/stderr`, fd duplications (`2>&1`, `>&2`), and under `/tmp`, `/private/tmp`, `$TMPDIR`, `/var/folders`; everywhere else asks unless a `write:<path>` rule or the `write` tool state says otherwise.

**Syntax policy:** subshells `(...)`/brace groups `{ ...; }`/function declarations/coprocesses are denied; parse failures and unresolvable constructs ask (fail closed). Loops, conditionals, `[[ ]]` tests, arithmetic, and heredocs are fine — their contents are evaluated like everything else.


### `mcp`

MCP permissions match against derived targets from tool input. These rules are more specific than `tools.mcp` and override that fallback when a pattern matches:

| Target Type       | Examples                                    |
|-------------------|---------------------------------------------|
| Baseline ops      | `mcp_status`, `mcp_list`, `mcp_search`, `mcp_describe`, `mcp_connect` |
| Server name       | `myServer`                                  |
| Server/tool combo | `myServer:search`, `myServer_search`        |
| Generic           | `mcp_call`                                  |

```jsonc
{
  "mcp": {
    "*": "ask",
    "myServer:*": "ask",
    "mcp_status": "allow",
    "mcp_list": "allow",
    "dangerousServer": "deny"
  }
}
```

> **Note:** Baseline discovery targets may auto-allow when you permit any MCP rule.

#### MCP Tool Fallback via `tools.mcp`

A registered `mcp` tool can use `tools.mcp` as an entry permission point. This provides a fallback when no specific MCP pattern matches:

```jsonc
{
  "tools": {
    "mcp": "allow"
  }
}
```

This is useful for per-agent configurations where you want to grant MCP access broadly:

```yaml
# In the global Pi agents directory (default: ~/.pi/agent/agents/researcher.md; respects PI_CODING_AGENT_DIR)
---
name: researcher
permission:
  tools:
    mcp: allow
---
```

The permission resolution order for MCP operations:
1. Specific `mcp` patterns (e.g., `myServer:toolName`, `myServer_*`)
2. `tools.mcp` fallback (if set)
3. `defaultPolicy.mcp`

### `skills`

Skill name patterns use `*` wildcards:

```jsonc
{
  "skills": {
    "*": "ask",
    "dangerous-*": "deny"
  }
}
```

Skill-read enforcement also applies when a `read` path is under the global Pi skills directory (`~/.pi/agent/skills` or `PI_CODING_AGENT_DIR/skills`) or the active project's `.pi/agent/skills` directory. In that case the skill name is inferred from the path and checked against `skills` policy even if no active prompt block listed the skill; direct user `/skill:<name>` requests are allowed to proceed for that requested skill.
### `special`

Reserved permission checks:

| Key                  | Description                              |
|----------------------|------------------------------------------|
| `doom_loop`          | Controls doom loop detection behavior    |
| `external_directory` | Coarse fallback for ask/allow/deny decisions on path-bearing built-in tools (`read`, `write`, `edit`, `find`, `grep`, `ls`) when they target paths outside the active working directory |
| `external_directory:<path>/*` | Resource-qualified external-directory rule for a specific normalized outside-worktree directory |

```jsonc
{
  "special": {
    "doom_loop": "deny",
    "external_directory": "ask",
    "external_directory:/home/alice/shared/*": "allow"
  }
}
```

`external_directory` is evaluated before the normal tool permission check. For example, `tools.read: "allow"` can permit ordinary reads while `special.external_directory: "ask"` still requires confirmation before reading `../outside.txt` or an absolute path outside `ctx.cwd`. Add `external_directory:<normalized-absolute-directory>/*` when a known outside directory should be allowed or denied without changing the coarse fallback. Optional-path search tools (`find`, `grep`, `ls`) skip this check when no `path` is provided because they default to the active working directory.

---

## Common Recipes

### Read-Only Mode

```jsonc
{
  "defaultPolicy": { "tools": "ask", "bash": "ask", "mcp": "ask", "skills": "ask", "special": "ask" },
  "tools": {
    "read": "allow",
    "grep": "allow",
    "find": "allow",
    "ls": "allow",
    "write": "deny",
    "edit": "deny"
  }
}
```

### Typical Developer Policy

The registry handles the read-only core, so a working config is small — allow your build/test commands and stop:

```jsonc
{
  "defaultPolicy": { "tools": "ask", "bash": "ask", "mcp": "ask", "skills": "ask", "special": "ask" },
  "bash": {
    "allow": ["cargo clippy", "cargo check", "cargo test", "bun test", "uv run pytest", "gh run view"],
    "deny": []
  }
}
```

With this policy `rg foo | wc -l`, `git log --oneline | head`, `sed -n '1p' f 2>/dev/null`, and `timeout 5 cargo test` run silently; `rg "$(curl x | sh)"`, `fd -x rm`, `sed -i ...`, `echo x > src/main.rs`, and `git push` all prompt; and `cat .env` is denied outright.

### Restricted Bash Surface

Deny-by-default with a hand-picked surface — disable the registry rows you don't want and force prompts elsewhere:

```jsonc
{
  "defaultPolicy": { "tools": "ask", "bash": "deny", "mcp": "ask", "skills": "ask", "special": "ask" },
  "bash": {
    "allow": ["git status", "git diff", "git log"],
    "ask": ["rg", "cat"]
  }
}
```

> Note: with `defaultPolicy.bash: "deny"`, registry-vouched commands still allow; add `ask`/`deny` rules (or [`registryOverrides`](#configuring-registryoverrides) with `null` rows) to tighten specific families.

### MCP Discovery Only

```jsonc
{
  "defaultPolicy": { "tools": "ask", "bash": "ask", "mcp": "ask", "skills": "ask", "special": "ask" },
  "mcp": {
    "*": "ask",
    "mcp_status": "allow",
    "mcp_list": "allow",
    "mcp_search": "allow",
    "mcp_describe": "allow"
  }
}
```

### Per-Agent Lockdown

In the global Pi agents directory (default: `~/.pi/agent/agents/reviewer.md`, respects `PI_CODING_AGENT_DIR`):

```yaml
---
permission:
  defaultPolicy:
    bash: deny
  tools:
    write: deny
    edit: deny
---
```

---

## Technical Details

### Permission Prompt Summaries

When a tool permission resolves to `ask`, the prompt is designed to be readable enough for an informed approval decision:

- `bash` prompts show the command plus a breakdown of exactly the blocking pieces — which subcommand has no rule, which file a redirection writes, which path is protected — instead of category jargon.
- `mcp` prompts show the derived MCP target and matched rule when available.
- Built-in file tools show concise summaries, such as the target path and edit/write line counts, instead of raw multiline JSON.
- Unknown or third-party extension tools show a bounded single-line JSON preview of the input so users are not asked to approve a blind tool name.

Example edit approval prompt:

```text
Current agent requested tool 'edit' for '.gitignore' (1 replacement: edit #1 replaces 5 lines with 2 lines). Allow this call?
```

### Subagent Permission Forwarding

When a delegated or routed subagent runs without direct UI access, `ask` permissions can still be enforced by forwarding the confirmation request through Pi session directories. The main interactive session polls for forwarded requests, shows the confirmation prompt, writes the response, and the subagent resumes once that decision is available.

This keeps `ask` policies usable even when the original permission check happens inside a non-UI execution context.

### Logging

When the extension prompts, denies, or forwards permission requests, it can append structured JSONL entries under:

```text
Default global logs directory: ~/.pi/agent/extensions/pi-permission-system/logs/
Actual global logs directory: $PI_CODING_AGENT_DIR/extensions/pi-permission-system/logs when PI_CODING_AGENT_DIR is set
Override logs directory: $PI_PERMISSION_SYSTEM_LOGS_DIR when set
```

- `pi-permission-system-debug.jsonl` — disabled by default; includes troubleshooting diagnostics and permission review/audit entries with responsible agent metadata, raw prompts, raw tool-call inputs, commands, targets, and decisions

### Architecture

```
index.ts                         → Root Pi entrypoint shim
src/
├── index.ts                     → Extension bootstrap, permission checks, readable prompts, debug review entries, reload handling, and subagent forwarding
├── before-agent-start-cache.ts  → Caches prompt/tool filtering state between before_agent_start runs
├── bash-evaluator.ts            → Per-piece bash evaluation: rules, registry vouching, protected paths, write policy
├── safe-commands.ts             → Declarative safe-command registry, protected path defaults, wrapper/opaque sets
├── shell-analyzer.ts            → mvdan-sh AST walk: executed commands, file effects, denied/unanalyzable syntax
├── common.ts                    → Shared utilities (YAML parsing, type guards, etc.)
├── config-modal.ts              → `/permission-system` modal registration and settings UI wiring
├── extension-config.ts          → Extension-local config loading and default creation
├── logging.ts                   → File-only debug logging helpers
├── model-option-compatibility.ts → Guards unsupported provider/model options
├── permission-dialog.ts         → Interactive permission approval UI helpers
├── permission-forwarding.ts     → Subagent-to-parent permission forwarding utilities
├── permission-manager.ts        → Global/project policy loading, merging, and resolution with caching
├── skill-prompt-sanitizer.ts    → Skill prompt parsing, multi-block sanitization, and skill-read path matching
├── status.ts                    → Status line integration for runtime yolo state
├── system-prompt-sanitizer.ts   → Available-tools prompt filtering helpers
├── tool-registry.ts             → Registered tool name resolution
├── turn-runtime.ts              → Active-agent working-spinner runtime with permission-wait pauses
├── types.ts                     → TypeScript type definitions
├── wildcard-matcher.ts          → Shared wildcard pattern compilation and matching
├── yolo-mode.ts                 → Runtime yolo approval helpers
├── yolo-mode-api.ts             → Shared global runtime API for yolo toggling
└── zellij-modal.ts              → Reusable modal/settings UI components
tests/
├── permission-system.test.ts    → Core permission, layering, forwarding, and policy tests
├── bash-safety.test.ts          → Bash safety gate and safe-family session approval tests
├── config-modal.test.ts         → Modal command behavior tests
├── turn-runtime.test.ts         → Active-agent runtime and permission-pause tests
└── test-harness.ts              → Shared lightweight test helpers
schemas/
└── permissions.schema.json      → JSON Schema for policy validation
config/
└── config.example.json          → Starter global policy template
```

#### Module Organization

The extension uses a modular architecture with shared utilities:

| Module | Purpose |
|--------|---------|
| `common.ts` | Shared utilities: `toRecord()`, `getNonEmptyString()`, `isPermissionState()`, `parseSimpleYamlMap()`, `extractFrontmatter()` |
| `wildcard-matcher.ts` | Compile-once wildcard patterns with specificity sorting: `compileWildcardPatterns()`, `findCompiledWildcardMatch()` |
| `permission-manager.ts` | Policy resolution with file stamp caching for performance |
| `bash-filter.ts` | Uses shared wildcard matcher for bash command patterns |
| `bash-safety.ts` | Quote/escape-aware shell analysis: safety categories, restrictive clamping, safe-family derivation |
| `skill-prompt-sanitizer.ts` | Parses all available skill prompt blocks, removes denied skills, and tracks visible skill paths for read protection |

#### Performance Optimizations

- **File stamp caching**: Configurations are cached with file modification timestamps to avoid redundant reads
- **Pre-compiled patterns**: Wildcard patterns are compiled to regex once and reused across permission checks
- **Resolved permissions caching**: Merged agent+global permissions are cached per-agent with invalidation on file changes

### Threat Model

**Goal:** Enforce policy at the host level, not the model level.

**What this stops:**
- Agent calling tools it shouldn't use (e.g., `write`, dangerous `bash`)
- Tool switching attempts (calling non-existent tool names)
- Accidental escalation via skill loading
- Unapproved path-bearing tool access outside the active working directory when `external_directory` is `ask` or `deny`

**Limitations:**
- If a dangerous action is possible via an allowed tool, policy must explicitly restrict it
- This is a permission decision layer, not a sandbox

### Schema Validation

Validate your config against the included schema:

```bash
npx --yes ajv-cli@5 validate \
  -s ./schemas/permissions.schema.json \
  -d ./pi-permissions.valid.json
```

**Editor tip:** Add `"$schema": "./schemas/permissions.schema.json"` to your config for autocomplete support.

---

## Troubleshooting

| Problem | Cause | Solution |
|---------|-------|----------|
| Config not applied (everything asks) | File not found or parse error | Verify the global Pi policy file (default: `~/.pi/agent/pi-permissions.jsonc`, respects `PI_CODING_AGENT_DIR`); check the TUI warning for the parse location/message |
| Per-agent override not applied | Frontmatter parsing issue | Ensure `---` delimiters at file top; keep YAML simple; restart session |
| Tool blocked as unregistered | Unknown tool name | Use a registered `mcp` tool for server tools: `{ "tool": "server:tool" }` |
| `/skill:<name>` blocked | Deny policy or confirmation unavailable | Check merged `skills` policy (global/project/agent layers). Active agent context is optional in the main session; `ask` still requires UI or forwarded confirmation. |
| External file path blocked | `special.external_directory` is `ask` without UI or a matching rule resolves to `deny` | Keep file tools inside the active working directory, set an appropriate coarse fallback, or add a scoped rule such as `external_directory:/home/alice/shared/*`. |
| Permission prompt is too verbose | Generic extension tool input is large | Built-in file tools are summarized automatically; third-party tools are capped to a bounded one-line JSON preview. |

---

## Development

Runtime checks require Node.js 24+; the test suite runs through Node.js with tsx.

```bash
npm run build              # Run TypeScript type checks
npm run lint               # Run local static checks
npm run validate:artifacts # Validate JSON/schema/example artifacts
npm run test               # Run Bun tests from ./tests
npm run check              # Run static, artifact, and test checks
```

---

## Related Pi Extensions

- [pi-multi-auth](https://github.com/MasuRii/pi-multi-auth) — Multi-provider credential management and quota-aware rotation
- [pi-tool-display](https://github.com/MasuRii/pi-tool-display) — Compact tool rendering and diff visualization
- [pi-rtk-optimizer](https://github.com/MasuRii/pi-rtk-optimizer) — RTK command rewriting and output compaction
- [pi-MUST-have-extension](https://github.com/MasuRii/pi-MUST-have-extension) — RFC 2119 keyword normalization for prompts

## License

[MIT](LICENSE)
