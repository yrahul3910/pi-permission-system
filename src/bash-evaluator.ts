import {
  OPAQUE_EXECUTABLES,
  SUBCOMMAND_STRUCTURED_FAMILIES,
  WRAPPER_EXECUTABLES,
  registryVouchesFor,
  type CompiledRegistry,
  type ProtectedPathMatcher,
} from "./safe-commands.js";
import { analyzeShellCommand, type ExecutedCommand } from "./shell-analyzer.js";
import type { BashBlockingPiece, BashEvaluation, PermissionState } from "./types.js";

/**
 * Bash permission evaluation: one decomposed command (see shell-analyzer.ts)
 * checked piece by piece. Per executed command, strictly in order:
 *
 *   1. any argv token or file-effect target matches a protected path -> deny
 *   2. a deny prefix rule matches -> deny
 *   3. an ask prefix rule matches -> ask
 *   4. an allow prefix rule / session prefix matches, or the safe-command
 *      registry vouches -> allow
 *   5. otherwise the configured bash default (ask out of the box)
 *
 * Write redirection targets additionally require write permission (resolved
 * by the caller, typically via write:<path> tool rules with /tmp allowed by
 * default). Denied syntax and unanalyzable input map to the configured
 * syntax policy. The overall state is the most restrictive across all
 * pieces; when everything allows there is no prompt at all.
 */

const PLAIN_EXECUTABLE_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.+-]*$/;
const GLOB_CHARS_PATTERN = /[*?[\]]/;

export interface BashSyntaxPolicy {
  subshells: PermissionState;
  unanalyzable: PermissionState;
}

export const DEFAULT_BASH_SYNTAX_POLICY: BashSyntaxPolicy = {
  subshells: "deny",
  unanalyzable: "ask",
};

export interface BashRuleSets {
  allow: string[][];
  ask: string[][];
  deny: string[][];
}

export interface BashEvaluationContext {
  rules: BashRuleSets;
  /** Session-approved allow prefixes, evaluated exactly like config allows. */
  sessionAllowPrefixes: readonly string[][];
  registry: CompiledRegistry;
  protectedPaths: ProtectedPathMatcher;
  syntax: BashSyntaxPolicy;
  /** Configured bash default for commands nothing else matched. */
  defaultState: PermissionState;
  /** Resolve write permission for a redirection target path. */
  resolveWriteState: (target: string) => PermissionState;
}

export type { BashBlockingPiece, BashEvaluation } from "./types.js";

export function parseBashRulePrefix(rule: string): string[] {
  return rule.trim().split(/\s+/).filter((word) => word.length > 0);
}

function prefixMatches(prefix: readonly string[], argv: readonly (string | null)[]): boolean {
  if (prefix.length === 0 || prefix.length > argv.length) {
    return false;
  }
  return prefix.every((word, index) => argv[index] === word);
}

function findPrefixMatch(rules: readonly string[][], argv: readonly (string | null)[]): string[] | null {
  for (const rule of rules) {
    if (prefixMatches(rule, argv)) {
      return rule;
    }
  }
  return null;
}

function matchProtectedToken(token: string, matcher: ProtectedPathMatcher): string | null {
  const direct = matcher.matches(token);
  if (direct) {
    return direct;
  }
  // A glob argument like `.env*` expands to files we cannot enumerate; test
  // the pattern with its glob characters removed so `.env*` still hits `.env`.
  if (GLOB_CHARS_PATTERN.test(token)) {
    const stripped = token.replace(/[*?]|\[[^\]]*\]/g, "");
    if (stripped && stripped !== token) {
      return matcher.matches(stripped);
    }
  }
  return null;
}

function isSubcommandStructured(executable: string, registry: CompiledRegistry): boolean {
  if (SUBCOMMAND_STRUCTURED_FAMILIES.has(executable)) {
    return true;
  }
  return Boolean(registry.rows.get(executable)?.safeSubcommands);
}

/**
 * The session-approvable family for an ask piece: argv[0], extended to
 * argv[0] argv[1] for subcommand-structured tools. Null when the executable
 * is not a literal plain word, or is a wrapper/opaque executable whose
 * family would be meaningless or dangerous to approve broadly.
 */
export function deriveCommandFamily(argv: readonly (string | null)[], registry: CompiledRegistry): string[] | null {
  const executable = argv[0];
  if (executable === null || executable === undefined || !PLAIN_EXECUTABLE_PATTERN.test(executable)) {
    return null;
  }
  if (WRAPPER_EXECUTABLES.has(executable) || OPAQUE_EXECUTABLES.has(executable)) {
    return null;
  }
  if (isSubcommandStructured(executable, registry)) {
    const subcommand = argv[1];
    if (typeof subcommand === "string" && !subcommand.startsWith("-") && PLAIN_EXECUTABLE_PATTERN.test(subcommand)) {
      return [executable, subcommand];
    }
  }
  return [executable];
}

interface PieceOutcome {
  state: PermissionState;
  reason?: string;
  family?: string[] | null;
}

function evaluateCommandPiece(command: ExecutedCommand, context: BashEvaluationContext): PieceOutcome {
  for (let index = 0; index < command.argv.length; index += 1) {
    const token = command.argv[index];
    if (token !== null) {
      const protectedHit = matchProtectedToken(token, context.protectedPaths);
      if (protectedHit) {
        return { state: "deny", reason: `touches protected path ('${token}' matches '${protectedHit}')` };
      }
      continue;
    }
    // Words with expansions still expose their literal fragments, so a
    // variable prefix cannot smuggle a protected path ("$HOME/.env").
    for (const fragment of command.argvFragments[index] ?? []) {
      const protectedHit = matchProtectedToken(fragment, context.protectedPaths);
      if (protectedHit) {
        return { state: "deny", reason: `touches protected path ('${fragment}' matches '${protectedHit}')` };
      }
    }
  }

  const denyRule = findPrefixMatch(context.rules.deny, command.argv);
  if (denyRule) {
    return { state: "deny", reason: `matches deny rule '${denyRule.join(" ")}'` };
  }

  if (command.opaque) {
    return { state: "ask", reason: `'${command.argv[0]}' always requires approval` };
  }

  const askRule = findPrefixMatch(context.rules.ask, command.argv);
  if (askRule) {
    return { state: "ask", reason: `matches ask rule '${askRule.join(" ")}'`, family: null };
  }

  const vouch = registryVouchesFor(command.argv, context.registry);
  if (vouch.vouched) {
    return { state: "allow" };
  }

  const allowRule = findPrefixMatch(context.rules.allow, command.argv)
    ?? findPrefixMatch(context.sessionAllowPrefixes, command.argv);
  if (allowRule) {
    if (vouch.kind === "no-row" || vouch.kind === "subcommand") {
      return { state: "allow" };
    }
    if (vouch.kind === "unsafe-arg") {
      if (vouch.unsafeArg && allowRule.includes(vouch.unsafeArg)) {
        return { state: "allow" };
      }
      return {
        state: "ask",
        reason: `${vouch.reason}; an allow rule must name it (e.g. "${command.argv[0]} ${vouch.unsafeArg}")`,
        family: null,
      };
    }
    // unsafe-pattern / arg-too-long / expansion-args: never rule-coverable.
    return { state: "ask", reason: vouch.reason, family: null };
  }

  if (context.defaultState === "allow") {
    return { state: "allow" };
  }
  // A session family could never cover an unsafe-arg/unsafe-pattern decline
  // (the guard requires a rule naming the argument), so don't offer one.
  const familyCouldHelp = vouch.kind === "no-row" || vouch.kind === "subcommand";
  return {
    state: context.defaultState,
    reason: vouch.kind !== "no-row" && vouch.reason ? vouch.reason : "no allow rule matches",
    family: familyCouldHelp ? deriveCommandFamily(command.argv, context.registry) : null,
  };
}

export function evaluateBashCommand(command: string, context: BashEvaluationContext): BashEvaluation {
  const analysis = analyzeShellCommand(command);
  const pieces: BashBlockingPiece[] = [];

  const addPiece = (display: string, reason: string, state: PermissionState, family: string[] | null = null): void => {
    if (state === "allow") {
      return;
    }
    if (pieces.some((piece) => piece.display === display && piece.reason === reason)) {
      return;
    }
    pieces.push({ display, reason, state, family: state === "ask" ? family : null });
  };

  for (const denied of analysis.deniedSyntax) {
    addPiece(denied, "shell construct is not permitted", context.syntax.subshells);
  }
  for (const reason of analysis.unanalyzable) {
    addPiece(reason, "cannot be analyzed confidently", context.syntax.unanalyzable);
  }

  for (const executed of analysis.commands) {
    const outcome = evaluateCommandPiece(executed, context);
    addPiece(
      executed.display,
      outcome.reason ?? "requires approval",
      outcome.state,
      outcome.family ?? null,
    );
  }

  const matchEffectProtected = (effect: { target: string | null; fragments: string[] }): { token: string; pattern: string } | null => {
    if (effect.target !== null) {
      const hit = matchProtectedToken(effect.target, context.protectedPaths);
      return hit ? { token: effect.target, pattern: hit } : null;
    }
    // Expanded targets already fail closed to ask; literal fragments can
    // still upgrade them to deny ("< $HOME/.env").
    for (const fragment of effect.fragments) {
      const hit = matchProtectedToken(fragment, context.protectedPaths);
      if (hit) {
        return { token: fragment, pattern: hit };
      }
    }
    return null;
  };

  for (const effect of analysis.reads) {
    const protectedHit = matchEffectProtected(effect);
    if (protectedHit) {
      addPiece(effect.display, `reads protected path ('${protectedHit.token}' matches '${protectedHit.pattern}')`, "deny");
    }
  }

  for (const effect of analysis.writes) {
    const protectedHit = matchEffectProtected(effect);
    if (protectedHit) {
      addPiece(effect.display, `writes protected path ('${protectedHit.token}' matches '${protectedHit.pattern}')`, "deny");
      continue;
    }
    if (effect.target === null) {
      continue; // already reported as unanalyzable (asks)
    }
    const writeState = context.resolveWriteState(effect.target);
    addPiece(effect.display, `writes '${effect.target}'`, writeState);
  }

  let state: PermissionState = "allow";
  for (const piece of pieces) {
    if (piece.state === "deny") {
      state = "deny";
      break;
    }
    state = "ask";
  }

  pieces.sort((left, right) => (left.state === right.state ? 0 : left.state === "deny" ? -1 : 1));
  return { state, pieces };
}

/**
 * Families for the session approval option: present only when every blocking
 * piece is an ask with a derivable family. Deduplicated, insertion-ordered.
 */
export function collectSessionFamilies(evaluation: BashEvaluation): string[][] | null {
  if (evaluation.pieces.length === 0) {
    return null;
  }
  const families: string[][] = [];
  for (const piece of evaluation.pieces) {
    if (piece.state !== "ask" || !piece.family) {
      return null;
    }
    if (!families.some((family) => family.join(" ") === piece.family?.join(" "))) {
      families.push(piece.family);
    }
  }
  return families.length > 0 ? families : null;
}
