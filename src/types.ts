export type PermissionState = "allow" | "deny" | "ask";

export type BuiltInToolName = "bash" | "read" | "write" | "edit" | "grep" | "find" | "ls";

export type ToolPermissions = Record<string, PermissionState>;

export type BashPermissions = Record<string, PermissionState>;

export type SkillPermissions = Record<string, PermissionState>;

export type SpecialPermissionName = "doom_loop" | "external_directory";

export type SpecialPermissions = Record<string, PermissionState>;

export type BashSafetyCategory = "complexSyntax" | "redirections" | "riskyOptions";

/**
 * Per-category policy for the bash safety gate. Every omitted category (and an
 * omitted `bashSafety` object entirely) behaves as "allow", preserving the
 * pre-gate behavior of broad bash wildcard rules.
 */
export type BashSafetyPolicy = Partial<Record<BashSafetyCategory, PermissionState>>;

export interface BashSafetyFinding {
  category: BashSafetyCategory;
  detail: string;
}

/**
 * Structured safety metadata attached to bash permission check results.
 * `state` is the most restrictive configured policy among the triggered
 * categories ("allow" when nothing triggered or `bashSafety` is omitted).
 * `family` is the safe simple-command executable name, or null when the
 * command is compound, redirected, substituted, malformed, or ambiguous.
 */
export interface BashSafetyAssessment {
  categories: BashSafetyCategory[];
  findings: BashSafetyFinding[];
  state: PermissionState;
  family: string | null;
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
  bash?: BashPermissions;
  bashSafety?: BashSafetyPolicy;
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
  /** Bash safety gate metadata; present for bash command checks. */
  safety?: BashSafetyAssessment;
}
