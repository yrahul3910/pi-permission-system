import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { randomUUID } from "node:crypto";
import { toRecord } from "./common.js";
import { AUTO_REVIEW_POLICY } from "./auto-review-policy.js";

export type AutoReviewer = "luna" | "jev";
export const LUNA_MODEL = "gpt-6-luna";
export const JEV_MODEL = "jev-1.13.0";
export const AUTO_REVIEW_TIMEOUT_MS = 20_000;
export const MAX_REVIEW_INPUT_CHARS = 120_000;

// Pi excludes these bookkeeping entries from model context. Other entry types
// may carry evidence that this serializer cannot represent completely.
// Source of truth: Pi core/session-manager.ts buildSessionContext (appendMessage)
// and core/messages.ts convertToLlm; recheck this list when upgrading Pi.
const NON_CONTEXT_ENTRY_TYPES = new Set([
  "custom",
  "label",
  "session_info",
  "thinking_level_change",
  "model_change",
]);

export interface AutoReviewInput {
  context: {
    cwd: string;
    user_messages: string[];
    assistant_statement: string;
    prior_actions: unknown[];
    prior_tool_results: unknown[];
    truncated: boolean;
    parent_user_messages?: string[];
    parent_evidence?: {
      cwd: string;
      assistant_statement: string;
      prior_actions: unknown[];
      prior_tool_results: unknown[];
    };
  };
  action: { tool: string; arguments: unknown };
}

export interface AutoReviewResult {
  outcome: "allow" | "ask" | "cancelled";
  reason: string;
  provider?: "codex" | "openai" | "typesafe";
}

function textContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      const record = toRecord(part);
      return record.type === "text" && typeof record.text === "string"
        ? record.text
        : "";
    })
    .join("\n");
}

/** Capture only the active branch and evidence preceding this tool call. Never copy hidden reasoning. */
export function buildAutoReviewInput(
  ctx: ExtensionContext,
  tool: string,
  args: unknown,
  toolCallId?: string,
): AutoReviewInput {
  const manager = ctx.sessionManager as typeof ctx.sessionManager & {
    getBranch?: () => readonly unknown[];
  };
  const entries = manager.getBranch?.() ?? manager.getEntries();
  const context: AutoReviewInput["context"] = {
    cwd: ctx.cwd,
    user_messages: [],
    assistant_statement: "",
    prior_actions: [],
    prior_tool_results: [],
    truncated: false,
  };
  const readContextText = (content: unknown, role: string): string => {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) {
      context.truncated = true;
      return "";
    }
    for (const part of content) {
      const record = toRecord(part);
      if (record.type === "text" && typeof record.text === "string") continue;
      // Reasoning is intentionally private; tool calls are captured separately.
      if (
        role === "assistant" &&
        (record.type === "thinking" || record.type === "toolCall")
      )
        continue;
      // Images and other unsupported parts may carry constraints or risk evidence.
      context.truncated = true;
    }
    return textContent(content);
  };
  for (const value of entries) {
    const entry = toRecord(value);
    if (entry.type !== "message") {
      // Branch/compaction summaries can be the only surviving constraints.
      // Never silently discard them or extension-injected context and approve.
      if (!NON_CONTEXT_ENTRY_TYPES.has(String(entry.type)))
        context.truncated = true;
      continue;
    }
    const message = toRecord(entry.message);
    // Pi's prompt snapshots and patches are not conversation evidence.
    if (message.role === "system") continue;

    if (
      message.role === "assistant" &&
      Array.isArray(message.content) &&
      toolCallId &&
      message.content.some(
        (part: unknown) =>
          toRecord(part).type === "toolCall" &&
          toRecord(part).id === toolCallId,
      )
    )
      break;
    if (
      message.role === "toolResult" &&
      toolCallId &&
      message.toolCallId === toolCallId
    )
      break;
    if (!["user", "assistant", "toolResult"].includes(String(message.role))) {
      context.truncated = true;
      continue;
    }
    // User constraints can occur anywhere in any message. Keep authorization
    // text intact; the total input limit falls back to manual approval.
    if (message.role === "user")
      context.user_messages.push(readContextText(message.content, "user"));
    if (message.role === "assistant") {
      context.assistant_statement = readContextText(
        message.content,
        "assistant",
      );
      for (const part of Array.isArray(message.content)
        ? message.content
        : []) {
        const call = toRecord(part);
        if (call.type === "toolCall")
          context.prior_actions.push({
            call_id: call.id,
            tool: call.name,
            arguments_excerpt: JSON.stringify(call.arguments) ?? "",
          });
      }
    }
    if (message.role === "toolResult")
      context.prior_tool_results.push({
        call_id: message.toolCallId,
        output_excerpt: readContextText(message.content, "toolResult"),
        is_error: message.isError === true,
      });
  }
  // Keep all pre-action tool evidence: even an older result or a suffix can
  // establish risk. Legacy *_excerpt field names now carry complete text.
  // The total input limit asks the user instead of discarding evidence.
  return { context, action: { tool, arguments: args } };
}

export function isAutoReviewInput(value: unknown): value is AutoReviewInput {
  const record = toRecord(value);
  const context = toRecord(record.context);
  const action = toRecord(record.action);
  const parentEvidence = toRecord(context.parent_evidence);
  try {
    return (
      typeof context.cwd === "string" &&
      context.cwd.length > 0 &&
      Array.isArray(context.user_messages) &&
      context.user_messages.every((v: unknown) => typeof v === "string") &&
      typeof context.assistant_statement === "string" &&
      Array.isArray(context.prior_actions) &&
      Array.isArray(context.prior_tool_results) &&
      typeof context.truncated === "boolean" &&
      (context.parent_user_messages === undefined ||
        (Array.isArray(context.parent_user_messages) &&
          context.parent_user_messages.every(
            (v: unknown) => typeof v === "string",
          ))) &&
      (context.parent_evidence === undefined ||
        (typeof parentEvidence.cwd === "string" &&
          parentEvidence.cwd.length > 0 &&
          typeof parentEvidence.assistant_statement === "string" &&
          Array.isArray(parentEvidence.prior_actions) &&
          Array.isArray(parentEvidence.prior_tool_results))) &&
      typeof action.tool === "string" &&
      action.tool.length > 0 &&
      Object.hasOwn(action, "arguments") &&
      JSON.stringify(value).length <= MAX_REVIEW_INPUT_CHARS
    );
  } catch {
    return false;
  }
}

export function isCodexModel(model: unknown): boolean {
  const record = toRecord(model);
  return (
    record.provider === "openai-codex" ||
    record.api === "openai-codex-responses"
  );
}

function parseDecision(
  value: unknown,
  provider: AutoReviewResult["provider"],
): AutoReviewResult {
  const record = toRecord(value);
  // Codex produces free-form JSON: tolerate extra fields, but require an exact
  // decision value. Never expose or use those fields as authorization.
  if (record.outcome !== "allow" && record.outcome !== "deny") {
    return {
      outcome: "ask",
      reason: "Auto reviewer returned an invalid decision.",
      provider,
    };
  }
  return record.outcome === "allow"
    ? {
        outcome: "allow",
        reason: "Auto reviewer approved this action once.",
        provider,
      }
    : {
        outcome: "ask",
        reason: "Auto reviewer requested your approval.",
        provider,
      };
}

type CodexComplete = (
  model: Model<Api>,
  context: Record<string, unknown>,
  options: Record<string, unknown>,
) => Promise<unknown>;

/** Exported dependency boundary for tests; production calls Pi's authenticated provider. */
export interface AutoReviewDependencies {
  fetch?: typeof fetch;
  completeCodex?: CodexComplete;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export async function reviewAutoPermission(
  ctx: Pick<ExtensionContext, "model" | "modelRegistry">,
  input: AutoReviewInput,
  reviewer: AutoReviewer,
  signal?: AbortSignal,
  dependencies: AutoReviewDependencies = {},
): Promise<AutoReviewResult> {
  if (signal?.aborted)
    return { outcome: "cancelled", reason: "Permission review was cancelled." };
  if (!isAutoReviewInput(input))
    return {
      outcome: "ask",
      reason: "Action or context exceeds the auto-review limits.",
    };
  // Older child sessions may forward snapshots with clipped or omitted history.
  if (input.context.truncated)
    return {
      outcome: "ask",
      reason: "Auto-review evidence is incomplete or truncated; please decide.",
    };
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal?.addEventListener("abort", cancel, { once: true });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let abortListener: (() => void) | undefined;
  const env = dependencies.env ?? process.env;
  const provider =
    reviewer === "jev"
      ? "typesafe"
      : isCodexModel(ctx.model)
        ? "codex"
        : "openai";
  const run = async (): Promise<AutoReviewResult> => {
    if (provider === "codex") {
      const main = ctx.model as Model<Api>;
      const registry = ctx.modelRegistry as {
        find?: (provider: string, id: string) => Model<Api> | undefined;
        getApiKeyAndHeaders?: (
          model: Model<Api>,
        ) => Promise<{ apiKey?: string; headers?: Record<string, string> }>;
        getApiKey?: (model: Model<Api>) => Promise<string | undefined>;
      };
      // Older Pi catalogs predate Luna. Reuse the current Codex transport, never the acting model ID.
      const model = registry?.find?.(main.provider, LUNA_MODEL) ?? {
        ...main,
        id: LUNA_MODEL,
        name: "GPT-6 Luna",
        reasoning: true,
        thinkingLevelMap: undefined,
      };
      const auth = registry?.getApiKeyAndHeaders
        ? await registry.getApiKeyAndHeaders(model)
        : { apiKey: await registry?.getApiKey?.(model) };
      if (!auth.apiKey)
        return {
          outcome: "ask",
          reason: "Codex credentials are unavailable for Luna review.",
          provider,
        };
      if (controller.signal.aborted) throw new Error("cancelled");
      const complete =
        dependencies.completeCodex ??
        ((await import("@earendil-works/pi-ai"))
          .completeSimple as CodexComplete);
      const response = toRecord(
        await complete(
          model,
          {
            systemPrompt: AUTO_REVIEW_POLICY,
            messages: [
              {
                role: "user",
                content: [{ type: "text", text: JSON.stringify(input) }],
                timestamp: Date.now(),
              },
            ],
          },
          {
            apiKey: auth.apiKey,
            headers: auth.headers,
            reasoning: "low",
            maxTokens: 2048,
            signal: controller.signal,
            transport: "sse",
            sessionId: `permission-review-${randomUUID()}`,
          },
        ),
      );
      if (response.stopReason !== "stop")
        return {
          outcome: "ask",
          reason: "Codex review did not complete successfully.",
          provider,
        };
      return parseDecision(JSON.parse(textContent(response.content)), provider);
    }
    const key =
      env[
        provider === "typesafe" ? "TYPESAFE_API_KEY" : "OPENAI_API_KEY"
      ]?.trim();
    if (!key)
      return {
        outcome: "ask",
        reason: `Missing ${provider === "typesafe" ? "TYPESAFE_API_KEY" : "OPENAI_API_KEY"} for auto review.`,
        provider,
      };
    const body =
      provider === "typesafe"
        ? {
            model: JEV_MODEL,
            state: JSON.stringify(input),
            questions: {
              permission: {
                type: "choice",
                instructions: AUTO_REVIEW_POLICY,
                criteria: {
                  allow: "Approve this exact action once under the policy.",
                  deny: "Ask the user before executing this action.",
                },
              },
            },
          }
        : {
            model: LUNA_MODEL,
            store: false,
            reasoning: { effort: "low" },
            max_output_tokens: 2048,
            instructions: AUTO_REVIEW_POLICY,
            input: JSON.stringify(input),
            text: {
              format: {
                type: "json_schema",
                name: "permission_decision",
                strict: true,
                schema: {
                  type: "object",
                  properties: {
                    outcome: { type: "string", enum: ["allow", "deny"] },
                  },
                  required: ["outcome"],
                  additionalProperties: false,
                },
              },
            },
          };
    const response = await (dependencies.fetch ?? fetch)(
      provider === "typesafe"
        ? "https://api.typesafe.ai/v1/systemone"
        : "https://api.openai.com/v1/responses",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
        redirect: "error",
      },
    );
    if (!response.ok)
      return {
        outcome: "ask",
        reason: `Auto reviewer service returned HTTP ${response.status}.`,
        provider,
      };
    const result = toRecord(await response.json());
    if (provider === "typesafe") {
      return parseDecision(
        { outcome: toRecord(toRecord(result.answers).permission).choice },
        provider,
      );
    }
    if (result.status !== "completed")
      return {
        outcome: "ask",
        reason: "Auto reviewer response was incomplete.",
        provider,
      };
    const output = Array.isArray(result.output) ? result.output : [];
    const text = output
      .filter((item: unknown) => toRecord(item).type === "message")
      .flatMap((item: unknown) => toRecord(item).content ?? [])
      .filter((part: unknown) => toRecord(part).type === "output_text")
      .map((part: unknown) => toRecord(part).text)
      .join("");
    return parseDecision(JSON.parse(text), provider);
  };
  try {
    // Bound credential resolution as well as the request, even if a provider ignores AbortSignal.
    const deadline = new Promise<AutoReviewResult>((resolve) => {
      abortListener = () =>
        resolve({
          outcome: signal?.aborted ? "cancelled" : "ask",
          reason: signal?.aborted
            ? "Permission review was cancelled."
            : "Auto review timed out; please decide.",
          provider,
        });
      controller.signal.addEventListener("abort", abortListener, {
        once: true,
      });
      timeout = setTimeout(
        cancel,
        dependencies.timeoutMs ?? AUTO_REVIEW_TIMEOUT_MS,
      );
    });
    const result = await Promise.race([run(), deadline]);
    return signal?.aborted
      ? {
          outcome: "cancelled",
          reason: "Permission review was cancelled.",
          provider,
        }
      : result;
  } catch {
    // Never echo provider error bodies or auth exceptions; they can contain credentials or request data.
    return {
      outcome: signal?.aborted ? "cancelled" : "ask",
      reason:
        "Auto reviewer unavailable or returned an invalid response; please decide.",
      provider,
    };
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", cancel);
    if (abortListener)
      controller.signal.removeEventListener("abort", abortListener);
  }
}
