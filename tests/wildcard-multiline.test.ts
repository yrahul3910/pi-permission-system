// ---------------------------------------------------------------------------
// Test-first coverage for Issue #24: Bash wildcard rules do not match
// multi-line commands / here-docs
//
// BACKGROUND (Issue #24):
//   compileWildcardPattern() in src/wildcard-matcher.ts creates
//   new RegExp(`^${escaped}$`) where `.*` (from `*` wildcard) uses `.`
//   which does NOT match newline characters by default. No `s` (dotAll)
//   flag is set. This means any bash command containing embedded newlines
//   (heredocs, multi-line strings, here-strings) silently fails to match
//   wildcard rules and falls back to the default permission state.
//
// TEST-FIRST APPROACH:
//   These tests assert the DESIRED behavior after the fix (adding the `s`
//   flag to compileWildcardPattern). They should FAIL against the current
//   production code and PASS once the fix is applied.
//
// Expected fix:
//   In compileWildcardPattern(), change:
//     regex: new RegExp(`^${escaped}$`)
//   to:
//     regex: new RegExp(`^${escaped}$`, 's')
//
// Issue: https://github.com/MasuRii/pi-permission-system/issues/24
// ---------------------------------------------------------------------------

import assert from "node:assert/strict";

import {
  compileWildcardPattern,
  compileWildcardPatterns,
  findCompiledWildcardMatch,
} from "../src/wildcard-matcher.js";
import { runTest, runAsyncTest } from "./test-harness.js";
import type { PermissionState } from "../src/types.js";

// ===========================================================================
// Section 1: compileWildcardPattern — unit tests on regex behavior
// ===========================================================================

runTest("ISSUE-24-FIX: compileWildcardPattern regex DOES match LF newline with wildcard star (expected-failing TDD)", () => {
  const pattern = compileWildcardPattern("python *", "allow" as PermissionState);

  // Single-line works (before and after fix)
  assert.ok(pattern.regex.test("python script.py"), "Single-line should match");

  // Multi-line — this MUST match after the 's' flag is added
  const multiline = "python - <<'PY'\nprint('hi')\nPY";
  assert.equal(
    pattern.regex.test(multiline),
    true,
    "ISSUE-24-TDD: Expected multi-line heredoc to match 'python *' pattern, but it fails because '.' in '.*' doesn't match '\\n' without the 's' flag. Fix: add 's' flag to RegExp in compileWildcardPattern()",
  );
});

runTest("ISSUE-24-FIX: compileWildcardPattern regex DOES match CRLF newline with wildcard star (expected-failing TDD)", () => {
  const pattern = compileWildcardPattern("cat *", "allow" as PermissionState);

  // Single-line works
  assert.ok(pattern.regex.test("cat /etc/hosts"), "Single-line should match");

  // Multi-line with CRLF — should match after 's' flag fix
  const crlfInput = "cat <<'EOF'\r\nhello\r\nEOF";
  assert.equal(
    pattern.regex.test(crlfInput),
    true,
    "ISSUE-24-TDD: Expected CRLF multi-line to match 'cat *' pattern, but it fails. Fix: add 's' flag to RegExp",
  );
});

runTest("ISSUE-24: compileWildcardPattern exact pattern cannot match trailing newline (correct exact-match behavior, not a bug)", () => {
  // This test is NOT about Issue #24. Exact patterns (no `*`) create a regex
  // without `.*`, so the `s` flag doesn't apply. The `$` anchor requires the
  // string to end exactly at the last character — a trailing `\n` causes a
  // mismatch. This is correct JS regex behavior (unlike `$` with `m` flag).
  // Issue #24 only concerns wildcard (`*`) patterns with embedded newlines.
  const pattern = compileWildcardPattern("python heredoc", "allow" as PermissionState);

  assert.ok(pattern.regex.test("python heredoc"), "Exact single-line should match");

  const withNewline = "python heredoc\n";
  assert.equal(
    pattern.regex.test(withNewline),
    false,
    "Exact pattern with trailing newline correctly does NOT match — `$` anchors to end of string without multiline flag; this is correct behavior, not a bug",
  );
});

runTest("ISSUE-24-FIX: compileWildcardPattern with multiple wildcards DOES match newlines (expected-failing TDD)", () => {
  const pattern = compileWildcardPattern("python * *", "allow" as PermissionState);

  assert.ok(pattern.regex.test("python -c 'print(1)'"), "Multi-wildcard single-line should match");

  const multiline = "python - <<'PY'\nprint('hi')\nPY";
  assert.equal(
    pattern.regex.test(multiline),
    true,
    "ISSUE-24-TDD: Expected multi-wildcard pattern with heredoc content to match, but it fails. Fix: add 's' flag to RegExp",
  );
});

// ===========================================================================
// Section 2: Multi-line bash commands under the piece-based evaluator
//
// The redesign made Issue #24 structural: commands are parsed with the real
// bash grammar, so heredoc bodies are data and newline-separated commands
// are evaluated individually. These tests pin that multi-line commands are
// judged by what they execute, in every line-ending and delimiter variant.
// ===========================================================================
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PermissionManager } from "../src/permission-manager.js";

function createMultilineManager(config: Record<string, unknown>) {
  const baseDir = mkdtempSync(join(tmpdir(), "pi-permission-multiline-"));
  const globalConfigPath = join(baseDir, "pi-permissions.jsonc");
  mkdirSync(baseDir, { recursive: true });
  writeFileSync(globalConfigPath, JSON.stringify(config), "utf8");
  return {
    manager: new PermissionManager({ globalConfigPath }),
    cleanup: (): void => rmSync(baseDir, { recursive: true, force: true }),
  };
}

const askDefault = { tools: "ask", bash: "ask", mcp: "ask", skills: "ask", special: "ask" };

runTest("ISSUE-24: heredoc python commands match a python allow rule", () => {
  const { manager, cleanup } = createMultilineManager({
    defaultPolicy: askDefault,
    bash: { allow: ["python"] },
  });
  try {
    const heredocs = [
      "python - <<'PY'\nprint('hello world')\nPY",
      'python - <<"PY"\nprint("hi")\nPY',
      "python - <<PY\nprint('hi')\nPY",
      "python - <<-PY\n\tprint('hi')\n\tPY",
      "python - <<'PY'\n\n\nprint('empty lines above')\nPY",
    ];
    for (const command of heredocs) {
      assert.equal(manager.checkPermission("bash", { command }).state, "allow", command);
    }
    // Without the rule, python is not registry-vouched and asks.
    const { manager: bare, cleanup: cleanupBare } = createMultilineManager({ defaultPolicy: askDefault });
    assert.equal(bare.checkPermission("bash", { command: heredocs[0] }).state, "ask");
    cleanupBare();
  } finally {
    cleanup();
  }
});

runTest("ISSUE-24: heredoc bodies never execute — dangerous body text stays data", () => {
  const { manager, cleanup } = createMultilineManager({
    defaultPolicy: askDefault,
    bash: { allow: ["python"] },
  });
  try {
    const command = "python - <<'PY'\nrm -rf / # just text\nPY";
    const result = manager.checkPermission("bash", { command });
    assert.equal(result.state, "allow");
    assert.deepEqual(result.bashEvaluation?.pieces, []);
  } finally {
    cleanup();
  }
});

runTest("ISSUE-24-EDGE: CRLF and mixed line endings behave like LF", () => {
  const { manager, cleanup } = createMultilineManager({
    defaultPolicy: askDefault,
    bash: { allow: ["python"] },
  });
  try {
    assert.equal(manager.checkPermission("bash", { command: "cat <<'EOF'\r\nline1\r\nEOF" }).state, "allow");
    assert.equal(manager.checkPermission("bash", { command: "python - <<'PY'\r\nprint('mixed')\nPY" }).state, "allow");
  } finally {
    cleanup();
  }
});

runTest("ISSUE-24-EDGE: leading/trailing newlines do not change evaluation", () => {
  const { manager, cleanup } = createMultilineManager({
    defaultPolicy: askDefault,
    bash: { allow: ["python"] },
  });
  try {
    assert.equal(manager.checkPermission("bash", { command: "\npython script.py" }).state, "allow");
    assert.equal(manager.checkPermission("bash", { command: "python script.py\n" }).state, "allow");
    assert.equal(manager.checkPermission("bash", { command: "git status\n" }).state, "allow");
  } finally {
    cleanup();
  }
});

runTest("ISSUE-24-EDGE: trailing comments are not commands", () => {
  const { manager, cleanup } = createMultilineManager({ defaultPolicy: askDefault });
  try {
    const result = manager.checkPermission("bash", { command: "git status --short\n# with trailing comment" });
    assert.equal(result.state, "allow");
  } finally {
    cleanup();
  }
});

runTest("ISSUE-24-EDGE: here-strings are data", () => {
  const { manager, cleanup } = createMultilineManager({ defaultPolicy: askDefault });
  try {
    assert.equal(manager.checkPermission("bash", { command: "cat <<< 'here string'" }).state, "allow");
  } finally {
    cleanup();
  }
});

runTest("ISSUE-24-EDGE: newline-separated commands are evaluated individually", () => {
  const { manager, cleanup } = createMultilineManager({ defaultPolicy: askDefault });
  try {
    // Both lines registry-vouched: allow. One unknown line: ask.
    assert.equal(manager.checkPermission("bash", { command: "git status\nls -la" }).state, "allow");
    const mixed = manager.checkPermission("bash", { command: "git status\nevilcmd --run" });
    assert.equal(mixed.state, "ask");
    assert.equal(mixed.bashEvaluation?.pieces.length, 1);
  } finally {
    cleanup();
  }
});

console.log("Wildcard multiline test suite complete.");
