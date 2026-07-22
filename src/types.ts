export type PermissionState = "allow" | "deny" | "ask";

export type BuiltInToolName = "bash" | "read" | "write" | "edit" | "grep" | "find" | "ls";

export type ToolPermissions = Record<string, PermissionState>;

export type SkillPermissions = Record<string, PermissionState>;

export type SpecialPermissionName = "doom_loop" | "external_directory";

export type SpecialPermissions = Record<string, PermissionState>;

/**
 * Bash rules are word-prefix lists matched against the normalized argv of
 * each command a bash invocation actually executes (see shell-analyzer.ts):
 * "git diff" covers `git diff --stat HEAD~3`; "rg" covers any rg invocation.
 * Stored tokenized; config files carry them as plain strings.
 */
export interface BashPermissionSection {
  allow: string[][];
  ask: string[][];
  deny: string[][];
  syntax: {
    /**
     * Governs every construct the analyzer refuses by default: subshells
     * `(...)`, brace groups `{ ...; }`, function declarations, and
     * coprocesses. Default "deny".
     */
    subshells?: PermissionState;
    /** Parse failures and constructs the analyzer cannot resolve. Default "ask". */
    unanalyzable?: PermissionState;
  };
  /** Safe-command registry adjustments; see safe-commands.ts. */
  registryOverrides: Record<string, unknown>;
}

/**
 * One non-allowed piece of a bash evaluation: a command with no matching
 * rule, a file write, a protected-path hit, or a syntax finding. Shown in
 * prompts and logs so the user sees exactly what blocks a command.
 */
export interface BashBlockingPiece {
  display: string;
  reason: string;
  state: "ask" | "deny";
  /**
   * Session-approvable family prefix (e.g. ["git", "push"]); only ask
   * pieces that are ordinary commands with a literal plain-word executable
   * carry one.
   */
  family: string[] | null;
}

export interface BashEvaluation {
  state: PermissionState;
  /** Non-allow pieces, denies first. Empty when state is "allow". */
  pieces: BashBlockingPiece[];
}

export interface PermissionDefaultPolicy {
  tools: PermissionState;
  bash: PermissionState;
  mcp: PermissionState;
  skills: PermissionState;
  special: PermissionState;
}

export interface AgentPermissions {
  defaultPolicy?: Partial<PermissionDefaultPolicy>;
  tools?: ToolPermissions;
  bash?: BashPermissionSection;
  /** Additions to the built-in protected path patterns. */
  protectedPaths?: string[];
  mcp?: ToolPermissions;
  skills?: SkillPermissions;
  special?: SpecialPermissions;
}

export interface GlobalPermissionConfig extends AgentPermissions {
  defaultPolicy: PermissionDefaultPolicy;
}

export interface PermissionCheckResult {
  toolName: string;
  state: PermissionState;
  matchedPattern?: string;
  command?: string;
  target?: string;
  source: "tool" | "bash" | "mcp" | "skill" | "special" | "default";
  /** Piece-by-piece bash evaluation; present for bash command checks. */
  bashEvaluation?: BashEvaluation;
}
