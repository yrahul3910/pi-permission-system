import assert from "node:assert/strict";

import {
  formatTurnRuntime,
  formatTurnWorkingMessage,
  TurnRuntimeTracker,
  type TurnRuntimeScheduler,
} from "../src/turn-runtime.js";
import { runTest } from "./test-harness.js";

type FakeScheduler = {
  scheduler: TurnRuntimeScheduler;
  tick(): void;
  activeTimerCount(): number;
};

function createFakeScheduler(): FakeScheduler {
  const callbacks = new Set<() => void>();

  return {
    scheduler: {
      setInterval(callback): () => void {
        callbacks.add(callback);
        return () => callbacks.delete(callback);
      },
    },
    tick(): void {
      for (const callback of [...callbacks]) {
        callback();
      }
    },
    activeTimerCount(): number {
      return callbacks.size;
    },
  };
}

runTest("turn runtime formats compact elapsed durations", () => {
  assert.equal(formatTurnRuntime(0), "0s");
  assert.equal(formatTurnRuntime(59_999), "59s");
  assert.equal(formatTurnRuntime(60_000), "1m 00s");
  assert.equal(formatTurnRuntime(3_661_000), "1h 01m 01s");
  assert.equal(formatTurnWorkingMessage(1_500), "Working... (1s)");
});

runTest("turn runtime updates the working message and resets when the turn ends", () => {
  let now = 0;
  const scheduler = createFakeScheduler();
  const messages: Array<string | undefined> = [];
  const tracker = new TurnRuntimeTracker({
    now: () => now,
    scheduler: scheduler.scheduler,
  });

  tracker.start({ setWorkingMessage: (message) => messages.push(message) }, 4, now);
  assert.deepEqual(messages, ["Working... (0s)"]);
  assert.equal(scheduler.activeTimerCount(), 1);

  now = 2_900;
  scheduler.tick();
  assert.equal(messages.at(-1), "Working... (2s)");

  tracker.stop(4);
  assert.equal(messages.at(-1), undefined);
  assert.equal(scheduler.activeTimerCount(), 0);
});

runTest("turn runtime excludes nested permission waits", () => {
  let now = 0;
  const scheduler = createFakeScheduler();
  const messages: Array<string | undefined> = [];
  const tracker = new TurnRuntimeTracker({
    now: () => now,
    scheduler: scheduler.scheduler,
  });

  tracker.start({ setWorkingMessage: (message) => messages.push(message) }, 7, now);
  now = 1_500;
  scheduler.tick();
  assert.equal(messages.at(-1), "Working... (1s)");

  tracker.pause();
  tracker.pause();
  assert.equal(scheduler.activeTimerCount(), 0);
  now = 11_500;
  assert.equal(tracker.elapsedMs, 1_500);

  tracker.resume();
  assert.equal(scheduler.activeTimerCount(), 0);
  now = 21_500;
  assert.equal(tracker.elapsedMs, 1_500);

  tracker.resume();
  assert.equal(scheduler.activeTimerCount(), 1);
  now = 22_500;
  scheduler.tick();
  assert.equal(messages.at(-1), "Working... (2s)");

  tracker.stop(7);
});

console.log("All turn-runtime tests passed.");
