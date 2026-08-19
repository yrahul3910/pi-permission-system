import assert from "node:assert/strict";

import {
  compactPermissionPromptForSelect,
  requestPermissionDecisionFromUi,
  resolvePermissionDialogRenderLimits,
  type PermissionDecisionUi,
  type PermissionDialogRenderLimits,
} from "../src/permission-dialog.js";
import { runAsyncTest, runTest } from "./test-harness.js";

const STATIC_MAX_VISIBLE_LINES = 32;
const STATIC_MAX_VISIBLE_CHARACTERS = 2_200;

function makeLines(count: number, width: number): string {
  return Array.from(
    { length: count },
    (_value, index) => `line-${String(index + 1).padStart(3, "0")}: ${"x".repeat(Math.max(0, width - 10))}`,
  ).join("\n");
}

function estimateRenderedRows(value: string, contentColumns: number | undefined): number {
  return value.split(/\r\n|\r|\n/).reduce(
    (rows, line) => rows + (contentColumns ? Math.max(1, Math.ceil(line.length / contentColumns)) : 1),
    0,
  );
}

runTest("JITTER: unknown viewport keeps the static compaction caps", () => {
  const limits = resolvePermissionDialogRenderLimits({});
  assert.equal(limits.maxVisibleLines, STATIC_MAX_VISIBLE_LINES);
  assert.equal(limits.maxVisibleCharacters, STATIC_MAX_VISIBLE_CHARACTERS);
  assert.equal(limits.contentColumns, undefined);
});

runTest("JITTER: invalid viewport values are ignored", () => {
  const limits = resolvePermissionDialogRenderLimits({ rows: Number.NaN, columns: -5 });
  assert.equal(limits.maxVisibleLines, STATIC_MAX_VISIBLE_LINES);
  assert.equal(limits.maxVisibleCharacters, STATIC_MAX_VISIBLE_CHARACTERS);
});

runTest("JITTER: a short terminal shrinks the prompt line budget below the terminal height", () => {
  const limits = resolvePermissionDialogRenderLimits({ rows: 24, columns: 80 });
  assert.ok(
    limits.maxVisibleLines < 24,
    `prompt line budget must leave room for the dialog chrome inside 24 rows; got ${limits.maxVisibleLines}`,
  );
  assert.ok(limits.maxVisibleLines >= 4, "prompt line budget must keep the dialog informative");
  assert.ok(
    limits.maxVisibleCharacters <= limits.maxVisibleLines * (80 - 2),
    "character budget must not allow wrapped rows to exceed the line budget",
  );
});

runTest("JITTER: a tall terminal keeps the static caps", () => {
  const limits = resolvePermissionDialogRenderLimits({ rows: 80, columns: 200 });
  assert.equal(limits.maxVisibleLines, STATIC_MAX_VISIBLE_LINES);
  assert.equal(limits.maxVisibleCharacters, STATIC_MAX_VISIBLE_CHARACTERS);
});

runTest("JITTER: a tiny terminal floors the budgets instead of collapsing to zero", () => {
  const limits = resolvePermissionDialogRenderLimits({ rows: 10, columns: 40 });
  assert.ok(limits.maxVisibleLines >= 4);
  assert.ok(limits.maxVisibleCharacters >= 200);
});

runTest("JITTER: compaction fits a tall prompt into a 24-row viewport", () => {
  const limits = resolvePermissionDialogRenderLimits({ rows: 24, columns: 80 });
  const compacted = compactPermissionPromptForSelect(makeLines(60, 60), limits);
  const renderedRows = estimateRenderedRows(compacted, limits.contentColumns);
  assert.ok(
    renderedRows <= limits.maxVisibleLines,
    `compacted prompt must fit the viewport line budget of ${limits.maxVisibleLines}; got ${renderedRows} rows`,
  );
  assert.match(compacted, /compacted|omitted/i, "compacted prompt must tell the user content was omitted");
});

runTest("JITTER: compaction accounts for word-wrapped rows on narrow terminals", () => {
  const limits = resolvePermissionDialogRenderLimits({ rows: 30, columns: 40 });
  assert.ok(limits.contentColumns !== undefined);
  const longLines = Array.from({ length: 12 }, (_value, index) => `entry-${index}: ${"y".repeat(200)}`).join("\n");
  const compacted = compactPermissionPromptForSelect(longLines, limits);
  const renderedRows = estimateRenderedRows(compacted, limits.contentColumns);
  assert.ok(
    renderedRows <= limits.maxVisibleLines + 1,
    `wrap-aware compaction must keep rendered rows within the budget of ${limits.maxVisibleLines}; got ${renderedRows}`,
  );
});

runTest("JITTER: prompts that already fit are returned unchanged", () => {
  const limits: PermissionDialogRenderLimits = resolvePermissionDialogRenderLimits({ rows: 40, columns: 100 });
  const prompt = makeLines(6, 40);
  assert.equal(compactPermissionPromptForSelect(prompt, limits), prompt);
});

await runAsyncTest("JITTER: requestPermissionDecisionFromUi reads the live terminal size", async () => {
  const stdout = process.stdout as { rows?: number; columns?: number };
  const originalRows = stdout.rows;
  const originalColumns = stdout.columns;
  const captured: { title?: string } = {};
  const ui = {
    async select(title: string): Promise<string> {
      captured.title = title;
      return "Reject";
    },
    async input(): Promise<string | undefined> {
      return undefined;
    },
  } satisfies PermissionDecisionUi;

  try {
    stdout.rows = 24;
    stdout.columns = 80;
    const decision = await requestPermissionDecisionFromUi(ui, "Permission Required", makeLines(60, 60));
    assert.equal(decision.approved, false);

    const renderedTitle = captured.title ?? "";
    const limits = resolvePermissionDialogRenderLimits({ rows: 24, columns: 80 });
    const renderedRows = estimateRenderedRows(renderedTitle, limits.contentColumns);
    assert.ok(
      renderedRows <= limits.maxVisibleLines,
      `permission select title must fit a 24-row terminal's line budget of ${limits.maxVisibleLines}; got ${renderedRows} rows`,
    );
    assert.match(renderedTitle, /Permission Required/);
  } finally {
    if (originalRows === undefined) {
      delete stdout.rows;
    } else {
      stdout.rows = originalRows;
    }
    if (originalColumns === undefined) {
      delete stdout.columns;
    } else {
      stdout.columns = originalColumns;
    }
  }
});
