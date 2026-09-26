import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import extension from "../src/index.js";
import {
  DEFAULT_EXTENSION_CONFIG,
  loadPermissionSystemConfig,
  savePermissionSystemConfig,
} from "../src/extension-config.js";
import { SUBAGENT_ENV_HINT_KEYS } from "../src/permission-forwarding.js";
import { runAsyncTest, runTest } from "./test-harness.js";

const root = mkdtempSync(join(tmpdir(), "auto-mode-integration-"));
const keys = [
  ...SUBAGENT_ENV_HINT_KEYS,
  "PI_AGENT_ROUTER_PARENT_SESSION_ID",
  "PI_CODING_AGENT_DIR",
  "PI_PERMISSION_SYSTEM_CONFIG_PATH",
  "PI_PERMISSION_SYSTEM_LOGS_DIR",
  "PI_PERMISSION_SYSTEM_FORWARDING_AGENT_DIR",
  "OPENAI_API_KEY",
  "TYPESAFE_API_KEY",
];
const original = new Map(keys.map((key) => [key, process.env[key]]));
const originalFetch = globalThis.fetch;
for (const key of keys) delete process.env[key];
process.env.PI_PERMISSION_SYSTEM_FORWARDING_AGENT_DIR = join(
  root,
  "shared-runtime",
);
process.env.OPENAI_API_KEY = "test-parent-openai-key";
process.env.TYPESAFE_API_KEY = "test-parent-jev-key";
let calls: Array<{ url: string; body: Record<string, any> }> = [];
let outcome = "allow";
let pendingFetch: (() => void) | undefined;
globalThis.fetch = async (url, options) => {
  calls.push({ url: String(url), body: JSON.parse(String(options?.body)) });
  pendingFetch?.();
  if (outcome === "hang") return new Promise(() => {});
  return new Response(
    JSON.stringify(
      String(url).includes("typesafe")
        ? { answers: { permission: { choice: outcome } } }
        : {
            status: "completed",
            output: [
              {
                type: "message",
                content: [
                  { type: "output_text", text: JSON.stringify({ outcome }) },
                ],
              },
            ],
          },
    ),
  );
};

type Handler = (event: any, ctx: any) => any;
function harness(name: string, hasUI = true, reviewer = "luna") {
  const cwd = join(root, name);
  mkdirSync(cwd, { recursive: true });
  const configPath = join(cwd, "pi-permissions.jsonc");
  writeFileSync(
    configPath,
    JSON.stringify({
      ...DEFAULT_EXTENSION_CONFIG,
      autoReviewer: reviewer,
      desktopNotifications: false,
      forwardedPromptTimeoutSeconds: 5,
      tools: { read: "ask", write: "deny" },
    }),
  );
  process.env.PI_CODING_AGENT_DIR = cwd;
  process.env.PI_PERMISSION_SYSTEM_CONFIG_PATH = configPath;
  process.env.PI_PERMISSION_SYSTEM_LOGS_DIR = join(cwd, "logs");
  const handlers: Record<string, Handler> = {};
  const commands: Record<string, { handler: Handler }> = {};
  const prompts: string[] = [];
  let selection = "Allow Once";
  const ctx = {
    cwd,
    hasUI,
    model: {
      provider: hasUI ? "anthropic" : "openai-codex",
      api: hasUI ? "anthropic-messages" : "openai-codex-responses",
    },
    // Child has no provider credentials. Forwarded reviews must use the parent's model/auth route.
    modelRegistry: { getApiKey: async () => undefined },
    getSystemPrompt: () => (hasUI ? "" : '<active_agent name="worker"/>'),
    sessionManager: {
      getSessionId: () => name,
      getSessionDir: () => cwd,
      getEntries: () => [
        {
          type: "message",
          message: {
            role: "user",
            content: hasUI
              ? "Inspect the source; do not publish it."
              : "Read file.txt in your worktree.",
          },
        },
      ],
    },
    ui: {
      notify() {},
      setStatus() {},
      select: async (title: string) => {
        prompts.push(title);
        return selection;
      },
      input: async () => undefined,
    },
  };
  extension({
    on: (event: string, handler: Handler) => {
      handlers[event] = handler;
    },
    registerCommand: (name: string, command: any) => {
      commands[name] = command;
    },
    registerProvider() {},
    getAllTools: () => [{ name: "read" }, { name: "write" }],
    setActiveTools() {},
    events: { emit() {} },
  } as never);
  let id = 0;
  return {
    ctx,
    handlers,
    commands,
    prompts,
    configPath,
    select: (value: string) => {
      selection = value;
    },
    start: () => handlers.session_start({ reason: "startup" }, ctx),
    mode: (mode: string) => commands.permissions.handler(mode, ctx),
    call: (toolName = "read", path = "file.txt") =>
      handlers.tool_call(
        {
          toolName,
          toolCallId: `${name}-${++id}`,
          input: { path: join(cwd, path) },
        },
        ctx,
      ),
    close: () => handlers.session_shutdown({}, ctx),
  };
}

try {
  await runAsyncTest(
    "auto reviews every ask, preserves hard denies, and sends reviewer denials to the user",
    async () => {
      const h = harness("direct");
      try {
        await h.start();
        await h.mode("auto");
        calls = [];
        outcome = "allow";
        assert.equal((await h.call())?.block, undefined);
        assert.equal((await h.call())?.block, undefined);
        assert.equal(
          calls.length,
          2,
          "an approval must not be cached for the next identical action",
        );
        assert.equal(h.prompts.length, 0);
        assert.equal((await h.call("write"))?.block, true);
        assert.equal((await h.call("read", ".env"))?.block, true);
        assert.equal(
          calls.length,
          2,
          "hard denies must not reach the reviewer",
        );
        outcome = "deny";
        assert.equal(
          (await h.call())?.block,
          undefined,
          "the user can approve a reviewer denial",
        );
        h.select("Reject");
        assert.equal((await h.call())?.block, true);
        assert.equal(h.prompts.length, 2);
        assert.equal(
          JSON.parse(readFileSync(h.configPath, "utf8")).permissionMode,
          "ask",
          "mode changes stay session-local",
        );
      } finally {
        await h.close();
      }
    },
  );

  await runAsyncTest(
    "cross-worktree child uses parent mode, reviewer, model route and user fallback",
    async () => {
      for (const reviewer of ["luna", "jev"]) {
        const parent = harness(`parent-${reviewer}`, true, reviewer);
        let child: ReturnType<typeof harness> | undefined;
        try {
          await parent.start();
          await parent.mode("auto");
          child = harness(`child-worktree-${reviewer}`, false); // child remains in default ask mode
          await child.start();
          calls = [];
          outcome = "allow";
          assert.equal((await child.call())?.block, undefined);
          assert.equal(calls.length, 1);
          assert.match(
            calls[0].url,
            reviewer === "jev" ? /typesafe/ : /api.openai.com/,
          );
          const input = JSON.parse(calls[0].body.input ?? calls[0].body.state);
          assert.equal(input.context.cwd, child.ctx.cwd);
          assert.notEqual(input.context.cwd, parent.ctx.cwd);
          assert.deepEqual(input.action.arguments, {
            path: join(child.ctx.cwd, "file.txt"),
            cwd: child.ctx.cwd,
          });
          assert.deepEqual(input.context.parent_user_messages, [
            "Inspect the source; do not publish it.",
          ]);
          assert.deepEqual(input.context.user_messages, [
            "Read file.txt in your worktree.",
          ]);
          outcome = "deny";
          assert.equal((await child.call())?.block, undefined);
          parent.select("Reject");
          assert.equal((await child.call())?.block, true);
          assert.equal(parent.prompts.length, 2);
          assert.equal(child.prompts.length, 0);
        } finally {
          await child?.close();
          await parent.close();
        }
      }
    },
  );

  await runAsyncTest(
    "missing credentials ask interactively and block when no UI is available",
    async () => {
      delete process.env.OPENAI_API_KEY;
      for (const hasUI of [true, false]) {
        const h = harness(`missing-key-${hasUI}`, hasUI);
        // This headless session is not a subagent.
        h.ctx.getSystemPrompt = () => "";
        h.ctx.model.provider = "anthropic";
        h.ctx.model.api = "anthropic-messages";
        try {
          await h.start();
          await h.mode("auto");
          calls = [];
          assert.equal((await h.call())?.block, hasUI ? undefined : true);
          assert.equal(h.prompts.length, hasUI ? 1 : 0);
          assert.equal(calls.length, 0);
        } finally {
          await h.close();
        }
      }
      process.env.OPENAI_API_KEY = "test-parent-openai-key";
    },
  );

  await runAsyncTest(
    "mode changes cancel in-flight reviews without late approval or UI",
    async () => {
      const h = harness("cancel");
      try {
        await h.start();
        await h.mode("auto");
        outcome = "hang";
        const started = new Promise<void>((resolve) => {
          pendingFetch = resolve;
        });
        const request = h.call();
        await started;
        await h.mode("ask");
        assert.equal((await request)?.block, true);
        assert.equal(h.prompts.length, 0);
      } finally {
        pendingFetch = undefined;
        outcome = "allow";
        await h.close();
      }
    },
  );

  await runAsyncTest(
    "cancelling a parent review returns a denial to the waiting child",
    async () => {
      const parent = harness("cancel-parent");
      let child: ReturnType<typeof harness> | undefined;
      try {
        await parent.start();
        await parent.mode("auto");
        child = harness("cancel-child-worktree", false);
        await child.start();
        outcome = "hang";
        const started = new Promise<void>((resolve) => {
          pendingFetch = resolve;
        });
        const request = child.call();
        await started;
        await parent.mode("ask");
        assert.equal((await request)?.block, true);
        assert.equal(parent.prompts.length, 0);
        assert.equal(child.prompts.length, 0);
      } finally {
        pendingFetch = undefined;
        outcome = "allow";
        await child?.close();
        await parent.close();
      }
    },
  );

  await runAsyncTest(
    "replacement permission owner cancels stale auto review and handles the same child request",
    async () => {
      const parent = harness("handoff-parent");
      let child: ReturnType<typeof harness> | undefined;
      let replacement: ReturnType<typeof harness> | undefined;
      try {
        await parent.start();
        await parent.mode("auto");
        child = harness("handoff-child-worktree", false);
        await child.start();
        calls = [];
        outcome = "hang";
        const started = new Promise<void>((resolve) => {
          pendingFetch = resolve;
        });
        const request = child.call();
        await started;
        pendingFetch = undefined;
        outcome = "allow";
        replacement = harness("handoff-parent");
        await replacement.start();
        await replacement.mode("auto");
        assert.equal((await request)?.block, undefined);
        assert.equal(calls.length, 2);
        assert.equal(parent.prompts.length, 0);
        assert.equal(replacement.prompts.length, 0);
        assert.equal(child.prompts.length, 0);
      } finally {
        pendingFetch = undefined;
        outcome = "allow";
        await child?.close();
        await replacement?.close();
        await parent.close();
      }
    },
  );

  runTest(
    "reviewer is saved but runtime permission mode does not overwrite startup mode",
    () => {
      const path = join(root, "settings.jsonc");
      writeFileSync(
        path,
        '{\n// preserve this\n"permissionMode":"ask","tools":{"read":"ask"}\n}',
      );
      assert.equal(
        savePermissionSystemConfig(
          {
            ...DEFAULT_EXTENSION_CONFIG,
            permissionMode: "auto",
            autoReviewer: "jev",
          },
          path,
        ).success,
        true,
      );
      const result = loadPermissionSystemConfig(path).config;
      assert.equal(result.permissionMode, "ask");
      assert.equal(result.autoReviewer, "jev");
      assert.match(readFileSync(path, "utf8"), /preserve this/);
    },
  );
} finally {
  globalThis.fetch = originalFetch;
  for (const [key, value] of original) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
}
