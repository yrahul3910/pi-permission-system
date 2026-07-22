import { evaluatePermission, type PatternPermissionRule } from "./evaluate-permission.js";

/**
 * Session-scoped approvals.
 *
 * Bash approvals come in two shapes, both consumed by the bash evaluator's
 * per-piece checks (never by wildcard matching):
 * - exact "Allow Always" approvals of one precise command string;
 * - family prefixes from "Allow for this session: ..." decisions (e.g.
 *   ["wc"] or ["git", "push"]), which act exactly like config allow-prefix
 *   rules. They are safe by construction: every piece of a compound, every
 *   substitution, every write is still evaluated on its own, so a family
 *   prefix can never smuggle anything past the other checks.
 *
 * Non-bash tools keep the original wildcard-pattern session rules.
 */
export class SessionApprovalStore {
  private readonly rules: PatternPermissionRule[] = [];
  private readonly bashExactAllows = new Set<string>();
  private readonly bashFamilyPrefixes: string[][] = [];

  approveAlways(tool: string, pattern: string): void {
    const normalizedTool = tool.trim();
    const normalizedPattern = pattern.trim();
    if (!normalizedTool || !normalizedPattern) {
      return;
    }

    if (normalizedTool === "bash") {
      this.bashExactAllows.add(normalizedPattern);
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
   * Record session allow prefixes for bash command families. Callers must
   * derive the families from the real command text via the bash evaluator -
   * never from a UI label or a forwarded payload. Returns the stored
   * prefixes as display strings.
   */
  approveBashFamilyPrefixes(families: readonly (readonly string[])[]): string[] {
    const stored: string[] = [];
    for (const family of families) {
      const words = family.map((word) => word.trim()).filter((word) => word.length > 0);
      if (words.length === 0) {
        continue;
      }
      const key = words.join(" ");
      if (!this.bashFamilyPrefixes.some((existing) => existing.join(" ") === key)) {
        this.bashFamilyPrefixes.push(words);
      }
      stored.push(key);
    }
    return stored;
  }

  /** Session allow prefixes for the bash evaluator. */
  getBashAllowPrefixes(): readonly string[][] {
    return this.bashFamilyPrefixes;
  }

  /**
   * True when an ordinary "Allow Always" approval recorded this exact
   * subject. Exact approvals were confirmed by the user for this precise
   * command text (including the piece breakdown shown in the prompt), so
   * the evaluator does not re-ask for them.
   */
  hasExactAllowApproval(tool: string, subject: string): boolean {
    const normalizedTool = tool.trim();
    const normalizedSubject = subject.trim();
    if (!normalizedTool || !normalizedSubject) {
      return false;
    }

    if (normalizedTool === "bash") {
      return this.bashExactAllows.has(normalizedSubject);
    }

    return this.rules.some((rule) =>
      rule.action === "allow"
      && rule.tool === normalizedTool
      && rule.pattern === normalizedSubject,
    );
  }

  hasSessionApproval(tool: string, command: string): boolean {
    if (tool.trim() === "bash") {
      return this.hasExactAllowApproval(tool, command);
    }
    return this.evaluate(tool, command).state === "allow";
  }

  evaluate(tool: string, command: string): { state: "allow" | "ask"; matchedPattern?: string } {
    const result = evaluatePermission(tool, command, this.getApplicableRules(tool, command));
    return result.action === "allow"
      ? { state: "allow", matchedPattern: result.matchedPattern }
      : { state: "ask" };
  }

  /**
   * Wildcard session rules for non-bash tools. Bash never evaluates through
   * wildcards; its session approvals flow through getBashAllowPrefixes and
   * hasExactAllowApproval instead.
   */
  getApplicableRules(tool: string, _subject: string): PatternPermissionRule[] {
    if (tool.trim() === "bash") {
      return [];
    }
    return this.rules.filter((rule) => rule.tool !== "bash");
  }

  getRules(): PatternPermissionRule[] {
    return [...this.rules];
  }

  clear(): void {
    this.rules.length = 0;
    this.bashExactAllows.clear();
    this.bashFamilyPrefixes.length = 0;
  }
}
