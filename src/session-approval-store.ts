import { analyzeBashCommand, createBashFamilyPattern } from "./bash-safety.js";
import { evaluatePermission, type PatternPermissionRule } from "./evaluate-permission.js";

type SessionApprovalRule = PatternPermissionRule & {
  /**
   * Set for "allow safe <family> commands this session" approvals. Rules with
   * this flag only apply to commands the bash safety analyzer confirms are one
   * safe simple command (no substitutions, redirections, pipes, compound
   * operators, risky options, or malformed syntax) — independent of any
   * configured `bashSafety` policy.
   */
  requiresSafeSimpleCommand?: boolean;
};

function toPatternRule(rule: SessionApprovalRule): PatternPermissionRule {
  return {
    tool: rule.tool,
    pattern: rule.pattern,
    action: rule.action,
  };
}

export class SessionApprovalStore {
  private readonly rules: SessionApprovalRule[] = [];

  approveAlways(tool: string, pattern: string): void {
    const normalizedTool = tool.trim();
    const normalizedPattern = pattern.trim();
    if (!normalizedTool || !normalizedPattern) {
      return;
    }

    this.rules.push({
      tool: normalizedTool,
      pattern: normalizedPattern,
      action: "allow",
    });
  }

  approveOnce(tool: string, pattern: string): void {
    this.approveAlways(tool, pattern);
  }

  /**
   * Record a session-only "safe command family" approval, e.g. family "rg"
   * stores `{ tool: "bash", pattern: "rg *", action: "allow" }` restricted to
   * safe simple commands. Returns the stored pattern, or null when the tool or
   * family is empty.
   */
  approveSafeFamilyAlways(tool: string, family: string): string | null {
    const normalizedTool = tool.trim();
    const normalizedFamily = family.trim();
    if (!normalizedTool || !normalizedFamily) {
      return null;
    }

    const pattern = createBashFamilyPattern(normalizedFamily);
    this.rules.push({
      tool: normalizedTool,
      pattern,
      action: "allow",
      requiresSafeSimpleCommand: true,
    });
    return pattern;
  }

  hasSessionApproval(tool: string, command: string): boolean {
    return this.evaluate(tool, command).state === "allow";
  }

  evaluate(tool: string, command: string): { state: "allow" | "ask"; matchedPattern?: string } {
    const result = evaluatePermission(tool, command, this.getApplicableRules(tool, command));
    return result.action === "allow"
      ? { state: "allow", matchedPattern: result.matchedPattern }
      : { state: "ask" };
  }

  /**
   * Rules that apply to the given subject. Family approvals are filtered out
   * unless the subject is a safe simple bash command, so a family wildcard can
   * never authorize substitutions, redirections, pipes, compound commands, or
   * risky options.
   */
  getApplicableRules(tool: string, subject: string): PatternPermissionRule[] {
    let subjectIsSafeSimpleCommand: boolean | null = null;

    return this.rules
      .filter((rule) => {
        if (!rule.requiresSafeSimpleCommand) {
          return true;
        }
        if (rule.tool !== "bash" || tool.trim() !== "bash") {
          return false;
        }
        if (subjectIsSafeSimpleCommand === null) {
          subjectIsSafeSimpleCommand = analyzeBashCommand(subject).findings.length === 0;
        }
        return subjectIsSafeSimpleCommand;
      })
      .map(toPatternRule);
  }

  /**
   * True when an ordinary "Allow Always" approval recorded this exact subject.
   * Exact approvals were confirmed by the user for this precise command text
   * (including any safety notice shown in the prompt), so the safety gate does
   * not re-ask for them. Family approvals never count as exact.
   */
  hasExactAllowApproval(tool: string, subject: string): boolean {
    const normalizedTool = tool.trim();
    const normalizedSubject = subject.trim();
    if (!normalizedTool || !normalizedSubject) {
      return false;
    }

    return this.rules.some((rule) =>
      !rule.requiresSafeSimpleCommand
      && rule.action === "allow"
      && rule.tool === normalizedTool
      && rule.pattern === normalizedSubject,
    );
  }

  getRules(): PatternPermissionRule[] {
    return this.rules.map(toPatternRule);
  }

  clear(): void {
    this.rules.length = 0;
  }
}
