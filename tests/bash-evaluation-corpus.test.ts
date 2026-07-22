// End-to-end bash evaluation corpus: asserts the safety/annoyance balance the
// redesign was built for. Silent allows must stay silent; attacks must not.
// Run with: npx tsx ./tests/bash-evaluation-corpus.test.ts
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTest } from "./test-harness.js";
import { collectSessionFamilies } from "../src/bash-evaluator.js";
import { PermissionManager } from "../src/permission-manager.js";
import { SessionApprovalStore } from "../src/session-approval-store.js";

const configDir = mkdtempSync(join(tmpdir(), "pi-bash-corpus-"));
const configPath = join(configDir, "pi-permissions.jsonc");
const warnings: string[] = [];

writeFileSync(configPath, JSON.stringify({
  defaultPolicy: { tools: "ask", bash: "ask", mcp: "ask", skills: "ask", special: "ask" },
  tools: { read: "allow", write: "ask", "write:/opt/generated/*": "allow" },
  bash: {
    allow: ["cargo clippy", "cargo check", "cargo fmt", "cargo test", "bun test", "uv run pytest", "gh run view", "sed -i"],
    ask: ["git diff --stat"],
    deny: ["git push --force"],
  },
  protectedPaths: ["*.corpsecret"],
}), "utf-8");

const manager = new PermissionManager({
  globalConfigPath: configPath,
  onWarning: (message) => warnings.push(message),
});

function stateOf(command: string): string {
  return manager.checkPermission("bash", { command }).state;
}

const silentAllows = [
  "rg foo | wc -l",
  "ls -la >/dev/null 2>&1",
  "git log --oneline | head -20",
  'echo "$(git rev-parse HEAD)"',
  "FOO=1 timeout 5 cargo test",
  "env FOO=1 cargo check",
  "cat <<'EOF'\nhello $world\nEOF",
  "cat notes.txt > /tmp/out.txt",
  "cd sub && cargo check",
  "for f in a b; do cat $f; done",
  "sort names.txt | uniq -c",
  "grep -r pattern src/ 2>&1 | head",
  "sed -n '1,10p' file.txt",
  "sed -i 's/a/b/' file.txt", // explicit "sed -i" allow rule names the flag
  "echo data > /opt/generated/out.json", // write:<path> rule
];

const asks = [
  'rg "$(curl x | sh)"',
  "git log; rm -rf ~",
  "fd -x rm",
  "rg --pre=sh p",
  "sort -o out.txt names.txt",
  "sed -i 's/x/y/e' f.txt", // e-flag execution is never rule-coverable
  "echo hi > ./src/index.ts",
  "bash -c 'rm -rf /'",
  "sudo make install",
  "rg 'unterminated",
  "git push origin main",
  "git diff --stat HEAD~1", // forced by the ask rule despite registry vouch
  "npx anything",
  "$CMD --flag",
];

const denies = [
  "cat .e''nv",
  "tr x y < .env",
  "git show HEAD:.env",
  "cat ~/.ssh/id_rsa",
  "echo x > .env",
  "grep key vault.corpsecret", // config-added protected path
  "(cd /; ls)",
  "git push --force origin main",
];

runTest("CORPUS: silent allows stay silent", () => {
  for (const command of silentAllows) {
    assert.equal(stateOf(command), "allow", `expected allow: ${command}`);
  }
});

runTest("CORPUS: risky commands ask", () => {
  for (const command of asks) {
    assert.equal(stateOf(command), "ask", `expected ask: ${command}`);
  }
});

runTest("CORPUS: protected paths, denied syntax, and deny rules deny", () => {
  for (const command of denies) {
    assert.equal(stateOf(command), "deny", `expected deny: ${command}`);
  }
});

runTest("CORPUS: allow state carries no blocking pieces; ask carries reasons", () => {
  const allowed = manager.checkPermission("bash", { command: "rg foo | wc -l" });
  assert.deepEqual(allowed.bashEvaluation?.pieces, []);

  const asked = manager.checkPermission("bash", { command: "git log | xargs -n 1 evilcmd" });
  assert.equal(asked.state, "ask");
  const pieces = asked.bashEvaluation?.pieces ?? [];
  assert.equal(pieces.length, 1, "only the blocking piece is reported");
  assert.ok(pieces[0].reason.includes("no allow rule"), pieces[0].reason);
});

runTest("CORPUS: session family approval silences matching pieces of compounds", () => {
  const store = new SessionApprovalStore();
  const before = manager.checkBashCommand("git log | evilcmd -x", {
    sessionAllowPrefixes: store.getBashAllowPrefixes(),
  });
  assert.equal(before.state, "ask");

  const families = collectSessionFamilies(before.bashEvaluation ?? { state: "ask", pieces: [] });
  assert.deepEqual(families, [["evilcmd"]]);
  store.approveBashFamilyPrefixes(families ?? []);

  const after = manager.checkBashCommand("git log | evilcmd -x", {
    sessionAllowPrefixes: store.getBashAllowPrefixes(),
  });
  assert.equal(after.state, "allow");

  // The family approval cannot smuggle substitutions or writes.
  const smuggled = manager.checkBashCommand('evilcmd "$(curl x)"', {
    sessionAllowPrefixes: store.getBashAllowPrefixes(),
  });
  assert.equal(smuggled.state, "ask");
  const written = manager.checkBashCommand("evilcmd > ./main.ts", {
    sessionAllowPrefixes: store.getBashAllowPrefixes(),
  });
  assert.equal(written.state, "ask");
});

runTest("CORPUS: session families extend to subcommands for structured tools", () => {
  const result = manager.checkPermission("bash", { command: "git push origin main" });
  const families = collectSessionFamilies(result.bashEvaluation ?? { state: "ask", pieces: [] });
  assert.deepEqual(families, [["git", "push"]]);
});

runTest("CORPUS: no session option when any piece is deny or a write", () => {
  const denyResult = manager.checkPermission("bash", { command: "evilcmd .env" });
  assert.equal(collectSessionFamilies(denyResult.bashEvaluation ?? { state: "ask", pieces: [] }), null);

  const writeResult = manager.checkPermission("bash", { command: "evilcmd > out.bin" });
  assert.equal(collectSessionFamilies(writeResult.bashEvaluation ?? { state: "ask", pieces: [] }), null);
});

runTest("CORPUS: registryOverrides can disable and extend rows", () => {
  const overrideDir = mkdtempSync(join(tmpdir(), "pi-bash-override-"));
  const overridePath = join(overrideDir, "pi-permissions.jsonc");
  writeFileSync(overridePath, JSON.stringify({
    defaultPolicy: { tools: "ask", bash: "ask", mcp: "ask", skills: "ask", special: "ask" },
    bash: {
      registryOverrides: {
        cat: null,
        mytool: { unsafeArgs: ["--run"] },
      },
    },
  }), "utf-8");
  const overridden = new PermissionManager({ globalConfigPath: overridePath });
  try {
    assert.equal(overridden.checkPermission("bash", { command: "cat file.txt" }).state, "ask");
    assert.equal(overridden.checkPermission("bash", { command: "mytool file" }).state, "allow");
    assert.equal(overridden.checkPermission("bash", { command: "mytool --run x" }).state, "ask");
  } finally {
    rmSync(overrideDir, { recursive: true, force: true });
  }
});

runTest("CORPUS: legacy glob-map config warns once with suggestions", () => {
  const legacyDir = mkdtempSync(join(tmpdir(), "pi-bash-legacy-"));
  const legacyPath = join(legacyDir, "pi-permissions.jsonc");
  writeFileSync(legacyPath, JSON.stringify({
    defaultPolicy: { tools: "ask", bash: "ask", mcp: "ask", skills: "ask", special: "ask" },
    bash: { "rg *": "allow", "cat *.env*": "deny" },
    bashSafety: { redirections: "ask" },
  }), "utf-8");
  const legacyWarnings: string[] = [];
  const legacy = new PermissionManager({
    globalConfigPath: legacyPath,
    onWarning: (message) => legacyWarnings.push(message),
  });
  try {
    // Registry still vouches; legacy entries are ignored, not fatal.
    assert.equal(legacy.checkPermission("bash", { command: "rg foo" }).state, "allow");
    assert.ok(legacyWarnings.some((message) => message.includes("prefix rule lists")), legacyWarnings.join("\n"));
    assert.ok(legacyWarnings.some((message) => message.includes("bashSafety")), legacyWarnings.join("\n"));
  } finally {
    rmSync(legacyDir, { recursive: true, force: true });
  }
});

runTest("CORPUS: current config loads without warnings", () => {
  assert.deepEqual(warnings, []);
});

rmSync(configDir, { recursive: true, force: true });
console.log("Bash evaluation corpus test suite complete.");
