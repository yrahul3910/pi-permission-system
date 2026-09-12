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
