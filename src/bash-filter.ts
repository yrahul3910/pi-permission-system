import type { BashPermissions, PermissionState } from "./types.js";
import { containsShellOperator, splitShellSubcommands } from "./shell-split.js";
import {
  compileWildcardPatterns,
  findCompiledWildcardMatch,
  type CompiledWildcardPattern,
  type WildcardPatternMatch,
} from "./wildcard-matcher.js";

type CompiledPattern = CompiledWildcardPattern<PermissionState>;

type BashPermissionSource = BashPermissions | readonly CompiledPattern[];

function isCompiledPatternList(value: BashPermissionSource): value is readonly CompiledPattern[] {
  return Array.isArray(value);
}

const RESTRICTION_ORDER: Record<PermissionState, number> = {
  allow: 0,
  ask: 1,
  deny: 2,
};

export interface BashPermissionCheck {
  state: PermissionState;
  matchedPattern?: string;
  command: string;
}

export class BashFilter {
  private readonly compiledPatterns: CompiledPattern[];

  constructor(
    permissions: BashPermissionSource,
    private readonly defaultState: PermissionState,
  ) {
    this.compiledPatterns = isCompiledPatternList(permissions)
      ? [...permissions]
      : compileWildcardPatterns(permissions);
  }

  check(command: string): BashPermissionCheck {
    const subcommands = splitShellSubcommands(command);

    if (subcommands.length <= 1) {
      // Single command (no operators) — match the full string as before.
      const match = findCompiledWildcardMatch(this.compiledPatterns, command);
      if (match) {
        return {
          state: match.state,
          matchedPattern: match.matchedPattern,
          command,
        };
      }

      return {
        state: this.defaultState,
        command,
      };
    }

    // Compound command. Try full-command match only for patterns that
    // explicitly contain shell operators.
    const fullMatch = findCompiledWildcardMatch(this.compiledPatterns, command);
    if (fullMatch && containsShellOperator(fullMatch.matchedPattern)) {
      return {
        state: fullMatch.state,
        matchedPattern: fullMatch.matchedPattern,
        command,
      };
    }

    // Check each subcommand individually. Return the most restrictive state
    // if all match, otherwise fall through to default.
    const subResults: WildcardPatternMatch<PermissionState>[] = [];
    let allMatched = true;

    for (const sub of subcommands) {
      const match = findCompiledWildcardMatch(this.compiledPatterns, sub);
      if (match) {
        subResults.push(match);
      } else {
        allMatched = false;
        break;
      }
    }

    if (allMatched && subResults.length > 0) {
      const mostRestrictive = subResults.reduce((worst, r) =>
        RESTRICTION_ORDER[r.state] > RESTRICTION_ORDER[worst.state] ? r : worst,
      );

      return {
        state: mostRestrictive.state,
        matchedPattern: mostRestrictive.matchedPattern,
        command,
      };
    }

    return {
      state: this.defaultState,
      command,
    };
  }
}
