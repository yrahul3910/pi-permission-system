/**
 * Built-in command knowledge for the bash permission system, kept as plain
 * data so the full policy is readable in one place (and reproduced in the
 * README "Defaults" section).
 *
 * THE ONE SEMANTIC — a registry row "vouches" for a command's plain read-only
 * invocation:
 *
 * - If any argument matches the row's `unsafeArgs` (exact token, `flag=value`
 *   prefix, or single-letter cluster like `-ni` for `-i`), or any argument
 *   matches an `unsafePatterns` regex, or — for rows with `safeSubcommands` —
 *   the invocation's leading non-flag words don't start with one of the listed
 *   word sequences, the registry does NOT vouch. The command is then evaluated
 *   as if unknown, with one extra guard applied by the evaluator: an
 *   allow-prefix rule only covers an unsafe-arg invocation if the unsafe
 *   argument literally appears among the rule's words ("sed -i" covers
 *   `sed -i …`; plain "sed" does not). Net effect: unsafe forms prompt unless
 *   explicitly opted into.
 * - Rows never grant more than "this exact program, invoked read-only, is
 *   fine". Anything a command *does* beyond that — writes via redirections,
 *   commands run through wrappers, protected-path reads — is modeled by the
 *   shell analyzer and checked separately, and always outranks a vouch.
 *
 * Nothing network-capable (curl, wget, gh) and nothing that can evaluate
 * code (awk, python, npx) belongs here; those go through user allow rules.
 */

export interface SafeCommandRow {
  cmd: string;
  /**
   * Word sequences matched as a prefix of the non-flag words after the
   * executable ("pr list" matches `gh pr list --limit 5`). Presence marks the
   * family as subcommand-structured. Scanning stops at `--`.
   */
  safeSubcommands?: string[];
  /** Arguments that void the vouch. Scanning stops at `--`. */
  unsafeArgs?: string[];
  /** Regexes matched against every argument (does not stop at `--`). */
  unsafePatterns?: RegExp[];
}

/** Any single argument longer than this voids a vouch (fail closed). */
export const MAX_VOUCHED_ARG_LENGTH = 2_000;

/**
 * GNU sed `s///` command carrying the `e` (execute) flag, any delimiter, and
 * the standalone `e` command. Alternative branches are kept disjoint so
 * pathological scripts cannot trigger catastrophic backtracking (ReDoS) —
 * carried over from the previous implementation's hardened patterns.
 */
const SED_SUBSTITUTE_EXECUTE_PATTERN = /(?:^|[^\\])s(.)(?:\\.|(?!\1)[^\\])*\1(?:\\.|(?!\1)[^\\])*\1[a-zA-Z0-9]*e/;
const SED_STANDALONE_EXECUTE_PATTERN = /(?:^|[;{\n])\s*(?:\/(?:\\.|[^\n\\/])*\/)?\s*[\d$,~+\s]*e(?:[\s;]|$)/;

export const SAFE_COMMAND_REGISTRY: readonly SafeCommandRow[] = [
  // Plain read-only text/file utilities.
  { cmd: "basename" },
  { cmd: "cat" },
  { cmd: "cksum" },
  { cmd: "cmp" },
  { cmd: "column" },
  { cmd: "comm" },
  { cmd: "cut" },
  { cmd: "df" },
  { cmd: "diff" },
  { cmd: "dirname" },
  { cmd: "du" },
  { cmd: "echo" },
  { cmd: "expand" },
  { cmd: "expr" },
  { cmd: "false" },
  { cmd: "file" },
  { cmd: "fold" },
  { cmd: "grep" },
  { cmd: "head" },
  { cmd: "hexdump" },
  { cmd: "hostname" },
  { cmd: "id" },
  { cmd: "jq" },
  { cmd: "ls" },
  { cmd: "md5" },
  { cmd: "md5sum" },
  { cmd: "nl" },
  { cmd: "od" },
  { cmd: "printf" },
  { cmd: "ps" },
  { cmd: "pwd" },
  { cmd: "readlink" },
  { cmd: "realpath" },
  { cmd: "seq" },
  { cmd: "sha1sum" },
  { cmd: "sha256sum" },
  { cmd: "shasum" },
  { cmd: "sleep" },
  { cmd: "stat" },
  { cmd: "strings" },
  { cmd: "sw_vers" },
  { cmd: "tail" },
  { cmd: "test" },
  { cmd: "tr" },
  { cmd: "tree" },
  { cmd: "true" },
  { cmd: "type" },
  { cmd: "uname" },
  { cmd: "unexpand" },
  { cmd: "uniq" },
  { cmd: "uptime" },
  { cmd: "wc" },
  { cmd: "which" },
  { cmd: "whoami" },

  // Shell builtins that only affect the spawned shell itself.
  { cmd: ":" },
  { cmd: "[" },
  { cmd: "cd" },
  { cmd: "export" },
  { cmd: "hash" },
  { cmd: "local" },
  { cmd: "read" },
  { cmd: "set" },
  { cmd: "shift" },
  { cmd: "unset" },

  // Read-only unless specific arguments say otherwise.
  { cmd: "date", unsafeArgs: ["-s", "--set"] },
  { cmd: "sort", unsafeArgs: ["-o", "--output"] },
  {
    cmd: "sed",
    unsafeArgs: ["-i", "--in-place"],
    unsafePatterns: [SED_SUBSTITUTE_EXECUTE_PATTERN, SED_STANDALONE_EXECUTE_PATTERN],
  },
  { cmd: "rg", unsafeArgs: ["--pre", "--hostname-bin"] },
  { cmd: "fd", unsafeArgs: ["-x", "-X", "--exec", "--exec-batch"] },
  {
    cmd: "find",
    unsafeArgs: ["-exec", "-execdir", "-ok", "-okdir", "-delete", "-fprintf", "-fprint", "-fprint0", "-fls"],
  },

  // Subcommand-structured tools: only the listed read-only forms are vouched.
  {
    cmd: "git",
    safeSubcommands: [
      "blame", "cat-file", "describe", "diff", "grep", "log", "ls-files",
      "ls-tree", "reflog show", "rev-list", "rev-parse", "shortlog", "show",
      "stash list", "status", "worktree list",
    ],
    unsafeArgs: ["-c", "--exec-path", "--ext-diff", "--upload-pack", "--receive-pack", "--output", "-o"],
  },
  {
    cmd: "jj",
    safeSubcommands: ["diff", "file list", "file show", "log", "op log", "show", "status"],
    unsafeArgs: ["--config", "--config-toml", "--config-file"],
  },
];

/**
 * Families whose second word is a subcommand, used when deriving session
 * approval prefixes: "Allow for this session: git push" instead of "git".
 * Registry rows with `safeSubcommands` are implicitly included.
 */
export const SUBCOMMAND_STRUCTURED_FAMILIES: ReadonlySet<string> = new Set([
  "bun", "cargo", "docker", "gh", "git", "go", "jj", "kubectl", "npm", "npx",
  "pip", "pnpm", "uv", "uvx", "yarn",
]);

/**
 * Wrappers the analyzer unwraps to evaluate the command they run. Each has a
 * structural rule in shell-analyzer.ts for locating the child command; a
 * wrapper invocation whose child cannot be located confidently is treated as
 * unknown (asks).
 */
export const WRAPPER_EXECUTABLES: ReadonlySet<string> = new Set([
  "command", "env", "nice", "nohup", "setsid", "stdbuf", "time", "timeout", "xargs",
]);

/**
 * Never unwrapped and never coverable by allow rules or the registry: these
 * escalate or hide what actually runs, so they always prompt at minimum
 * (deny rules still apply).
 */
export const OPAQUE_EXECUTABLES: ReadonlySet<string> = new Set([
  ".", "doas", "eval", "exec", "source", "su", "sudo",
]);

/**
 * Default protected path patterns. A pattern matches a token if it globs the
 * whole token or any of its `/`- or `:`-separated segments (the `:` split
 * catches forms like `git show HEAD:.env`). Any argv token or redirection
 * target of any evaluated command that matches → deny, outranking every
 * allow, including the registry. Extensible via top-level `protectedPaths`.
 */
export const PROTECTED_PATH_DEFAULTS: readonly string[] = [
  ".env", ".env.*", "*.env", ".envrc",
  ".netrc", ".npmrc", ".pypirc",
  "id_rsa*", "id_ed25519*", "id_ecdsa*", "id_dsa*",
  "*.pem", "*.p12", "*.pfx", "*.key",
  ".ssh", ".aws", ".gnupg", ".kube", ".docker",
  "*_history", ".git-credentials", "credentials", "credentials.json",
];

/**
 * Registry overrides from config: `null` disables a built-in row; an object
 * replaces (or adds) the row wholesale. `unsafePatterns` come in as strings
 * and are compiled here; invalid regexes are ignored with a warning entry.
 */
export interface RegistryOverrideConfig {
  safeSubcommands?: string[];
  unsafeArgs?: string[];
  unsafePatterns?: string[];
}

export interface CompiledRegistry {
  rows: ReadonlyMap<string, SafeCommandRow>;
  warnings: string[];
}

function normalizeStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const entries = value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
  return entries.length > 0 ? entries.map((entry) => entry.trim()) : [];
}

export function compileRegistry(overrides: unknown): CompiledRegistry {
  const rows = new Map<string, SafeCommandRow>();
  const warnings: string[] = [];
  for (const row of SAFE_COMMAND_REGISTRY) {
    rows.set(row.cmd, row);
  }

  if (overrides && typeof overrides === "object" && !Array.isArray(overrides)) {
    for (const [cmd, override] of Object.entries(overrides as Record<string, unknown>)) {
      const normalizedCmd = cmd.trim();
      if (!normalizedCmd) {
        continue;
      }
      if (override === null || override === false) {
        rows.delete(normalizedCmd);
        continue;
      }
      if (typeof override !== "object" || Array.isArray(override)) {
        warnings.push(`registryOverrides['${normalizedCmd}'] must be null or an object; ignored`);
        continue;
      }
      const record = override as Record<string, unknown>;
      const row: SafeCommandRow = { cmd: normalizedCmd };
      const safeSubcommands = normalizeStringArray(record.safeSubcommands);
      if (safeSubcommands) {
        row.safeSubcommands = safeSubcommands;
      }
      const unsafeArgs = normalizeStringArray(record.unsafeArgs);
      if (unsafeArgs) {
        row.unsafeArgs = unsafeArgs;
      }
      const patternSources = normalizeStringArray(record.unsafePatterns);
      if (patternSources) {
        const compiled: RegExp[] = [];
        for (const source of patternSources) {
          try {
            compiled.push(new RegExp(source));
          } catch {
            warnings.push(`registryOverrides['${normalizedCmd}'] has an invalid unsafePatterns regex; ignored: ${source}`);
          }
        }
        row.unsafePatterns = compiled;
      }
      rows.set(normalizedCmd, row);
    }
  }

  return { rows, warnings };
}

function matchesUnsafeArg(token: string, unsafe: string): boolean {
  if (token === unsafe || token.startsWith(`${unsafe}=`)) {
    return true;
  }
  // Single-letter short flags also match inside clusters: "-ni" carries "-i".
  if (/^-[a-zA-Z]$/.test(unsafe) && /^-[a-zA-Z]+$/.test(token)) {
    return token.includes(unsafe[1]);
  }
  return false;
}

/**
 * Why the registry declined to vouch, driving how allow rules apply:
 * - "no-row" / "subcommand": ordinary unknown command; allow rules apply.
 * - "unsafe-arg": an allow rule applies only if it names the argument.
 * - "unsafe-pattern" / "arg-too-long" / "expansion-args": never coverable by
 *   an allow rule; the invocation prompts (or is denied by rule) regardless.
 */
export type VouchDeclineKind = "no-row" | "subcommand" | "unsafe-arg" | "unsafe-pattern" | "arg-too-long" | "expansion-args";

export type VouchResult =
  | { vouched: true }
  | { vouched: false; kind: VouchDeclineKind; reason?: string; unsafeArg?: string };

/**
 * Decide whether the registry vouches for an argv. `argv[0]` must be the
 * literal plain executable word (the analyzer guarantees this before
 * calling); later entries are null when they contain expansions. Rows with
 * any restriction fields require fully literal arguments — an expansion
 * could smuggle an unsafe flag, so those fail closed.
 */
export function registryVouchesFor(argv: readonly (string | null)[], registry: CompiledRegistry): VouchResult {
  const executable = argv[0];
  const row = executable === null ? undefined : registry.rows.get(executable);
  if (!row) {
    return { vouched: false, kind: "no-row" };
  }

  const restricted = Boolean(row.unsafeArgs || row.unsafePatterns || row.safeSubcommands);
  const args = argv.slice(1);
  const literalArgs: string[] = [];
  for (const arg of args) {
    if (arg === null) {
      if (restricted) {
        return { vouched: false, kind: "expansion-args", reason: `${row.cmd} arguments contain expansions the analyzer cannot inspect` };
      }
      continue;
    }
    literalArgs.push(arg);
  }

  // Scan every argument before deciding: a never-coverable finding (script
  // execution pattern, oversized argument) must not be masked by an earlier
  // unsafe flag that an allow rule could name (e.g. `sed -i 's/x/y/e'`).
  let unsafeArgHit: string | null = null;
  let reachedTerminator = false;
  for (const arg of literalArgs) {
    if (arg.length > MAX_VOUCHED_ARG_LENGTH) {
      return { vouched: false, kind: "arg-too-long", reason: "argument too long to analyze confidently" };
    }
    if (row.unsafePatterns?.some((pattern) => pattern.test(arg))) {
      return { vouched: false, kind: "unsafe-pattern", reason: `${row.cmd} script argument can execute commands` };
    }
    if (!reachedTerminator && arg === "--") {
      reachedTerminator = true;
      continue;
    }
    if (!reachedTerminator && unsafeArgHit === null && row.unsafeArgs) {
      for (const unsafe of row.unsafeArgs) {
        if (matchesUnsafeArg(arg, unsafe)) {
          unsafeArgHit = unsafe;
          break;
        }
      }
    }
  }
  if (unsafeArgHit !== null) {
    return { vouched: false, kind: "unsafe-arg", reason: `'${unsafeArgHit}' is outside the read-only vouch for ${row.cmd}`, unsafeArg: unsafeArgHit };
  }

  if (row.safeSubcommands) {
    const words: string[] = [];
    for (const arg of literalArgs) {
      if (arg === "--") {
        break;
      }
      if (!arg.startsWith("-")) {
        words.push(arg);
      }
    }
    const matched = row.safeSubcommands.some((entry) => {
      const entryWords = entry.split(/\s+/);
      return entryWords.length <= words.length
        && entryWords.every((word, index) => words[index] === word);
    });
    if (!matched) {
      return { vouched: false, kind: "subcommand", reason: `not one of the ${row.cmd} forms vouched read-only` };
    }
  }

  return { vouched: true };
}

const REGEX_SPECIALS = new Set([".", "+", "?", "^", "$", "{", "}", "(", ")", "|", "[", "]", "\\"]);

function compileSegmentGlob(pattern: string): RegExp | null {
  const trimmed = pattern.trim();
  if (!trimmed) {
    return null;
  }
  let source = "";
  for (const ch of trimmed) {
    if (ch === "*") {
      source += "[^/]*";
    } else if (REGEX_SPECIALS.has(ch)) {
      source += `\\${ch}`;
    } else {
      source += ch;
    }
  }
  try {
    return new RegExp(`^${source}$`, "i");
  } catch {
    return null;
  }
}

export interface ProtectedPathMatcher {
  matches(token: string): string | null;
}

/**
 * Build a matcher over the default protected patterns plus config additions.
 * A token matches when the glob covers the whole token or any `/`- or
 * `:`-separated segment (trailing slashes ignored).
 */
export function createProtectedPathMatcher(additional: readonly string[] = []): ProtectedPathMatcher {
  const patterns = [...PROTECTED_PATH_DEFAULTS, ...additional]
    .map((pattern) => ({ pattern, regex: compileSegmentGlob(pattern) }))
    .filter((entry): entry is { pattern: string; regex: RegExp } => entry.regex !== null);

  return {
    matches(token: string): string | null {
      const trimmed = token.replace(/\/+$/, "");
      if (!trimmed) {
        return null;
      }
      const segments = new Set<string>([trimmed]);
      for (const bySlash of trimmed.split("/")) {
        if (bySlash) {
          segments.add(bySlash);
          for (const byColon of bySlash.split(":")) {
            if (byColon) {
              segments.add(byColon);
            }
          }
        }
      }
      for (const { pattern, regex } of patterns) {
        for (const segment of segments) {
          if (regex.test(segment)) {
            return pattern;
          }
        }
      }
      return null;
    },
  };
}
