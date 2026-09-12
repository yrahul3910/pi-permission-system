import assert from "node:assert/strict";

import {
  requestPermissionDecisionFromUi,
  type PermissionDecisionUi,
} from "../src/permission-dialog.js";
import { TurnRuntimeTracker } from "../src/turn-runtime.js";
import { runAsyncTest } from "./test-harness.js";

function createDialogUi() {
  const shown: string[] = [];
  let answer: (value: string | undefined) => void = () => {
    throw new Error("No visible permission dialog");
  };
  let fail: (error: Error) => void = () => {
    throw new Error("No visible permission dialog");
  };
  const show = (title: string): Promise<string | undefined> => {
    shown.push(title);
    return new Promise((resolve, reject) => {
      answer = resolve;
      fail = reject;
    });
  };
  const ui: PermissionDecisionUi = { select: show, input: show };
  return {
    ui,
    shown,
    answer: (value: string | undefined) => answer(value),
    fail: (error: Error) => fail(error),
  };
}

await runAsyncTest(
  "concurrent local and forwarded dialogs both resolve and resume the timer",
  async () => {
    const dialog = createDialogUi();
    let timers = 0;
    const runtime = new TurnRuntimeTracker({
      scheduler: {
        setInterval: () => {
          timers += 1;
          return () => {
            timers -= 1;
          };
        },
      },
    });
    runtime.start({});
    const forwarded = runtime.pauseWhile(() =>
      requestPermissionDecisionFromUi(dialog.ui, "Subagent", "find"),
    );
    const local = runtime.pauseWhile(() =>
      requestPermissionDecisionFromUi(dialog.ui, "Local", "read"),
    );
    try {
      assert.deepEqual(dialog.shown, ["Subagent\nfind"]);
      assert.equal(timers, 0);
      dialog.answer("Allow Once");
      assert.equal((await forwarded).approved, true);
      assert.deepEqual(dialog.shown, ["Subagent\nfind", "Local\nread"]);
      assert.equal(timers, 0);
      dialog.answer("Reject");
      assert.equal((await local).approved, false);
      assert.equal(timers, 1);
    } finally {
      runtime.stop();
    }
  },
);

await runAsyncTest(
  "a rejection reason keeps its place ahead of queued permissions",
  async () => {
    const dialog = createDialogUi();
    const first = requestPermissionDecisionFromUi(dialog.ui, "First", "write");
    const second = requestPermissionDecisionFromUi(dialog.ui, "Second", "read");
    const third = requestPermissionDecisionFromUi(dialog.ui, "Third", "bash");
    dialog.answer("Reject with Reason");
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(dialog.shown.length, 2);
    assert.match(dialog.shown[1], /Share why this request was denied/);
    dialog.answer("Wrong file");
    assert.deepEqual(await first, {
      approved: false,
      state: "reject",
      denialReason: "Wrong file",
    });
    assert.equal(dialog.shown.at(-1), "Second\nread");
    dialog.answer(undefined);
    assert.equal((await second).approved, false);
    assert.equal(dialog.shown.at(-1), "Third\nbash");
    dialog.answer("Allow Once");
    assert.equal((await third).approved, true);
  },
);

await runAsyncTest(
  "dialog failures release the queue without approving the failed request",
  async () => {
    const dialog = createDialogUi();
    const first = requestPermissionDecisionFromUi(dialog.ui, "First", "write");
    const rejected = assert.rejects(first, /UI failed/);
    const second = requestPermissionDecisionFromUi(dialog.ui, "Second", "read");
    dialog.fail(new Error("UI failed"));
    await rejected;
    assert.equal(dialog.shown.at(-1), "Second\nread");
    dialog.answer("Allow Once");
    assert.equal((await second).approved, true);
  },
);

await runAsyncTest(
  "independent UI contexts can answer permissions independently",
  async () => {
    const left = createDialogUi();
    const right = createDialogUi();
    const first = requestPermissionDecisionFromUi(left.ui, "Left", "read");
    const second = requestPermissionDecisionFromUi(right.ui, "Right", "read");
    assert.equal(left.shown.length, 1);
    assert.equal(right.shown.length, 1);
    right.answer("Allow Once");
    assert.equal((await second).approved, true);
    left.answer("Reject");
    assert.equal((await first).approved, false);
  },
);

await runAsyncTest(
  "a queued timed permission expires without displaying or releasing the active dialog",
  async () => {
    const dialog = createDialogUi();
    const local = requestPermissionDecisionFromUi(dialog.ui, "Local", "read");
    let expiration:
      Awaited<ReturnType<typeof requestPermissionDecisionFromUi>> | undefined;
    const timed = requestPermissionDecisionFromUi(
      dialog.ui,
      "Expired",
      "find",
      {
        timeoutMs: 20,
        timeoutDenialReason: "permission_timeout: queued request expired",
      },
    ).then((decision) => {
      expiration = decision;
      return decision;
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.deepEqual(expiration, {
      approved: false,
      state: "reject",
      denialReason: "permission_timeout: queued request expired",
    });
    const next = requestPermissionDecisionFromUi(dialog.ui, "Next", "write");
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(dialog.shown, ["Local\nread"]);
    dialog.answer("Allow Once");
    await local;
    await timed;
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(dialog.shown, ["Local\nread", "Next\nwrite"]);
    dialog.answer("Allow Once");
    assert.equal((await next).approved, true);
  },
);

await runAsyncTest(
  "the visible dialog gets only the timeout remaining after its queue wait",
  async () => {
    const dialog = createDialogUi();
    const timeouts: Array<number | undefined> = [];
    const ui: PermissionDecisionUi = {
      ...dialog.ui,
      select: (title, choices, options) => {
        timeouts.push(options?.timeout);
        return dialog.ui.select(title, choices, options);
      },
    };
    const originalNow = Date.now;
    let now = originalNow();
    Date.now = () => now;
    try {
      const local = requestPermissionDecisionFromUi(ui, "Local", "read");
      const timed = requestPermissionDecisionFromUi(ui, "Timed", "find", {
        timeoutMs: 10_000,
      });
      now += 4_000;
      dialog.answer("Allow Once");
      await local;
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.deepEqual(timeouts, [undefined, 6_000]);
      dialog.answer("Allow Once");
      assert.equal((await timed).approved, true);
    } finally {
      Date.now = originalNow;
    }
  },
);

await runAsyncTest(
  "a request whose deadline passes before its queue handoff never opens a selector",
  async () => {
    const dialog = createDialogUi();
    const originalNow = Date.now;
    let now = originalNow();
    Date.now = () => now;
    try {
      const local = requestPermissionDecisionFromUi(dialog.ui, "Local", "read");
      const timed = requestPermissionDecisionFromUi(
        dialog.ui,
        "Expired",
        "find",
        {
          timeoutMs: 10_000,
        },
      );
      now += 10_000;
      dialog.answer("Allow Once");
      await local;
      assert.deepEqual(await timed, { approved: false, state: "reject" });
      assert.deepEqual(dialog.shown, ["Local\nread"]);
      const next = requestPermissionDecisionFromUi(dialog.ui, "Next", "write");
      assert.equal(dialog.shown.at(-1), "Next\nwrite");
      dialog.answer("Allow Once");
      assert.equal((await next).approved, true);
    } finally {
      Date.now = originalNow;
    }
  },
);

await runAsyncTest(
  "a rejection reason uses only the request's remaining lifetime",
  async () => {
    const originalNow = Date.now;
    let now = originalNow();
    Date.now = () => now;
    const expiresAt = now + 100;
    const timeouts: Array<number | undefined> = [];
    const ui: PermissionDecisionUi = {
      select: async (_title, _choices, options) => {
        timeouts.push(options?.timeout);
        now += 25;
        return "Reject with Reason";
      },
      input: async (_title, _placeholder, options) => {
        timeouts.push(options?.timeout);
        return "Wrong file";
      },
    };
    try {
      const decision = await requestPermissionDecisionFromUi(
        ui,
        "Forwarded",
        "write",
        { expiresAt },
      );
      assert.deepEqual(timeouts, [100, 75]);
      assert.deepEqual(decision, {
        approved: false,
        state: "reject",
        denialReason: "Wrong file",
      });
    } finally {
      Date.now = originalNow;
    }
  },
);

await runAsyncTest(
  "an already expired request never opens a dialog",
  async () => {
    const dialog = createDialogUi();
    const decision = await requestPermissionDecisionFromUi(
      dialog.ui,
      "Expired",
      "find",
      {
        expiresAt: Date.now() - 1,
        timeoutDenialReason: "request expired",
      },
    );
    assert.deepEqual(decision, {
      approved: false,
      state: "reject",
      denialReason: "request expired",
    });
    assert.deepEqual(dialog.shown, []);
  },
);

for (const selection of ["Reject", undefined]) {
  await runAsyncTest(
    `manual rejection ${selection ?? "Escape"} is not reported as expiry`,
    async () => {
      const dialog = createDialogUi();
      const decision = requestPermissionDecisionFromUi(
        dialog.ui,
        "Forwarded",
        "find",
        {
          expiresAt: Date.now() + 60_000,
          timeoutDenialReason:
            "permission_timeout: forwarded permission request expired.",
        },
      );
      dialog.answer(selection);
      assert.deepEqual(await decision, { approved: false, state: "reject" });
    },
  );
}

await runAsyncTest(
  "a queue timer cannot expire a request before its wall-clock deadline",
  async () => {
    const dialog = createDialogUi();
    const originalNow = Date.now;
    let now = originalNow();
    Date.now = () => now;
    try {
      const local = requestPermissionDecisionFromUi(dialog.ui, "Local", "read");
      let expired = false;
      const timed = requestPermissionDecisionFromUi(
        dialog.ui,
        "Timed",
        "find",
        {
          expiresAt: now + 20,
        },
      ).then((decision) => {
        expired = true;
        return decision;
      });
      await new Promise((resolve) => setTimeout(resolve, 40));
      assert.equal(
        expired,
        false,
        "a timer wakeup alone does not establish expiry",
      );
      now += 20;
      await new Promise((resolve) => setTimeout(resolve, 40));
      assert.equal(expired, true);
      assert.deepEqual(await timed, { approved: false, state: "reject" });
      dialog.answer("Allow Once");
      await local;
      assert.deepEqual(dialog.shown, ["Local\nread"]);
    } finally {
      Date.now = originalNow;
    }
  },
);
