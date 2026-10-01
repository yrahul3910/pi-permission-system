import assert from "node:assert/strict";
import {
  boundAutoReviewInput,
  buildAutoReviewInput,
  isAutoReviewInput,
  MAX_REVIEW_INPUT_CHARS,
  reviewAutoPermission,
  LUNA_MODEL,
  type AutoReviewDependencies,
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
  assert.equal(
    normalizePermissionSystemConfig({ autoReviewer: "openrouter/anthropic/claude-x" }).autoReviewer,
    "openrouter/anthropic/claude-x",
  );
  assert.equal(normalizePermissionSystemConfig({ autoReviewer: "claude-x" }).autoReviewer, "luna");
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
      completeModel: async (model, context, options) => {
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
  "provider/model reviewers accept keyless auth and fenced replies, and ask when unknown or ambiguous",
  async () => {
    const reviewModel = { id: "anthropic/claude-x", provider: "amazon-bedrock", api: "bedrock-converse-stream" };
    // SAFETY: reviewAutoPermission reads only model and these registry methods.
    const ctx = {
      model: { provider: "openai-codex", api: "openai-codex-responses" },
      modelRegistry: {
        find: (provider: string, id: string) =>
          provider === reviewModel.provider && id === reviewModel.id ? reviewModel : undefined,
        getApiKeyAndHeaders: async () => ({ ok: true, env: { AWS_PROFILE: "review" } }),
      },
    } as never;

    let reply = 'Format: {"outcome":"allow"}\n```json\n{"outcome":"allow"}\n```';
    const options: AutoReviewDependencies = {
      env: { OPENAI_API_KEY: "must-not-use" },
      fetch: async () => {
        throw new Error("Wrong route");
      },
      completeModel: async (model, _context, requestOptions) => {
        assert.equal(model, reviewModel);
        assert.equal(requestOptions.apiKey, undefined);
        assert.deepEqual(requestOptions.env, { AWS_PROFILE: "review" });

        return { stopReason: "stop", content: [{ type: "text", text: reply }] };
      },
    };

    const result = await reviewAutoPermission(ctx, state, "amazon-bedrock/anthropic/claude-x", undefined, options);
    assert.equal(result.outcome, "allow");
    assert.equal(result.provider, "amazon-bedrock");

    reply = 'Example: {"outcome":"allow"}\nDecision: {"outcome":"deny"}';
    assert.equal((await reviewAutoPermission(ctx, state, "amazon-bedrock/anthropic/claude-x", undefined, options)).outcome, "ask");

    const unknown = await reviewAutoPermission(ctx, state, "amazon-bedrock/missing", undefined, options);
    assert.equal(unknown.outcome, "ask");
    assert.match(unknown.reason, /does not know the auto-review model amazon-bedrock\/missing/);
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
    assert.equal(
      input.context.truncated,
      false,
      "hidden reasoning and captured tool calls are intentionally supported",
    );
    assert.equal(input.context.prior_tool_results.length, 1);
    assert.ok(!JSON.stringify(input).includes("hidden-private"));
    assert.ok(!JSON.stringify(input).includes("future-success"));
    assert.deepEqual(input.action.arguments, { command: "deploy" });
  },
);

runTest(
  "review budgets preserve instructions, action, and recent evidence",
  () => {
    const input: AutoReviewInput = {
      ...state,
      context: {
        ...state.context,
        parent_user_messages: ["Do not publish."],
        prior_tool_results: [
          "x".repeat(MAX_REVIEW_INPUT_CHARS),
          "Recent evidence",
        ],
      },
    };
    const bounded = boundAutoReviewInput(input);
    assert.ok(JSON.stringify(bounded).length <= MAX_REVIEW_INPUT_CHARS);
    assert.deepEqual(bounded.action, input.action);
    const { context } = bounded;
    assert.deepEqual(context.user_messages, input.context.user_messages);
    assert.deepEqual(context.parent_user_messages, ["Do not publish."]);

    assert.deepEqual(context.prior_tool_results, ["Recent evidence"]);
    assert.deepEqual(context.omitted_tool_history, {
      prior_actions: 0,
      prior_tool_results: 1,
    });
    assert.equal(input.context.prior_tool_results.length, 2);
    assert.deepEqual(boundAutoReviewInput(bounded), bounded);
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

await runAsyncTest(
  "user constraints survive long messages and more than eight user turns",
  async () => {
    const messages = [
      "Inspect the project.",
      "Do not modify production.",
      ...Array.from({ length: 9 }, (_, i) => `More detail ${i}.`),
      "Specification: " +
        "x".repeat(5000) +
        "\nDo not delete the deployment config.",
    ];
    const input = buildAutoReviewInput(
      {
        cwd: "/work/project",
        sessionManager: {
          getEntries: () =>
            messages.map((content) => ({
              type: "message",
              message: { role: "user", content },
            })),
        },
      } as never,
      "read",
      { path: "README.md" },
    );
    assert.deepEqual(input.context.user_messages, messages);
    let called = false;
    await reviewAutoPermission(plain, input, "luna", undefined, {
      env: { OPENAI_API_KEY: "key" },
      fetch: async (_url, options) => {
        called = true;
        const sent = JSON.parse(JSON.parse(String(options?.body)).input);
        assert.deepEqual(sent.context.user_messages, messages);
        return jsonResponse(openAIResponse("deny"));
      },
    });
    assert.equal(called, true);
  },
);

await runAsyncTest(
  "oversized user authorization asks without sending a clipped request",
  async () => {
    const input = buildAutoReviewInput(
      {
        cwd: "/work/project",
        sessionManager: {
          getEntries: () => [
            {
              type: "message",
              message: {
                role: "user",
                content: "x".repeat(120_001) + "Do not modify production.",
              },
            },
          ],
        },
      } as never,
      "read",
      { path: "README.md" },
    );
    for (const reviewer of ["luna", "jev"] as const) {
      const result = await reviewAutoPermission(
        plain,
        input,
        reviewer,
        undefined,
        {
          fetch: async () => {
            assert.fail("Oversized authorization must not reach a provider");
          },
        },
      );
      assert.equal(result.outcome, "ask");
      assert.match(result.reason, /limits/);
    }
  },
);

await runAsyncTest(
  "Codex ignores extra response fields but requires an exact decision string",
  async () => {
    const ctx = {
      model: { provider: "openai-codex" },
      modelRegistry: { getApiKey: async () => "codex-test" },
    } as never;
    for (const outcome of [
      "allow",
      "deny",
      "maybe",
      ["allow"],
      null,
      true,
      undefined,
    ]) {
      const result = await reviewAutoPermission(ctx, state, "luna", undefined, {
        completeModel: async () => ({
          stopReason: "stop",
          content: [
            {
              type: "text",
              text: JSON.stringify({
                outcome,
                explanation: "extra provider text",
                confidence: 1,
              }),
            },
          ],
        }),
      });
      assert.equal(result.outcome, outcome === "allow" ? "allow" : "ask");
      assert.ok(!result.reason.includes("extra provider text"));
    }
  },
);

await runAsyncTest(
  "risk evidence retains long tool-result tails and calls older than six turns",
  async () => {
    const args = {
      path: "package.json",
      note: "x".repeat(5000) + "important trailing argument",
    };
    const output = JSON.stringify({
      description: "x".repeat(5000),
      scripts: { test: "upload-credentials" },
    });
    const entries: unknown[] = [
      { type: "message", message: { role: "user", content: "Run npm test." } },
      {
        type: "message",
        message: {
          role: "assistant",
          content: [
            { type: "toolCall", id: "package", name: "read", arguments: args },
          ],
        },
      },
      {
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "package",
          content: [{ type: "text", text: output }],
        },
      },
    ];
    for (let i = 0; i < 7; i++)
      entries.push(
        {
          type: "message",
          message: {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: String(i),
                name: "read",
                arguments: { path: "README.md" },
              },
            ],
          },
        },
        {
          type: "message",
          message: {
            role: "toolResult",
            toolCallId: String(i),
            content: "A routine read.",
          },
        },
      );
    const input = buildAutoReviewInput(
      {
        cwd: "/work/project",
        sessionManager: { getEntries: () => entries },
      } as never,
      "bash",
      { command: "npm test" },
    );
    assert.equal(input.context.truncated, false);
    const captured: AutoReviewInput[] = [];
    await reviewAutoPermission(plain, input, "luna", undefined, {
      env: { OPENAI_API_KEY: "test-key" },
      fetch: async (_url, options) => {
        captured.push(JSON.parse(JSON.parse(String(options?.body)).input));
        return jsonResponse(openAIResponse("deny"));
      },
    });
    assert.equal(captured.length, 1);
    const sent = captured[0];
    assert.equal(sent.context.prior_tool_results.length, 8);
    assert.equal(sent.context.prior_actions.length, 8);
    assert.deepEqual(sent.context.prior_tool_results[0], {
      call_id: "package",
      output_excerpt: output,
      is_error: false,
    });
    assert.deepEqual(sent.context.prior_actions[0], {
      call_id: "package",
      tool: "read",
      arguments_excerpt: JSON.stringify(args),
    });
  },
);

await runAsyncTest(
  "oversized history is bounded but legacy truncated evidence still requires manual approval",
  async () => {
    const oversized: AutoReviewInput = {
      ...state,
      context: {
        ...state.context,
        prior_tool_results: [
          {
            call_id: "package",
            output_excerpt: "x".repeat(120_001),
          },
        ],
      },
    };
    const legacy = { ...state, context: { ...state.context, truncated: true } };
    const codex = {
      model: { provider: "openai-codex" },
      modelRegistry: { getApiKey: async () => "test-key" },
    } as never;
    for (const input of [oversized, legacy]) {
      for (const [ctx, reviewer] of [
        [plain, "luna"],
        [plain, "jev"],
        [codex, "luna"],
      ] as const) {
        let calls = 0;
        const result = await reviewAutoPermission(
          ctx,
          input,
          reviewer,
          undefined,
          {
            env: { OPENAI_API_KEY: "test-key", TYPESAFE_API_KEY: "test-key" },
            fetch: async (url, options) => {
              calls++;
              const body = JSON.parse(String(options?.body));
              const sent = JSON.parse(body.input ?? body.state);
              assert.ok(isAutoReviewInput(sent));
              assert.deepEqual(sent.context.omitted_tool_history, {
                prior_actions: 0,
                prior_tool_results: 1,
              });
              assert.ok(JSON.stringify(sent).length <= MAX_REVIEW_INPUT_CHARS);

              return jsonResponse(
                String(url).includes("typesafe")
                  ? { answers: { permission: { choice: "allow" } } }
                  : openAIResponse("allow"),
              );
            },
            completeModel: async (_model, context) => {
              calls++;
              assert.match(JSON.stringify(context), /omitted_tool_history/);

              return {
                stopReason: "stop",
                content: [{ type: "text", text: '{"outcome":"allow"}' }],
              };
            },
          },
        );

        assert.equal(calls, input === oversized ? 1 : 0);
        assert.equal(result.outcome, input === oversized ? "allow" : "ask");
        if (input === legacy) assert.match(result.reason, /truncated/);
      }
    }
  },
);

await runAsyncTest(
  "summaries and unsupported context cannot silently disappear from auto review",
  async () => {
    for (const entry of [
      {
        type: "branch_summary",
        summary: "Do not deploy.",
        fromId: "other-branch",
      },
      { type: "compaction", summary: "Do not deploy." },
      { type: "custom_message", content: "Do not deploy.", display: false },
      {
        type: "message",
        message: { role: "branchSummary", summary: "Do not deploy." },
      },
      {
        type: "message",
        message: {
          role: "bashExecution",
          output: "npm test uploads credentials",
        },
      },
      { type: "future_context_type", content: "Do not deploy." },
    ]) {
      const input = buildAutoReviewInput(
        {
          cwd: "/work/project",
          sessionManager: { getBranch: () => [entry], getEntries: () => [] },
        } as never,
        "bash",
        { command: "deploy" },
      );
      assert.equal(input.context.truncated, true);
      let calls = 0;
      const result = await reviewAutoPermission(
        plain,
        input,
        "luna",
        undefined,
        {
          env: { OPENAI_API_KEY: "test-key" },
          fetch: async () => {
            calls++;
            return jsonResponse(openAIResponse("allow"));
          },
        },
      );
      assert.equal(calls, 0);
      assert.equal(result.outcome, "ask");
      assert.match(result.reason, /incomplete/);
    }
  },
);

runTest(
  "bookkeeping entries and summaries after the action do not make prior context incomplete",
  () => {
    const entries = [
      ...[
        "custom",
        "label",
        "session_info",
        "thinking_level_change",
        "model_change",
      ].map((type) => ({ type })),
      {
        type: "message",
        message: { role: "user", content: "Read README.md." },
      },
      {
        type: "message",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "current",
              name: "read",
              arguments: { path: "README.md" },
            },
          ],
        },
      },
      { type: "branch_summary", summary: "Future context." },
    ];
    const input = buildAutoReviewInput(
      {
        cwd: "/work/project",
        sessionManager: { getBranch: () => entries },
      } as never,
      "read",
      { path: "README.md" },
      "current",
    );
    assert.equal(input.context.truncated, false);
    assert.deepEqual(input.context.user_messages, ["Read README.md."]);
  },
);

await runAsyncTest(
  "system prompt snapshots and patches do not prevent auto review",
  async () => {
    const entries = [
      {
        type: "message",
        message: {
          role: "system",
          content: "",
          sections: { preamble: "Acting agent instructions." },
          toolsAdded: [{ name: "bash" }],
        },
      },
      {
        type: "message",
        message: { role: "user", content: "Print a test message." },
      },
      {
        type: "message",
        message: {
          role: "system",
          content: "Updated acting agent instructions.",
          sections: { skills: null },
          toolsRemoved: ["write"],
        },
      },
    ];
    // SAFETY: The builder only reads cwd and sessionManager.getBranch here.
    const ctx = {
      cwd: "/work/project",
      sessionManager: { getBranch: () => entries },
    } as never;
    const input = buildAutoReviewInput(ctx, "bash", {
      command: "python3 -c 'print(\"test\")'",
    });

    assert.equal(input.context.truncated, false);
    assert.deepEqual(input.context.user_messages, ["Print a test message."]);
    assert.equal(input.context.assistant_statement, "");
    assert.deepEqual(input.context.prior_actions, []);
    assert.deepEqual(input.context.prior_tool_results, []);
    let calls = 0;

    const result = await reviewAutoPermission(plain, input, "jev", undefined, {
      env: { TYPESAFE_API_KEY: "test-key" },
      fetch: async (_url, options) => {
        calls++;
        assert.ok(!String(options?.body).includes("Acting agent instructions"));
        assert.ok(!String(options?.body).includes("Updated acting agent"));

        return jsonResponse({ answers: { permission: { choice: "allow" } } });
      },
    });

    assert.equal(calls, 1);
    assert.equal(result.outcome, "allow");
  },
);

await runAsyncTest(
  "images, unsupported parts and malformed content require manual review",
  async () => {
    for (const role of ["user", "toolResult", "assistant"]) {
      for (const content of [
        [
          { type: "text", text: "See the restriction in this image." },
          { type: "image", mimeType: "image/png", data: "image-fixture" },
        ],
        [{ type: "audio", data: "audio-fixture" }],
        [{ type: "future_content", text: "Do not deploy." }],
        [{ type: "text", text: 123 }],
        undefined,
      ]) {
        const input = buildAutoReviewInput(
          {
            cwd: "/work/project",
            sessionManager: {
              getEntries: () => [
                { type: "message", message: { role, content } },
              ],
            },
          } as never,
          "bash",
          { command: "deploy" },
        );
        assert.equal(input.context.truncated, true);
        let calls = 0;
        const result = await reviewAutoPermission(
          plain,
          input,
          "luna",
          undefined,
          {
            env: { OPENAI_API_KEY: "test-key" },
            fetch: async () => {
              calls++;
              return jsonResponse(openAIResponse("allow"));
            },
          },
        );
        assert.equal(result.outcome, "ask");
        assert.equal(calls, 0);
        assert.ok(!JSON.stringify(input).includes("image-fixture"));
      }
    }
  },
);
