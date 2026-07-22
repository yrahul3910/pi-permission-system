// ===========================================================================
// Bash safety gate + "Allow safe <family> commands this session"
//
// Covers:
//   Section A: Quoted/escaped metacharacters do not falsely trigger
//   Section B: Every safety category and risky-option variant
//   Section C: Malformed shell syntax fails closed
//   Section D: Safe command family derivation
//   Section E: PermissionManager integration (backward compat, clamping,
//              deny precedence, normalization, layered trust)
//   Section F: SessionApprovalStore family approvals
//   Section G: Permission dialog family option + decision states
//   Section H: End-to-end runtime flows through the tool_call handler
//   Section I: Schema / config example validation and config persistence
// ===========================================================================

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  analyzeBashCommand,
  clampPermissionStateWithSafety,
  createBashFamilyPattern,
  deriveBashCommandFamily,
  isSafeSimpleBashCommand,
  normalizeBashSafetyPolicy,
  resolveBashSafetyRequirement,
} from "../src/bash-safety.js";
import {
  CONFIG_PATH_ENV_KEY,
  DEFAULT_EXTENSION_CONFIG,
  LOGS_DIR_ENV_KEY,
  type PermissionSystemExtensionConfig,
} from "../src/extension-config.js";
import piPermissionSystemExtension from "../src/index.js";
import {
  formatSafeFamilyOptionLabel,
  isPermissionDecisionState,
  isSessionPersistentDecisionState,
  requestPermissionDecisionFromUi,
} from "../src/permission-dialog.js";
import {
  PERMISSION_FORWARDING_AGENT_DIR_ENV_KEY,
  PI_AGENT_ROUTER_SHARED_AGENT_DIR_ENV_KEY,
  PI_DELEGATED_AUTH_RUNTIME_DIR_ENV_KEY,
  PI_PERMISSION_SYSTEM_POLICY_AGENT_DIR_ENV_KEY,
  SUBAGENT_ENV_HINT_KEYS,
  SUBAGENT_PARENT_SESSION_ENV_KEY,
} from "../src/permission-forwarding.js";
import { PermissionManager } from "../src/permission-manager.js";
import { SessionApprovalStore } from "../src/session-approval-store.js";
import type { AgentPermissions, BashSafetyCategory, GlobalPermissionConfig } from "../src/types.js";
import { createMockContext, runAsyncTest, runTest } from "./test-harness.js";

const ISOLATED_ENV_KEYS = [
  PERMISSION_FORWARDING_AGENT_DIR_ENV_KEY,
  PI_AGENT_ROUTER_SHARED_AGENT_DIR_ENV_KEY,
  PI_DELEGATED_AUTH_RUNTIME_DIR_ENV_KEY,
  PI_PERMISSION_SYSTEM_POLICY_AGENT_DIR_ENV_KEY,
  ...SUBAGENT_ENV_HINT_KEYS,
  SUBAGENT_PARENT_SESSION_ENV_KEY,
] as const;

for (const key of ISOLATED_ENV_KEYS) {
  delete process.env[key];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function categoriesOf(command: string): BashSafetyCategory[] {
  return analyzeBashCommand(command).categories;
}

function assertClean(command: string): void {
  const analysis = analyzeBashCommand(command);
  assert.deepEqual(
    analysis.findings,
    [],
    `Expected no findings for ${JSON.stringify(command)}, got ${JSON.stringify(analysis.findings)}`,
  );
}

function assertCategory(command: string, category: BashSafetyCategory): void {
  const categories = categoriesOf(command);
  assert.ok(
    categories.includes(category),
    `Expected ${JSON.stringify(command)} to trigger '${category}', got [${categories.join(", ")}]`,
  );
}

function assertNotCategory(command: string, category: BashSafetyCategory): void {
  const categories = categoriesOf(command);
  assert.ok(
    !categories.includes(category),
    `Expected ${JSON.stringify(command)} not to trigger '${category}', got [${categories.join(", ")}]`,
  );
}

function createManager(config: GlobalPermissionConfig, projectConfig?: AgentPermissions): {
  manager: PermissionManager;
  configPath: string;
  cleanup: () => void;
} {
  const baseDir = mkdtempSync(join(tmpdir(), "pi-permission-system-bash-safety-"));
  const globalConfigPath = join(baseDir, "pi-permissions.jsonc");
  const agentsDir = join(baseDir, "agents");
  const projectGlobalConfigPath = join(baseDir, "project", "pi-permissions.jsonc");

  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(globalConfigPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  if (projectConfig) {
    mkdirSync(join(baseDir, "project"), { recursive: true });
    writeFileSync(projectGlobalConfigPath, `${JSON.stringify(projectConfig, null, 2)}\n`, "utf8");
  }

  const manager = new PermissionManager({
    globalConfigPath,
    agentsDir,
    ...(projectConfig ? { projectGlobalConfigPath } : {}),
  });

  return {
    manager,
    configPath: globalConfigPath,
    cleanup: (): void => {
      rmSync(baseDir, { recursive: true, force: true });
    },
  };
}

// ===========================================================================
// Section A: Quoted/escaped metacharacters do not falsely trigger
// ===========================================================================

runTest("A1: single-quoted operators are literal", () => {
  assertClean("echo 'a | b; c > d && e'");
});

runTest("A2: double-quoted operators are literal", () => {
  assertClean('echo "a && b; c | d > e"');
});

runTest("A3: single quotes protect command substitution", () => {
  assertClean("printf 'x $(y) `z`'");
});

runTest("A4: backslash-escaped metacharacters are literal", () => {
  assertClean("echo \\| \\; \\> \\< \\& \\$\\(x\\)");
});

runTest("A5: quoted redirection-looking text is literal", () => {
  assertClean('grep -n "foo>bar" file.txt');
  assertClean('echo "2>&1"');
});

runTest("A6: quoted pipe in rg pattern is literal", () => {
  assertClean('rg "foo|bar" src');
});

runTest("A7: escaped line continuation is not a command separator", () => {
  assertClean("rg foo \\\n src");
});

runTest("A8: trailing newline does not create another command", () => {
  assertClean("rg foo src\n");
});

runTest("A9: word-internal comment marker and trailing comment are safe", () => {
  assertClean("rg foo#bar src");
  assertClean("rg foo src # look | for > things");
});

// ===========================================================================
// Section B: Every safety category triggers
// ===========================================================================

runTest("B1: command substitution $() triggers complexSyntax", () => {
  assertCategory("echo $(whoami)", "complexSyntax");
});

runTest("B2: command substitution inside double quotes still triggers", () => {
  assertCategory('echo "$(date)"', "complexSyntax");
  assertCategory('echo "`date`"', "complexSyntax");
});

runTest("B3: backtick substitution triggers complexSyntax", () => {
  assertCategory("echo `date`", "complexSyntax");
});

runTest("B4: process substitution triggers complexSyntax", () => {
  assertCategory("diff <(sort a.txt) <(sort b.txt)", "complexSyntax");
  assertCategory("tee >(wc -l)", "complexSyntax");
});

runTest("B5: compound operators trigger complexSyntax", () => {
  assertCategory("ls | wc -l", "complexSyntax");
  assertCategory("true || false", "complexSyntax");
  assertCategory("make && make test", "complexSyntax");
  assertCategory("cd /tmp; ls", "complexSyntax");
  assertCategory("sleep 5 &", "complexSyntax");
});

runTest("B6: unquoted newline separating commands triggers complexSyntax", () => {
  assertCategory("rg foo\nrm -rf build", "complexSyntax");
  assertCategory("rg foo\n\nrm -rf build", "complexSyntax");
});

runTest("B7: subshell parentheses trigger complexSyntax", () => {
  assertCategory("echo (foo)", "complexSyntax");
});

runTest("B8: redirection operators trigger redirections", () => {
  for (const command of [
    "echo hi > out.txt",
    "echo hi >> out.txt",
    "sort < in.txt",
    "cat << EOF",
    "cat <<< here-string",
    "cmd 2> err.log",
    "cmd 2>&1",
    "cmd >&2",
    "cmd <&3",
    "cmd &> all.log",
    "cmd &>> all.log",
  ]) {
    assertCategory(command, "redirections");
  }
});

runTest("B9: fd-number redirections do not also trigger complexSyntax", () => {
  assertNotCategory("cmd 2>&1", "complexSyntax");
  assertNotCategory("cmd &> all.log", "complexSyntax");
});

runTest("B10: rg --pre variants trigger riskyOptions", () => {
  assertCategory("rg --pre evil foo src", "riskyOptions");
  assertCategory("rg --pre=evil foo src", "riskyOptions");
  assertCategory("rg '--pre' evil foo", "riskyOptions");
  assertCategory("rg --p're' evil foo", "riskyOptions");
});

runTest("B11: rg non-risky options do not trigger", () => {
  assertNotCategory("rg --pretty foo src", "riskyOptions");
  assertNotCategory("rg -- --pre", "riskyOptions");
  assertNotCategory("rg foo src", "riskyOptions");
});

runTest("B12: fd exec variants trigger riskyOptions", () => {
  assertCategory("fd --exec rm", "riskyOptions");
  assertCategory("fd --exec-batch rm", "riskyOptions");
  assertCategory("fd -x rm pattern", "riskyOptions");
  assertCategory("fd -X rm pattern", "riskyOptions");
  assertCategory("fd -Hx rm pattern", "riskyOptions");
});

runTest("B13: fd non-risky options do not trigger", () => {
  assertNotCategory("fd --extension rs pattern", "riskyOptions");
  assertNotCategory("fd -H pattern", "riskyOptions");
});

runTest("B14: sed in-place variants trigger riskyOptions", () => {
  assertCategory("sed -i s/a/b/ file", "riskyOptions");
  assertCategory("sed -i.bak s/a/b/ file", "riskyOptions");
  assertCategory("sed -ni s/a/b/p file", "riskyOptions");
  assertCategory("sed --in-place s/a/b/ file", "riskyOptions");
  assertCategory("sed --in-place=.bak s/a/b/ file", "riskyOptions");
  assertCategory("/usr/bin/sed -i s/a/b/ file", "riskyOptions");
});

runTest("B15: sed execution expressions trigger riskyOptions", () => {
  assertCategory("sed s/a/b/e file", "riskyOptions");
  assertCategory("sed 's/a/b/ge' file", "riskyOptions");
  assertCategory("sed s_a_b_e file", "riskyOptions");
  assertCategory("sed '1e ls' file", "riskyOptions");
  assertCategory("sed '/foo/e' file", "riskyOptions");
});

runTest("B16: ordinary sed scripts do not trigger riskyOptions", () => {
  assertNotCategory("sed s/a/b/g file", "riskyOptions");
  assertNotCategory("sed -n p file", "riskyOptions");
  assertNotCategory("sed '/e/d' file", "riskyOptions");
});

runTest("B17: git --ext-diff triggers riskyOptions", () => {
  assertCategory("git diff --ext-diff", "riskyOptions");
  assertNotCategory("git diff", "riskyOptions");
  assertNotCategory("git status", "riskyOptions");
});

runTest("B18: risky option inside a piped segment is still detected", () => {
  const categories = categoriesOf("cat f | sed -i s/a/b/");
  assert.ok(categories.includes("complexSyntax"));
  assert.ok(categories.includes("riskyOptions"));
});

// ===========================================================================
// Section C: Malformed syntax fails closed
// ===========================================================================

runTest("C1: unbalanced double quote fails closed as complexSyntax", () => {
  assertCategory('echo "unterminated', "complexSyntax");
});

runTest("C2: unbalanced single quote fails closed as complexSyntax", () => {
  assertCategory("echo 'unterminated", "complexSyntax");
});

runTest("C3: trailing backslash fails closed as complexSyntax", () => {
  assertCategory("echo foo\\", "complexSyntax");
});

runTest("C4: redirection with no target fails closed as complexSyntax", () => {
  assertCategory("echo hi > ", "complexSyntax");
});

runTest("C5: overlong sed script fails closed as complexSyntax", () => {
  assertCategory(`sed ${"x".repeat(1_500)} file`, "complexSyntax");
});

runTest("C6: backslash-heavy sed scripts cannot trigger regex backtracking blowup (ReDoS)", () => {
  // Unterminated s-commands made of backslashes are the classic catastrophic
  // backtracking input for the sed execution-expression regexes. With
  // exponential backtracking even ~40 backslashes would hang; 400 must
  // complete instantly.
  const backslashes = "\\".repeat(400);
  const inputs = [
    `sed 's/${backslashes}' file`,
    `sed 's/${backslashes}e' file`,
    `sed 's${backslashes}' file`,
    `sed '/${backslashes}' file`,
    `sed '/${backslashes}/e${backslashes}' file`,
  ];

  const start = performance.now();
  for (const command of inputs) {
    analyzeBashCommand(command);
  }
  const elapsedMs = performance.now() - start;
  assert.ok(elapsedMs < 1_000, `sed analysis took ${Math.round(elapsedMs)}ms; expected linear-time behavior`);
});

runTest("C7: disjoint sed regexes still detect execution expressions with escapes", () => {
  assertCategory("sed 's/a\\/b/c/e' file", "riskyOptions");
  assertCategory("sed '/a\\/b/e' file", "riskyOptions");
  assertNotCategory("sed 's/a\\/b/c/g' file", "riskyOptions");
});

// ===========================================================================
// Section D: Safe command family derivation
// ===========================================================================

runTest("D1: family derives for one safe simple command", () => {
  assert.equal(deriveBashCommandFamily("rg foo src"), "rg");
  assert.equal(deriveBashCommandFamily("git status"), "git");
  assert.equal(deriveBashCommandFamily("rg"), "rg");
  assert.equal(deriveBashCommandFamily("rg 'quoted arg' src"), "rg");
});

runTest("D2: no family for unsafe or compound commands", () => {
  assert.equal(deriveBashCommandFamily("rg --pre evil foo"), null);
  assert.equal(deriveBashCommandFamily("rg foo > out.txt"), null);
  assert.equal(deriveBashCommandFamily("rg $(cmd) foo"), null);
  assert.equal(deriveBashCommandFamily("rg foo | wc -l"), null);
  assert.equal(deriveBashCommandFamily("rg a && rg b"), null);
  assert.equal(deriveBashCommandFamily("rg a\nrg b"), null);
  assert.equal(deriveBashCommandFamily('echo "unterminated'), null);
});

runTest("D3: no family for ambiguous executables", () => {
  assert.equal(deriveBashCommandFamily("/usr/bin/rg foo"), null, "paths are not a clear family");
  assert.equal(deriveBashCommandFamily("$TOOL foo"), null, "expansions are not confident");
  assert.equal(deriveBashCommandFamily("FOO=1 rg foo"), null, "assignment prefixes are ambiguous");
  assert.equal(deriveBashCommandFamily(""), null);
  assert.equal(deriveBashCommandFamily("   "), null);
});

runTest("D4: no family for wrapper/shell executables", () => {
  for (const command of ["sudo rg foo", "env rg foo", "xargs rm", "bash -c ls", "sh script.sh", "eval ls", "timeout 5 rg foo"]) {
    assert.equal(deriveBashCommandFamily(command), null, `wrapper command should have no family: ${command}`);
  }
});

runTest("D5: helper utilities behave as documented", () => {
  assert.equal(createBashFamilyPattern("rg"), "rg *");
  assert.equal(isSafeSimpleBashCommand("rg foo src"), true);
  assert.equal(isSafeSimpleBashCommand("rg foo | wc"), false);
  assert.equal(clampPermissionStateWithSafety("allow", "ask"), "ask");
  assert.equal(clampPermissionStateWithSafety("deny", "ask"), "deny");
  assert.equal(clampPermissionStateWithSafety("allow", undefined), "allow");
  assert.equal(clampPermissionStateWithSafety("ask", "deny"), "deny");
  assert.equal(resolveBashSafetyRequirement(["redirections"], undefined), "allow");
  assert.equal(resolveBashSafetyRequirement(["redirections"], { redirections: "ask" }), "ask");
  assert.equal(
    resolveBashSafetyRequirement(["complexSyntax", "redirections"], { complexSyntax: "deny", redirections: "ask" }),
    "deny",
  );
});

// ===========================================================================
// Section E: PermissionManager integration
// ===========================================================================

runTest("E1: omitted bashSafety preserves current behavior (all categories allow)", () => {
  const { manager, cleanup } = createManager({
    defaultPolicy: { tools: "ask", bash: "ask", mcp: "ask", skills: "ask", special: "ask" },
    bash: { "rg *": "allow", "wc *": "allow" },
  });

  try {
    assert.equal(manager.checkPermission("bash", { command: "rg --pre evil foo" }).state, "allow");
    assert.equal(manager.checkPermission("bash", { command: "rg foo > out.txt" }).state, "allow");
    assert.equal(manager.checkPermission("bash", { command: "rg foo | wc -l" }).state, "allow");
  } finally {
    cleanup();
  }
});

runTest("E2: safety metadata is attached even when the gate allows", () => {
  const { manager, cleanup } = createManager({
    defaultPolicy: { tools: "ask", bash: "ask", mcp: "ask", skills: "ask", special: "ask" },
    bash: { "rg *": "allow" },
  });

  try {
    const result = manager.checkPermission("bash", { command: "rg --pre evil foo" });
    assert.equal(result.state, "allow");
    assert.ok(result.safety, "bash results carry structured safety metadata");
    assert.deepEqual(result.safety?.categories, ["riskyOptions"]);
    assert.equal(result.safety?.state, "allow");
    assert.ok((result.safety?.findings.length ?? 0) > 0);

    const safe = manager.checkPermission("bash", { command: "rg foo src" });
    assert.deepEqual(safe.safety?.categories, []);
    assert.equal(safe.safety?.family, "rg");
  } finally {
    cleanup();
  }
});

runTest("E3: bashSafety ask clamps a matched allow to ask", () => {
  const { manager, cleanup } = createManager({
    defaultPolicy: { tools: "ask", bash: "ask", mcp: "ask", skills: "ask", special: "ask" },
    bash: { "rg *": "allow" },
    bashSafety: { complexSyntax: "ask", redirections: "ask", riskyOptions: "ask" },
  });

  try {
    const safe = manager.checkPermission("bash", { command: "rg foo src" });
    assert.equal(safe.state, "allow", "ordinary rg command stays allowed");
    assert.equal(safe.matchedPattern, "rg *");

    const risky = manager.checkPermission("bash", { command: "rg --pre evil foo src" });
    assert.equal(risky.state, "ask");
    assert.equal(risky.matchedPattern, "rg *", "matched pattern stays visible for prompts");
    assert.deepEqual(risky.safety?.categories, ["riskyOptions"]);
    assert.equal(risky.safety?.state, "ask");

    const redirected = manager.checkPermission("bash", { command: "rg foo > out.txt" });
    assert.equal(redirected.state, "ask");
    assert.deepEqual(redirected.safety?.categories, ["redirections"]);

    const substituted = manager.checkPermission("bash", { command: "rg $(evil) foo" });
    assert.equal(substituted.state, "ask");
    assert.ok(substituted.safety?.categories.includes("complexSyntax"));
  } finally {
    cleanup();
  }
});

runTest("E4: bashSafety deny clamps a matched allow to deny", () => {
  const { manager, cleanup } = createManager({
    defaultPolicy: { tools: "ask", bash: "ask", mcp: "ask", skills: "ask", special: "ask" },
    bash: { "rg *": "allow" },
    bashSafety: { redirections: "deny" },
  });

  try {
    assert.equal(manager.checkPermission("bash", { command: "rg foo > out.txt" }).state, "deny");
    assert.equal(manager.checkPermission("bash", { command: "rg foo src" }).state, "allow");
  } finally {
    cleanup();
  }
});

runTest("E5: config deny stays deny regardless of safety settings", () => {
  const { manager, cleanup } = createManager({
    defaultPolicy: { tools: "ask", bash: "ask", mcp: "ask", skills: "ask", special: "ask" },
    bash: { "rm *": "deny" },
    bashSafety: { complexSyntax: "ask", redirections: "ask", riskyOptions: "ask" },
  });

  try {
    assert.equal(manager.checkPermission("bash", { command: "rm -rf build" }).state, "deny");
  } finally {
    cleanup();
  }
});

runTest("E6: invalid bashSafety values are ignored during normalization", () => {
  const { manager, cleanup } = createManager({
    defaultPolicy: { tools: "ask", bash: "ask", mcp: "ask", skills: "ask", special: "ask" },
    bash: { "rg *": "allow" },
    bashSafety: { complexSyntax: "banana", redirections: "ask", bogusCategory: "deny" } as never,
  });

  try {
    assert.deepEqual(manager.getBashSafetyPolicy(), { redirections: "ask" });
    assert.equal(manager.checkPermission("bash", { command: "rg $(x) foo" }).state, "allow", "invalid complexSyntax value falls back to allow");
    assert.equal(manager.checkPermission("bash", { command: "rg foo > out" }).state, "ask");
  } finally {
    cleanup();
  }
});

runTest("E7: non-object bashSafety is ignored entirely", () => {
  const { manager, cleanup } = createManager({
    defaultPolicy: { tools: "ask", bash: "ask", mcp: "ask", skills: "ask", special: "ask" },
    bash: { "rg *": "allow" },
    bashSafety: "ask" as never,
  });

  try {
    assert.deepEqual(manager.getBashSafetyPolicy(), {});
    assert.equal(manager.checkPermission("bash", { command: "rg foo > out" }).state, "allow");
  } finally {
    cleanup();
  }
});

runTest("E8: untrusted project layer cannot relax a trusted bashSafety deny", () => {
  const { manager, cleanup } = createManager(
    {
      defaultPolicy: { tools: "ask", bash: "ask", mcp: "ask", skills: "ask", special: "ask" },
      bash: { "rg *": "allow" },
      bashSafety: { redirections: "deny" },
    },
    { bashSafety: { redirections: "allow" } },
  );

  try {
    assert.equal(manager.checkPermission("bash", { command: "rg foo > out.txt" }).state, "deny");
  } finally {
    cleanup();
  }
});

runTest("E9: normalizeBashSafetyPolicy handles malformed input", () => {
  assert.deepEqual(normalizeBashSafetyPolicy(undefined), {});
  assert.deepEqual(normalizeBashSafetyPolicy(null), {});
  assert.deepEqual(normalizeBashSafetyPolicy([]), {});
  assert.deepEqual(normalizeBashSafetyPolicy("deny"), {});
  assert.deepEqual(normalizeBashSafetyPolicy({ complexSyntax: "deny", extras: "allow" }), { complexSyntax: "deny" });
});

runTest("E10: bashSafety config persists across manager instances (file round-trip)", () => {
  const { manager, configPath, cleanup } = createManager({
    defaultPolicy: { tools: "ask", bash: "ask", mcp: "ask", skills: "ask", special: "ask" },
    bashSafety: { complexSyntax: "ask", redirections: "ask", riskyOptions: "ask" },
  });

  try {
    assert.deepEqual(manager.getBashSafetyPolicy(), {
      complexSyntax: "ask",
      redirections: "ask",
      riskyOptions: "ask",
    });

    writeFileSync(configPath, `${JSON.stringify({
      defaultPolicy: { tools: "ask", bash: "ask", mcp: "ask", skills: "ask", special: "ask" },
      bashSafety: { redirections: "deny" },
    }, null, 2)}\n`, "utf8");

    const reloaded = new PermissionManager({
      globalConfigPath: configPath,
      agentsDir: join(configPath, "..", "agents"),
    });
    assert.deepEqual(reloaded.getBashSafetyPolicy(), { redirections: "deny" });
  } finally {
    cleanup();
  }
});

// ===========================================================================
// Section F: SessionApprovalStore family approvals
// ===========================================================================

runTest("F1: family approval allows another ordinary command of the family", () => {
  const store = new SessionApprovalStore();
  assert.equal(store.approveSafeFamilyAlways("bash", "rg"), "rg *");
  assert.equal(store.hasSessionApproval("bash", "rg foo src"), true);
  assert.equal(store.hasSessionApproval("bash", "rg bar --context 3 lib"), true);
  assert.equal(store.hasSessionApproval("bash", "rg"), true);
  assert.equal(store.hasSessionApproval("bash", "git status"), false);
});

runTest("F2: family approval never matches safety-gated variants", () => {
  const store = new SessionApprovalStore();
  store.approveSafeFamilyAlways("bash", "rg");

  for (const command of [
    "rg --pre evil foo",
    "rg foo > out.txt",
    "rg foo >> out.txt",
    "rg $(cmd) foo",
    "rg `cmd` foo",
    "rg <(cmd) foo",
    "rg foo | rg bar",
    "rg a && rg b",
    "rg a; rg b",
    "rg a\nrg b",
    'rg "unterminated',
  ]) {
    assert.equal(
      store.hasSessionApproval("bash", command),
      false,
      `family approval must not authorize ${JSON.stringify(command)}`,
    );
  }
});

runTest("F3: exact Allow Always approvals keep their existing behavior", () => {
  const store = new SessionApprovalStore();
  store.approveAlways("bash", "rg foo | wc -l");
  assert.equal(store.hasSessionApproval("bash", "rg foo | wc -l"), true);
  assert.equal(store.hasSessionApproval("bash", "rg other | wc -l"), false);
  assert.equal(store.hasExactAllowApproval("bash", "rg foo | wc -l"), true);
  assert.equal(store.hasExactAllowApproval("bash", "rg other"), false);
});

runTest("F4: family approvals are not exact approvals", () => {
  const store = new SessionApprovalStore();
  store.approveSafeFamilyAlways("bash", "rg");
  assert.equal(store.hasExactAllowApproval("bash", "rg *"), false);
});

runTest("F5: family rules only apply to the bash tool", () => {
  const store = new SessionApprovalStore();
  store.approveSafeFamilyAlways("bash", "rg");
  assert.deepEqual(store.getApplicableRules("read", "rg foo"), []);
  assert.equal(store.getApplicableRules("bash", "rg foo").length, 1);
});

runTest("F6: empty family or tool records nothing", () => {
  const store = new SessionApprovalStore();
  assert.equal(store.approveSafeFamilyAlways("bash", "  "), null);
  assert.equal(store.approveSafeFamilyAlways("", "rg"), null);
  assert.deepEqual(store.getRules(), []);
});

// ===========================================================================
// Section G: Permission dialog family option + decision states
// ===========================================================================

runTest("G1: always_family is a valid decision state", () => {
  assert.equal(isPermissionDecisionState("always_family"), true);
  assert.equal(isPermissionDecisionState("always"), true);
  assert.equal(isPermissionDecisionState("family"), false);
});

runTest("G2: session-persistent decision states", () => {
  assert.equal(isSessionPersistentDecisionState("always"), true);
  assert.equal(isSessionPersistentDecisionState("always_family"), true);
  assert.equal(isSessionPersistentDecisionState("once"), false);
  assert.equal(isSessionPersistentDecisionState("reject"), false);
});

await runAsyncTest("G3: dialog offers the family option only when a family is provided", async () => {
  let displayedOptions: string[] | undefined;
  const decision = await requestPermissionDecisionFromUi(
    {
      select: async (_title, options) => {
        displayedOptions = options;
        return formatSafeFamilyOptionLabel("rg");
      },
      input: async () => undefined,
    },
    "Permission Required",
    "Agent requested bash command 'rg foo src'. Allow this command?",
    { safeCommandFamily: "rg" },
  );

  assert.deepEqual(displayedOptions, [
    "Allow Once",
    "Allow Always",
    "Allow safe rg commands this session",
    "Reject",
    "Reject with Reason",
  ]);
  assert.equal(decision.approved, true);
  assert.equal(decision.state, "always_family");
});

await runAsyncTest("G4: dialog keeps the four standard options without a family", async () => {
  let displayedOptions: string[] | undefined;
  const decision = await requestPermissionDecisionFromUi(
    {
      select: async (_title, options) => {
        displayedOptions = options;
        // A stale/forged family label must not be accepted when no family
        // option was offered.
        return formatSafeFamilyOptionLabel("rg");
      },
      input: async () => undefined,
    },
    "Permission Required",
    "Agent requested bash command 'rg foo | wc -l'. Allow this command?",
  );

  assert.deepEqual(displayedOptions, [
    "Allow Once",
    "Allow Always",
    "Reject",
    "Reject with Reason",
  ]);
  assert.equal(decision.approved, false);
  assert.equal(decision.state, "reject");
});

// ===========================================================================
// Section H: End-to-end runtime flows through the tool_call handler
// ===========================================================================

type MockHandler = (
  event: Record<string, unknown>,
  ctx: Record<string, unknown>,
) => Promise<Record<string, unknown> | void> | Record<string, unknown> | void;

type RuntimeHarness = {
  cwd: string;
  prompts: string[];
  handlers: Record<string, MockHandler>;
  cleanup: () => Promise<void>;
};

type RuntimeCallOptions = {
  hasUI?: boolean;
  selectResponse?: string;
  inputResponse?: string;
  extensionConfig?: PermissionSystemExtensionConfig;
};

function createRuntimeHarness(config: GlobalPermissionConfig): RuntimeHarness {
  const baseDir = mkdtempSync(join(tmpdir(), "pi-permission-system-bash-safety-runtime-"));
  const cwd = join(baseDir, "workspace");
  const prompts: string[] = [];
  const handlers: Record<string, MockHandler> = {};
  const extensionConfigPath = join(baseDir, "extension-config.json");
  const logsDir = join(baseDir, "logs");
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  const originalConfigPath = process.env[CONFIG_PATH_ENV_KEY];
  const originalLogsDir = process.env[LOGS_DIR_ENV_KEY];

  mkdirSync(join(baseDir, "agents"), { recursive: true });
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(baseDir, "pi-permissions.jsonc"), `${JSON.stringify(config, null, 2)}\n`, "utf8");
  writeFileSync(extensionConfigPath, `${JSON.stringify(DEFAULT_EXTENSION_CONFIG, null, 2)}\n`, "utf8");

  process.env.PI_CODING_AGENT_DIR = baseDir;
  process.env[CONFIG_PATH_ENV_KEY] = extensionConfigPath;
  process.env[LOGS_DIR_ENV_KEY] = logsDir;

  piPermissionSystemExtension({
    on: (name: string, handler: MockHandler): void => {
      handlers[name] = handler;
    },
    registerCommand: (): void => {},
    getAllTools: (): Array<{ name: string }> => [{ name: "bash" }],
    setActiveTools: (): void => {},
    registerProvider: (): void => {},
    events: {
      emit: (): void => {},
    },
  } as never);

  return {
    cwd,
    prompts,
    handlers,
    cleanup: async (): Promise<void> => {
      await Promise.resolve(handlers.session_shutdown?.({}, createMockContext(cwd, prompts, { sessionId: "bash-safety-session" })));
      if (originalAgentDir === undefined) {
        delete process.env.PI_CODING_AGENT_DIR;
      } else {
        process.env.PI_CODING_AGENT_DIR = originalAgentDir;
      }
      if (originalConfigPath === undefined) {
        delete process.env[CONFIG_PATH_ENV_KEY];
      } else {
        process.env[CONFIG_PATH_ENV_KEY] = originalConfigPath;
      }
      if (originalLogsDir === undefined) {
        delete process.env[LOGS_DIR_ENV_KEY];
      } else {
        process.env[LOGS_DIR_ENV_KEY] = originalLogsDir;
      }
      rmSync(baseDir, { recursive: true, force: true });
    },
  };
}

async function startSession(harness: RuntimeHarness): Promise<void> {
  const handler = harness.handlers.session_start;
  assert.equal(typeof handler, "function");
  await Promise.resolve(handler({ reason: "startup" }, createMockContext(harness.cwd, harness.prompts, { sessionId: "bash-safety-session" })));
}

async function runBashToolCall(
  harness: RuntimeHarness,
  command: string,
  options: RuntimeCallOptions = {},
): Promise<Record<string, unknown>> {
  const handler = harness.handlers.tool_call;
  assert.equal(typeof handler, "function");
  const result = await Promise.resolve(handler(
    {
      toolName: "bash",
      toolCallId: `bash-safety-${Math.random().toString(36).slice(2, 10)}`,
      input: { command },
    },
    createMockContext(harness.cwd, harness.prompts, { sessionId: "bash-safety-session", ...options }),
  ));
  return (result ?? {}) as Record<string, unknown>;
}

const ASK_EVERYTHING: GlobalPermissionConfig = {
  defaultPolicy: { tools: "allow", bash: "ask", mcp: "ask", skills: "ask", special: "ask" },
};

await runAsyncTest("H1: family approval allows later ordinary commands but not gated variants", async () => {
  const harness = createRuntimeHarness(ASK_EVERYTHING);

  try {
    await startSession(harness);

    const first = await runBashToolCall(harness, "rg foo src", {
      hasUI: true,
      selectResponse: formatSafeFamilyOptionLabel("rg"),
    });
    assert.deepEqual(first, {}, "family approval approves the prompted command");
    assert.equal(harness.prompts.length, 1);

    const second = await runBashToolCall(harness, "rg bar lib");
    assert.deepEqual(second, {}, "another ordinary rg command is allowed without a prompt");
    assert.equal(harness.prompts.length, 1, "no additional prompt for the approved family");

    for (const gated of [
      "rg --pre evil foo",
      "rg foo > out.txt",
      "rg $(cmd) foo",
      "rg foo | wc -l",
      "rg a && rg b",
      "rg a\nrg b",
    ]) {
      const blocked = await runBashToolCall(harness, gated);
      assert.equal(blocked.block, true, `family approval must not authorize ${JSON.stringify(gated)}`);
      assert.match(String(blocked.reason), /requires approval/i);
    }

    const otherFamily = await runBashToolCall(harness, "git status");
    assert.equal(otherFamily.block, true, "family approval does not leak to other families");
  } finally {
    await harness.cleanup();
  }
});

await runAsyncTest("H2: no family option is offered for unsafe or ambiguous commands", async () => {
  const harness = createRuntimeHarness(ASK_EVERYTHING);

  try {
    await startSession(harness);

    // The mock UI always answers with the family label. Because the command is
    // compound, the dialog does not offer that option, so the answer cannot be
    // interpreted as an approval.
    const compound = await runBashToolCall(harness, "rg foo | wc -l", {
      hasUI: true,
      selectResponse: formatSafeFamilyOptionLabel("rg"),
    });
    assert.equal(compound.block, true, "a forged family answer must not approve a compound command");

    const laterOrdinary = await runBashToolCall(harness, "rg simple");
    assert.equal(laterOrdinary.block, true, "nothing was persisted from the forged answer");

    const wrapper = await runBashToolCall(harness, "sudo rg foo", {
      hasUI: true,
      selectResponse: formatSafeFamilyOptionLabel("sudo"),
    });
    assert.equal(wrapper.block, true, "wrapper executables never get a family option");
  } finally {
    await harness.cleanup();
  }
});

await runAsyncTest("H3: bashSafety ask clamps configured allows and prompts with the safety reason", async () => {
  const harness = createRuntimeHarness({
    defaultPolicy: { tools: "allow", bash: "ask", mcp: "ask", skills: "ask", special: "ask" },
    bash: { "rg *": "allow" },
    bashSafety: { complexSyntax: "ask", redirections: "ask", riskyOptions: "ask" },
  });

  try {
    await startSession(harness);

    const ordinary = await runBashToolCall(harness, "rg foo src");
    assert.deepEqual(ordinary, {}, "ordinary rg stays allowed without a prompt");

    for (const gated of ["rg foo > out.txt", "rg --pre evil foo", "rg $(x) foo"]) {
      const blocked = await runBashToolCall(harness, gated);
      assert.equal(blocked.block, true, `expected ${JSON.stringify(gated)} to require approval`);
    }

    const prompted = await runBashToolCall(harness, "rg foo > out.txt", {
      hasUI: true,
      selectResponse: "Allow Once",
    });
    assert.deepEqual(prompted, {});
    const lastPrompt = harness.prompts[harness.prompts.length - 1] ?? "";
    assert.match(lastPrompt, /Bash safety gate \[redirections\]/, "prompt shows the safety category");
    assert.match(lastPrompt, /redirection '>'/, "prompt shows the safety reason");
  } finally {
    await harness.cleanup();
  }
});

await runAsyncTest("H4: session wildcard approvals do not bypass the safety gate, exact Allow Always does", async () => {
  const harness = createRuntimeHarness({
    defaultPolicy: { tools: "allow", bash: "ask", mcp: "ask", skills: "ask", special: "ask" },
    bashSafety: { complexSyntax: "ask", redirections: "ask", riskyOptions: "ask" },
  });

  try {
    await startSession(harness);

    const approved = await runBashToolCall(harness, "rg foo > out.txt", {
      hasUI: true,
      selectResponse: "Allow Always",
    });
    assert.deepEqual(approved, {});

    const repeat = await runBashToolCall(harness, "rg foo > out.txt");
    assert.deepEqual(repeat, {}, "the exact approved command keeps working (Allow Always unchanged)");

    const different = await runBashToolCall(harness, "rg bar > other.txt");
    assert.equal(different.block, true, "a different redirected command still hits the gate");
  } finally {
    await harness.cleanup();
  }
});

await runAsyncTest("H5: bashSafety deny blocks without prompting and reports the safety reason", async () => {
  const harness = createRuntimeHarness({
    defaultPolicy: { tools: "allow", bash: "ask", mcp: "ask", skills: "ask", special: "ask" },
    bash: { "rg *": "allow" },
    bashSafety: { redirections: "deny" },
  });

  try {
    await startSession(harness);

    const denied = await runBashToolCall(harness, "rg foo > out.txt", { hasUI: true });
    assert.equal(denied.block, true);
    assert.match(String(denied.reason), /Bash safety gate \[redirections\]/);
    assert.equal(harness.prompts.length, 0, "deny never prompts");

    const ordinary = await runBashToolCall(harness, "rg foo src");
    assert.deepEqual(ordinary, {}, "safe commands stay allowed");
  } finally {
    await harness.cleanup();
  }
});

await runAsyncTest("H6: omitted bashSafety keeps the runtime end-to-end behavior unchanged", async () => {
  const harness = createRuntimeHarness({
    defaultPolicy: { tools: "allow", bash: "ask", mcp: "ask", skills: "ask", special: "ask" },
    bash: { "rg *": "allow", "wc *": "allow" },
  });

  try {
    await startSession(harness);

    assert.deepEqual(await runBashToolCall(harness, "rg --pre evil foo"), {});
    assert.deepEqual(await runBashToolCall(harness, "rg foo > out.txt"), {});
    assert.deepEqual(await runBashToolCall(harness, "rg foo | wc -l"), {});
  } finally {
    await harness.cleanup();
  }
});

// ===========================================================================
// Section I: Schema / config example validation
// ===========================================================================

runTest("I1: permissions schema exposes bashSafety with exactly the three categories", () => {
  const schema = JSON.parse(readFileSync(new URL("../schemas/permissions.schema.json", import.meta.url), "utf8")) as {
    properties: Record<string, { type?: string; additionalProperties?: boolean; properties?: Record<string, unknown> }>;
  };

  const bashSafety = schema.properties.bashSafety;
  assert.ok(bashSafety, "schema must define bashSafety");
  assert.equal(bashSafety.type, "object");
  assert.equal(bashSafety.additionalProperties, false);
  assert.deepEqual(
    Object.keys(bashSafety.properties ?? {}).sort(),
    ["complexSyntax", "redirections", "riskyOptions"],
  );
});

runTest("I2: example config carries a valid bashSafety block", () => {
  const example = JSON.parse(readFileSync(new URL("../config/config.example.json", import.meta.url), "utf8")) as {
    bashSafety?: Record<string, string>;
  };

  assert.ok(example.bashSafety, "example config must include bashSafety");
  for (const [key, value] of Object.entries(example.bashSafety ?? {})) {
    assert.ok(["complexSyntax", "redirections", "riskyOptions"].includes(key), `unexpected category ${key}`);
    assert.ok(["allow", "ask", "deny"].includes(value), `invalid state ${value}`);
  }
});

console.log("\nBash safety gate test suite complete.");
