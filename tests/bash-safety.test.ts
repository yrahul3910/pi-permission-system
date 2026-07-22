import assert from "node:assert/strict";
import { analyzeBashSafety } from "../src/bash-safety.js";
import { runTest } from "./test-harness.js";

runTest("Bash safety respects quoted and escaped metacharacters", () => {
  assert.deepEqual(analyzeBashSafety('rg "$(date)" \\> literal').findings, []);
});

runTest("Bash safety classifies shell execution and redirections", () => {
  for (const command of ["rg $(date)", "rg `date`", "rg foo | cat", "rg foo\ncat"]) assert.ok(analyzeBashSafety(command).findings.includes("complexSyntax"));
  for (const command of ["rg foo > out", "rg foo 2>&1", "rg foo <<< input"]) assert.ok(analyzeBashSafety(command).findings.includes("redirections"));
});

runTest("Bash safety recognizes risky option families", () => {
  for (const command of ["rg --pre=evil foo", "fd --exec-batch echo", "fd -X echo", "sed --in-place s/a/b/", "sed s/a/b/e", "git --ext-diff"]) assert.ok(analyzeBashSafety(command).findings.includes("riskyOptions"), command);
});

runTest("Only safe simple commands have a family", () => {
  assert.equal(analyzeBashSafety("rg foo src").family, "rg");
  assert.equal(analyzeBashSafety("rg foo > out").family, undefined);
  assert.equal(analyzeBashSafety("rg 'unterminated").findings.includes("complexSyntax"), true);
});
