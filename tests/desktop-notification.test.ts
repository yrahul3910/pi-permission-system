import assert from "node:assert/strict";

import { startTerminalFocusTracker } from "../src/desktop-notification.js";
import { runTest } from "./test-harness.js";

type Handler = (data: string) => { consume?: boolean; data?: string } | undefined;

function createHarness() {
  let handler: Handler | null = null;
  let unsubscribed = false;
  const writes: string[] = [];

  const tracker = startTerminalFocusTracker({
    onTerminalInput: (registered) => {
      handler = registered;
      return () => {
        unsubscribed = true;
      };
    },
    write: (data) => {
      writes.push(data);
    },
  });

  return {
    tracker,
    writes,
    isUnsubscribed: () => unsubscribed,
    send: (data: string) => {
      assert.ok(handler, "expected a terminal input handler to be registered");
      return handler(data);
    },
  };
}

runTest("focus tracker enables focus reporting on start", () => {
  const harness = createHarness();
  assert.ok(harness.writes.includes("\x1b[?1004h"));
});

runTest("focus tracker defaults to focused before any events", () => {
  const harness = createHarness();
  assert.equal(harness.tracker.isFocused(), true);
  assert.equal(harness.tracker.hasObservedFocusEvents(), false);
});

runTest("focus tracker tracks focus-out and focus-in and consumes the events", () => {
  const harness = createHarness();

  const outResult = harness.send("\x1b[O");
  assert.deepEqual(outResult, { consume: true });
  assert.equal(harness.tracker.isFocused(), false);
  assert.equal(harness.tracker.hasObservedFocusEvents(), true);

  const inResult = harness.send("\x1b[I");
  assert.deepEqual(inResult, { consume: true });
  assert.equal(harness.tracker.isFocused(), true);
});

runTest("focus tracker also recognizes the SS3 focus form", () => {
  const harness = createHarness();
  harness.send("\x1bOO");
  assert.equal(harness.tracker.isFocused(), false);
  harness.send("\x1bOI");
  assert.equal(harness.tracker.isFocused(), true);
});

runTest("focus tracker strips focus events but preserves surrounding input", () => {
  const harness = createHarness();
  const result = harness.send("a\x1b[Ob");
  assert.deepEqual(result, { data: "ab" });
  assert.equal(harness.tracker.isFocused(), false);
});

runTest("focus tracker ignores unrelated input", () => {
  const harness = createHarness();
  const result = harness.send("hello");
  assert.equal(result, undefined);
  assert.equal(harness.tracker.isFocused(), true);
});

runTest("focus tracker disables reporting and unsubscribes on dispose", () => {
  const harness = createHarness();
  harness.tracker.dispose();
  assert.ok(harness.writes.includes("\x1b[?1004l"));
  assert.equal(harness.isUnsubscribed(), true);
});

runTest("focus tracker without onTerminalInput reports focused and observes nothing", () => {
  const writes: string[] = [];
  const tracker = startTerminalFocusTracker({ write: (data) => writes.push(data) });
  assert.equal(tracker.isFocused(), true);
  assert.equal(tracker.hasObservedFocusEvents(), false);
  assert.equal(writes.length, 0);
  tracker.dispose();
});

console.log("All desktop-notification tests passed.");
