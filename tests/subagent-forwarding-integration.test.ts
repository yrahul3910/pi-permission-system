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

import {
  resolvePermissionForwardingTargetSessionId,
  SUBAGENT_PARENT_SESSION_ENV_KEY,
} from "../src/permission-forwarding.js";
import { runTest } from "./test-harness.js";

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

console.log("Subagent forwarding integration test suite complete.");
