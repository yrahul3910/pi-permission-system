// Shell analyzer coverage: mvdan-sh AST mapping to executed commands, file
// effects, denied syntax, and fail-closed unanalyzable findings.
// Run with: npx tsx ./tests/shell-analyzer.test.ts
import assert from "node:assert/strict";
import { runTest } from "./test-harness.js";
import { analyzeShellCommand } from "../src/shell-analyzer.js";

function argvStrings(command: string): string[] {
  return analyzeShellCommand(command).commands.map((executed) =>
    executed.argv.map((word) => (word === null ? "<exp>" : word)).join(" "),
  );
}

runTest("SA: single simple command", () => {
  const analysis = analyzeShellCommand("rg foo src");
  assert.deepEqual(argvStrings("rg foo src"), ["rg foo src"]);
  assert.equal(analysis.deniedSyntax.length, 0);
  assert.equal(analysis.unanalyzable.length, 0);
});

runTest("SA: pipes and operators split into individual commands", () => {
  assert.deepEqual(argvStrings("rg foo | wc -l"), ["rg foo", "wc -l"]);
  assert.deepEqual(argvStrings("git log && echo ok || true"), ["git log", "echo ok", "true"]);
  assert.deepEqual(argvStrings("a 1; b 2"), ["a 1", "b 2"]);
  assert.deepEqual(argvStrings("a 1\nb 2"), ["a 1", "b 2"]);
});

runTest("SA: quote evasion normalizes", () => {
  assert.deepEqual(argvStrings("cat .e''nv"), ["cat .env"]);
  assert.deepEqual(argvStrings('cat ".env"'), ["cat .env"]);
  assert.deepEqual(argvStrings("cat .e\\nv"), ["cat .env"]);
});

runTest("SA: command substitution commands are surfaced", () => {
  const argv = argvStrings('echo "$(git rev-parse HEAD)"');
  assert.deepEqual(argv, ["echo <exp>", "git rev-parse HEAD"]);
  assert.ok(argvStrings("`whoami`").includes("whoami"));
  assert.deepEqual(argvStrings("diff <(sort a) <(sort b)").slice(1), ["sort a", "sort b"]);
});

runTest("SA: substitution inside assignment value is surfaced", () => {
  assert.ok(argvStrings("x=$(whoami) cat ok").includes("whoami"));
});

runTest("SA: expansion as executable fails closed", () => {
  const analysis = analyzeShellCommand("$CMD --flag");
  assert.equal(analysis.commands.length, 0);
  assert.ok(analysis.unanalyzable.some((entry) => entry.includes("expansion")));
});

runTest("SA: wrappers unwrap to the wrapped command", () => {
  assert.deepEqual(argvStrings("timeout 5 cargo test"), ["cargo test"]);
  assert.deepEqual(argvStrings("FOO=1 timeout 5 cargo test"), ["cargo test"]);
  assert.deepEqual(argvStrings("env FOO=1 BAR=2 cargo check"), ["cargo check"]);
  assert.deepEqual(argvStrings("timeout 5 env FOO=1 cargo check"), ["cargo check"]);
  assert.deepEqual(argvStrings("nohup xargs -n 1 rm"), ["rm"]);
  assert.deepEqual(argvStrings("command -v git"), ["which git"]);
});

runTest("SA: bare env stays itself (prints the environment)", () => {
  assert.deepEqual(argvStrings("env"), ["env"]);
});

runTest("SA: unknown wrapper flags fail closed", () => {
  const analysis = analyzeShellCommand("xargs --weird-flag rm");
  assert.equal(analysis.commands.length, 0);
  assert.ok(analysis.unanalyzable.some((entry) => entry.includes("xargs")));
});

runTest("SA: bash -c strings are parsed recursively", () => {
  assert.deepEqual(argvStrings("bash -c 'rm -rf /'"), ["rm -rf /"]);
  assert.deepEqual(argvStrings("sh -lc 'git log | wc -l'"), ["git log", "wc -l"]);
});

runTest("SA: bash on a script file is opaque", () => {
  const analysis = analyzeShellCommand("bash ./script.sh");
  assert.equal(analysis.commands.length, 1);
  assert.equal(analysis.commands[0].opaque, true);
});

runTest("SA: sudo and eval are opaque", () => {
  for (const command of ["sudo make install", "eval ls"]) {
    const analysis = analyzeShellCommand(command);
    assert.equal(analysis.commands[0].opaque, true, command);
  }
});

runTest("SA: heredoc bodies are data, not commands", () => {
  const analysis = analyzeShellCommand("cat <<'EOF' > /tmp/x\nrm -rf /\nEOF");
  assert.deepEqual(analysis.commands.map((c) => c.argv.join(" ")), ["cat"]);
  assert.deepEqual(analysis.writes.map((w) => w.target), ["/tmp/x"]);
  assert.equal(analysis.reads.length, 0);
});

runTest("SA: redirection targets are captured; sinks and fd dups are free", () => {
  const quiet = analyzeShellCommand("cmd >/dev/null 2>&1");
  assert.equal(quiet.reads.length, 0);
  assert.equal(quiet.writes.length, 0);

  const write = analyzeShellCommand("echo hi > out.txt 2>err.txt");
  assert.deepEqual(write.writes.map((w) => w.target).sort(), ["err.txt", "out.txt"]);

  const read = analyzeShellCommand("tr x y < .env");
  assert.deepEqual(read.reads.map((r) => r.target), [".env"]);

  const dup = analyzeShellCommand("cmd >&2");
  assert.equal(dup.writes.length, 0);

  const cshStyle = analyzeShellCommand("cmd >& file.txt");
  assert.deepEqual(cshStyle.writes.map((w) => w.target), ["file.txt"]);
});

runTest("SA: expansion in a redirect target fails closed", () => {
  const analysis = analyzeShellCommand("echo hi > $OUT");
  assert.ok(analysis.unanalyzable.some((entry) => entry.includes("redirection target")));
});

runTest("SA: subshells, brace groups, functions, coprocs are denied syntax", () => {
  assert.ok(analyzeShellCommand("(cd /; ls)").deniedSyntax.some((d) => d.includes("subshell")));
  assert.ok(analyzeShellCommand("{ ls; }").deniedSyntax.some((d) => d.includes("brace group")));
  assert.ok(analyzeShellCommand("f() { ls; }").deniedSyntax.some((d) => d.includes("function")));
});

runTest("SA: loops and conditionals are transparent", () => {
  const loop = analyzeShellCommand("for f in a b; do cat $f; done");
  assert.equal(loop.deniedSyntax.length, 0);
  assert.equal(loop.unanalyzable.length, 0);
  assert.deepEqual(loop.commands.map((c) => c.argv[0]), ["cat"]);

  const cond = analyzeShellCommand("if grep -q x f; then echo yes; fi");
  assert.equal(cond.deniedSyntax.length, 0);
  assert.deepEqual(cond.commands.map((c) => c.argv[0]), ["grep", "echo"]);
});

runTest("SA: malformed input fails closed", () => {
  const analysis = analyzeShellCommand("rg 'unterminated");
  assert.equal(analysis.commands.length, 0);
  assert.ok(analysis.unanalyzable.some((entry) => entry.includes("syntax error")));
});

runTest("SA: oversized input fails closed without throwing", () => {
  const analysis = analyzeShellCommand(`echo ${"a".repeat(250_000)}`);
  assert.ok(analysis.unanalyzable.some((entry) => entry.includes("too long")));
});

runTest("SA: deep shell -c nesting fails closed", () => {
  let command = "ls";
  for (let index = 0; index < 8; index += 1) {
    command = `bash -c ${JSON.stringify(command)}`;
  }
  const analysis = analyzeShellCommand(command);
  assert.ok(analysis.unanalyzable.some((entry) => entry.includes("nesting")));
});

console.log("Shell analyzer test suite complete.");
