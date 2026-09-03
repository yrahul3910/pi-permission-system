// ---------------------------------------------------------------------------
// Integration coverage: forwarding `ask` prompts from in-process subagents.
//
// BACKGROUND:
//   The permission-forwarding machinery was built for a router that spawns
//   subagents as separate PROCESSES, tagging each with env hints (e.g.
//   PI_AGENT_ROUTER_PARENT_SESSION_ID) that name the interactive parent to
//   forward `ask` prompts to.
//
//   In-process subagent extensions (e.g. tintinweb/pi-subagents) instead spawn
//   child sessions in the SAME Node process, concurrently, with hasUI=false and
//   NONE of those env hints — process.env cannot carry per-child identity when
//   several children share one process. Before this change, such a child could
//   not resolve a forwarding target, so every `ask`-policy tool call inside an
//   in-process subagent was silently auto-denied.
//
//   The fix lets resolvePermissionForwardingTargetSessionId() fall back to an
//   in-process interactive session id (discovered at runtime from the hasUI
//   session) when no env hint is present, while keeping the env hint
//   authoritative for the router case.
// ---------------------------------------------------------------------------

import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { isSubagentExecutionContext } from "../src/index.js";
import {
  resolvePermissionForwardingTargetSessionId,
  SUBAGENT_ENV_HINT_KEYS,
  SUBAGENT_PARENT_SESSION_ENV_KEY,
} from "../src/permission-forwarding.js";
import { runTest } from "./test-harness.js";

// Detection reads process.env hints first; clear them so these cases exercise
// only the in-process (<active_agent>-tag) signal deterministically.
for (const key of SUBAGENT_ENV_HINT_KEYS) {
  delete process.env[key];
}

// A minimal ExtensionContext for isSubagentExecutionContext(): it reads hasUI,
// the system prompt (via ctx.getSystemPrompt), and the session dir. The dir is
// outside PI_AGENT_DIR/subagent-sessions so only the tag branch can match.
function createDetectionContext(options: {
  hasUI: boolean;
  systemPrompt?: string;
}): ExtensionContext {
  return {
    hasUI: options.hasUI,
    getSystemPrompt: (): string | undefined => options.systemPrompt,
    sessionManager: {
      getSessionDir: (): string => tmpdir(),
    },
  } as unknown as ExtensionContext;
}

const ACTIVE_AGENT_PROMPT =
  '<active_agent name="general-purpose"/>\n\n# Environment\nWorking directory: /repo';

runTest(
  "in-process subagent with no env hint forwards to the discovered interactive session",
  () => {
    const target = resolvePermissionForwardingTargetSessionId({
      hasUI: false,
      isSubagent: true,
      currentSessionId: "child-session",
      env: {},
      fallbackTargetSessionId: "ui-parent-session",
    });
    assert.equal(target, "ui-parent-session");
  },
);

runTest(
  "router env hint stays authoritative and wins over the in-process fallback",
  () => {
    const target = resolvePermissionForwardingTargetSessionId({
      hasUI: false,
      isSubagent: true,
      currentSessionId: "child-session",
      env: { [SUBAGENT_PARENT_SESSION_ENV_KEY]: "router-parent-session" },
      fallbackTargetSessionId: "ui-parent-session",
    });
    assert.equal(target, "router-parent-session");
  },
);

runTest(
  "a non-subagent, non-UI session never adopts the in-process fallback target",
  () => {
    const target = resolvePermissionForwardingTargetSessionId({
      hasUI: false,
      isSubagent: false,
      currentSessionId: "some-session",
      env: {},
      fallbackTargetSessionId: "ui-parent-session",
    });
    assert.equal(target, null);
  },
);

runTest(
  "an interactive session resolves to itself and ignores the fallback",
  () => {
    const target = resolvePermissionForwardingTargetSessionId({
      hasUI: true,
      isSubagent: false,
      currentSessionId: "ui-parent-session",
      env: {},
      fallbackTargetSessionId: "some-other-session",
    });
    assert.equal(target, "ui-parent-session");
  },
);

runTest(
  "an unresolved fallback (unknown/empty) yields no target rather than a bogus one",
  () => {
    for (const fallback of ["unknown", "", "   ", null, undefined]) {
      const target = resolvePermissionForwardingTargetSessionId({
        hasUI: false,
        isSubagent: true,
        currentSessionId: "child-session",
        env: {},
        fallbackTargetSessionId: fallback,
      });
      assert.equal(target, null, `fallback ${JSON.stringify(fallback)}`);
    }
  },
);

runTest(
  "a non-interactive session carrying an <active_agent> tag is detected as a subagent",
  () => {
    assert.equal(
      isSubagentExecutionContext(
        createDetectionContext({ hasUI: false, systemPrompt: ACTIVE_AGENT_PROMPT }),
      ),
      true,
    );
  },
);

runTest(
  "a non-interactive session without the tag is not detected as a subagent",
  () => {
    assert.equal(
      isSubagentExecutionContext(
        createDetectionContext({
          hasUI: false,
          systemPrompt: "# Environment\nWorking directory: /repo",
        }),
      ),
      false,
    );
    // No system prompt at all must also fail closed to "not a subagent".
    assert.equal(
      isSubagentExecutionContext(createDetectionContext({ hasUI: false })),
      false,
    );
  },
);

runTest(
  "an interactive session is never treated as a subagent even if the tag is present",
  () => {
    assert.equal(
      isSubagentExecutionContext(
        createDetectionContext({ hasUI: true, systemPrompt: ACTIVE_AGENT_PROMPT }),
      ),
      false,
    );
  },
);

console.log("Subagent forwarding integration test suite complete.");
