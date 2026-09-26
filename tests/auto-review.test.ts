import assert from "node:assert/strict";
import {
  buildAutoReviewInput,
  reviewAutoPermission,
  LUNA_MODEL,
  type AutoReviewInput,
} from "../src/auto-review.js";
import { normalizePermissionSystemConfig } from "../src/extension-config.js";
import { runAsyncTest, runTest } from "./test-harness.js";

const state: AutoReviewInput = {
  context: {
    cwd: "/work/child-tree",
    user_messages: ["Run the unit tests."],
    assistant_statement: "",
    prior_actions: [],
    prior_tool_results: [],
    truncated: false,
  },
  action: { tool: "bash", arguments: { command: "npm test" } },
};
const plain = { model: { provider: "anthropic" }, modelRegistry: {} } as never;
const jsonResponse = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status });
const openAIResponse = (outcome: string) => ({
  status: "completed",
  output: [
    {
      type: "message",
      content: [{ type: "output_text", text: JSON.stringify({ outcome }) }],
    },
  ],
});

runTest("auto defaults to Luna and preserves legacy YOLO configuration", () => {
  assert.equal(normalizePermissionSystemConfig({}).permissionMode, "ask");
  assert.equal(
    normalizePermissionSystemConfig({ permissionMode: "auto" }).autoReviewer,
    "luna",
  );
  assert.equal(
    normalizePermissionSystemConfig({ yoloMode: true }).permissionMode,
    "yolo",
  );
  assert.equal(
    normalizePermissionSystemConfig({
      permissionMode: "auto",
      autoReviewer: "jev",
    }).yoloMode,
    false,
  );
});

await runAsyncTest(
  "non-Codex Luna uses only OPENAI_API_KEY with exact action and no execution tools",
  async () => {
    const result = await reviewAutoPermission(plain, state, "luna", undefined, {
      env: { OPENAI_API_KEY: "openai-test", TYPESAFE_API_KEY: "jev-test" },
      fetch: async (url, options) => {
        assert.equal(url, "https://api.openai.com/v1/responses");
        assert.equal(
          (options?.headers as Record<string, string>).Authorization,
          "Bearer openai-test",
        );
        const body = JSON.parse(String(options?.body));
        assert.equal(body.model, LUNA_MODEL);
        assert.deepEqual(JSON.parse(body.input), state);
        assert.equal(body.tools, undefined);
        assert.equal(body.store, false);
        return jsonResponse(openAIResponse("allow"));
      },
    });
    assert.equal(result.outcome, "allow");
  },
);

await runAsyncTest(
  "Jev uses TYPESAFE_API_KEY and a deny choice asks even at high confidence",
  async () => {
    const result = await reviewAutoPermission(plain, state, "jev", undefined, {
      env: { TYPESAFE_API_KEY: "jev-test", OPENAI_API_KEY: "other" },
      fetch: async (url, options) => {
        assert.equal(url, "https://api.typesafe.ai/v1/systemone");
        assert.equal(
          (options?.headers as Record<string, string>).Authorization,
          "Bearer jev-test",
        );
        const body = JSON.parse(String(options?.body));
        assert.deepEqual(JSON.parse(body.state), state);
        assert.deepEqual(Object.keys(body.questions.permission.criteria), [
          "allow",
          "deny",
        ]);
        return jsonResponse({
          answers: { permission: { choice: "deny", confidence: 1 } },
        });
      },
    });
    assert.equal(result.outcome, "ask");
  },
);

await runAsyncTest(
  "Codex main model routes Luna through Pi credentials, never OPENAI_API_KEY",
  async () => {
    let authCalls = 0;
    const ctx = {
      model: {
        id: "gpt-6-astra",
        provider: "openai-codex",
        api: "openai-codex-responses",
        baseUrl: "https://chatgpt.com/backend-api",
        reasoning: true,
      },
      modelRegistry: {
        getApiKeyAndHeaders: async (model: { id: string }) => {
          authCalls++;
          assert.equal(model.id, LUNA_MODEL);
          return {
            apiKey: "codex-test",
            headers: { "test-auth-header": "header" },
          };
        },
      },
    } as never;
    const result = await reviewAutoPermission(ctx, state, "luna", undefined, {
      env: { OPENAI_API_KEY: "must-not-use" },
      fetch: async () => {
        throw new Error("Wrong route");
      },
      completeCodex: async (model, context, options) => {
        assert.equal(model.id, LUNA_MODEL);
        assert.equal(model.api, "openai-codex-responses");
        assert.equal(options.apiKey, "codex-test");
        assert.equal(options.reasoning, "low");
        assert.equal(context.tools, undefined);
        assert.equal(options.transport, "sse");
        return {
          stopReason: "stop",
          content: [{ type: "text", text: '{"outcome":"allow"}' }],
        };
      },
    });
    assert.equal(authCalls, 1);
    assert.equal(result.outcome, "allow");
    assert.equal(result.provider, "codex");
  },
);

await runAsyncTest(
  "old Pi getApiKey is supported and missing Codex auth never changes providers",
  async () => {
    const ctx = {
      model: { provider: "openai-codex", api: "openai-codex-responses" },
      modelRegistry: { getApiKey: async () => undefined },
    } as never;
    const result = await reviewAutoPermission(ctx, state, "luna", undefined, {
      env: { OPENAI_API_KEY: "must-not-use" },
      fetch: async () => {
        throw new Error("Unexpected API call");
      },
    });
    assert.equal(result.outcome, "ask");
    assert.match(result.reason, /Codex credentials/);
  },
);

await runAsyncTest(
  "missing keys, HTTP errors, incomplete and malformed output all ask",
  async () => {
    assert.equal(
      (await reviewAutoPermission(plain, state, "luna", undefined, { env: {} }))
        .outcome,
      "ask",
    );
    for (const response of [
      jsonResponse({}, 500),
      jsonResponse({ status: "incomplete" }),
      jsonResponse(openAIResponse("maybe")),
      new Response("secret echoed by backend", { status: 401 }),
    ]) {
      const result = await reviewAutoPermission(
        plain,
        state,
        "luna",
        undefined,
        { env: { OPENAI_API_KEY: "key" }, fetch: async () => response },
      );
      assert.equal(result.outcome, "ask");
      assert.ok(!result.reason.includes("secret"));
    }
  },
);

await runAsyncTest(
  "timeout bounds uncooperative providers and explicit cancellation never approves",
  async () => {
    const never = () => new Promise<Response>(() => {});
    assert.equal(
      (
        await reviewAutoPermission(plain, state, "luna", undefined, {
          env: { OPENAI_API_KEY: "key" },
          timeoutMs: 5,
          fetch: never,
        })
      ).outcome,
      "ask",
    );
    const controller = new AbortController();
    const pending = reviewAutoPermission(
      plain,
      state,
      "luna",
      controller.signal,
      { env: { OPENAI_API_KEY: "key" }, fetch: never },
    );
    controller.abort();
    assert.equal((await pending).outcome, "cancelled");
  },
);

runTest(
  "context follows active branch, excludes hidden reasoning and future results, retains exact action",
  () => {
    const entries = [
      { type: "message", message: { role: "user", content: "Do not deploy." } },
      {
        type: "message",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "hidden-private" },
            {
              type: "toolCall",
              id: "prior",
              name: "read",
              arguments: { path: "config" },
            },
          ],
        },
      },
      {
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "prior",
          content: [{ type: "text", text: "config controls production" }],
        },
      },
      {
        type: "message",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "current",
              name: "bash",
              arguments: { command: "deploy" },
            },
          ],
        },
      },
      {
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "current",
          content: "future-success",
        },
      },
    ];
    const input = buildAutoReviewInput(
      {
        cwd: "/other/worktree",
        sessionManager: {
          getBranch: () => entries,
          getEntries: () => {
            throw new Error("Wrong branch");
          },
        },
      } as never,
      "bash",
      { command: "deploy" },
      "current",
    );
    assert.equal(input.context.cwd, "/other/worktree");
    assert.equal(input.context.prior_tool_results.length, 1);
    assert.ok(!JSON.stringify(input).includes("hidden-private"));
    assert.ok(!JSON.stringify(input).includes("future-success"));
    assert.deepEqual(input.action.arguments, { command: "deploy" });
  },
);

await runAsyncTest(
  "oversize actions go to the user without clipping or a network call",
  async () => {
    const input = {
      ...state,
      action: { tool: "write", arguments: { content: "x".repeat(130_000) } },
    };
    const result = await reviewAutoPermission(plain, input, "luna", undefined, {
      env: { OPENAI_API_KEY: "key" },
      fetch: async () => {
        throw new Error("Unexpected call");
      },
    });
    assert.equal(result.outcome, "ask");
  },
);
