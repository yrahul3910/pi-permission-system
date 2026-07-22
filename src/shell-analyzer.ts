import mvdanSh from "mvdan-sh";

import { OPAQUE_EXECUTABLES, WRAPPER_EXECUTABLES } from "./safe-commands.js";

/**
 * Shell command analyzer built on mvdan-sh (the JS build of the canonical
 * mvdan/sh bash parser). Decomposes a command into the set of things it
 * actually does:
 *
 * - `commands`: every simple command that would execute, including inside
 *   `$(...)`, backticks, `<(...)`, `>(...)`, loop/conditional bodies, and the
 *   commands run by unwrapped wrappers (`timeout 5 cargo test` yields
 *   `cargo test`) and by `bash -c "..."` strings (parsed recursively).
 * - `reads` / `writes`: file targets of redirections. Pure fd duplications
 *   (`2>&1`, `>&2`, `>&-`) and the sink devices `/dev/null`, `/dev/stdout`,
 *   `/dev/stderr` are non-effects. Heredoc and herestring bodies are data,
 *   never commands and never file effects.
 * - `deniedSyntax`: constructs the policy refuses outright by default
 *   (subshells, brace groups, function declarations, coprocesses).
 * - `unanalyzable`: anything the analyzer cannot be confident about (parse
 *   errors, an executable name produced by an expansion, a wrapper whose
 *   child command cannot be located, unknown AST node kinds, size/depth
 *   caps). Fails closed - the evaluator maps these to ask by default.
 *
 * The analyzer never executes anything and holds no policy; it reports facts
 * and the evaluator in permission-manager.ts applies the rules.
 */

const { syntax } = mvdanSh;

/** Redirect operator codes, pinned by probing mvdan-sh (see tests). */
const REDIRECT_OPS = {
  rdrOut: 54, // >
  appOut: 55, // >>
  rdrIn: 56, // <
  rdrInOut: 57, // <>
  dplIn: 58, // <&
  dplOut: 59, // >&
  clbOut: 60, // >|
  hdoc: 61, // <<
  dashHdoc: 62, // <<-
  wordHdoc: 63, // <<<
  rdrAll: 64, // &>
  appAll: 65, // &>>
} as const;

const WRITE_OPS = new Set<number>([
  REDIRECT_OPS.rdrOut,
  REDIRECT_OPS.appOut,
  REDIRECT_OPS.clbOut,
  REDIRECT_OPS.rdrAll,
  REDIRECT_OPS.appAll,
]);

const SINK_DEVICES = new Set(["/dev/null", "/dev/stdout", "/dev/stderr"]);

/** Node kinds that are pure structure; their children carry the semantics. */
const TRANSPARENT_NODE_TYPES = new Set([
  "File", "Stmt", "BinaryCmd", "IfClause", "ForClause", "WhileClause",
  "UntilClause", "CaseClause", "CaseItem", "WordIter", "CStyleLoop",
  "TimeClause", "DeclClause", "LetClause", "TestClause", "ArithmCmd",
  "Word", "Lit", "SglQuoted", "DblQuoted", "ParamExp", "CmdSubst", "ProcSubst",
  "ArithmExp", "BinaryArithm", "UnaryArithm", "ParenArithm", "BinaryTest",
  "UnaryTest", "ParenTest", "Assign", "Comment", "ExtGlob", "BraceExp",
]);

const DENIED_NODE_TYPES: Record<string, string> = {
  Subshell: "subshell '(...)'",
  Block: "brace group '{ ...; }'",
  FuncDecl: "function declaration",
  CoprocClause: "coprocess",
};

/** Interpreters whose -c strings are shell and can be parsed recursively. */
const SHELL_INTERPRETERS = new Set(["bash", "sh", "zsh", "dash", "ksh"]);

const MAX_COMMAND_LENGTH = 200_000;
const MAX_SHELL_RECURSION_DEPTH = 5;

export interface ExecutedCommand {
  /**
   * Literal argv words; `null` marks a word containing an expansion. The
   * analyzer only emits commands whose argv[0] is literal - a non-literal
   * argv[0] becomes an `unanalyzable` entry instead.
   */
  argv: (string | null)[];
  /** Source text shown in prompts and logs. */
  display: string;
  /** True for sudo/eval/source/...: never coverable by allow rules. */
  opaque: boolean;
}

export interface FileEffect {
  target: string | null;
  display: string;
}

export interface ShellAnalysis {
  commands: ExecutedCommand[];
  reads: FileEffect[];
  writes: FileEffect[];
  deniedSyntax: string[];
  unanalyzable: string[];
}

type MvdanNode = Record<string, any>;

function pushUnique(list: string[], entry: string): void {
  if (!list.includes(entry)) {
    list.push(entry);
  }
}

/** Strip backslash escapes outside quotes: `\;` is the literal `;`. */
function unescapeLit(value: string): string {
  return value.replace(/\\(.)/gs, "$1");
}

/** Escapes valid inside double quotes; other backslashes are literal. */
function unescapeDoubleQuotedLit(value: string): string {
  return value.replace(/\\([$`"\\\n])/gs, "$1");
}

/**
 * The literal text of a word, or null when any part is an expansion the
 * analyzer cannot resolve (`$VAR`, `$(...)`, brace/glob expansion, ...).
 */
function literalWordText(word: MvdanNode | null | undefined): string | null {
  if (!word) {
    return null;
  }
  let text = "";
  for (const part of word.Parts || []) {
    const type = syntax.NodeType(part);
    if (type === "Lit") {
      text += unescapeLit(String(part.Value ?? ""));
    } else if (type === "SglQuoted") {
      if (part.Dollar) {
        text += unescapeLit(String(part.Value ?? ""));
      } else {
        text += String(part.Value ?? "");
      }
    } else if (type === "DblQuoted") {
      const inner = (part.Parts || []) as MvdanNode[];
      let quotedText = "";
      for (const innerPart of inner) {
        if (syntax.NodeType(innerPart) !== "Lit") {
          return null;
        }
        quotedText += unescapeDoubleQuotedLit(String(innerPart.Value ?? ""));
      }
      text += quotedText;
    } else {
      return null;
    }
  }
  return text;
}

function sliceSource(source: string, node: MvdanNode): string {
  try {
    const start = node.Pos().Offset();
    const end = node.End().Offset();
    if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
      return source.slice(start, end).trim();
    }
  } catch {
    // fall through to the generic label below
  }
  return "(command)";
}

function isDigitsOrDash(value: string): boolean {
  return value === "-" || /^[0-9]+$/.test(value);
}

interface WrapperUnwrapResult {
  argv: (string | null)[];
  /** Null when the child command could not be located confidently. */
  ok: boolean;
}

/** Flags that consume a following value token, per wrapper. */
const WRAPPER_VALUE_FLAGS: Record<string, ReadonlySet<string>> = {
  env: new Set(["-u", "--unset", "-C", "--chdir"]),
  nice: new Set(["-n", "--adjustment"]),
  timeout: new Set(["-k", "--kill-after", "-s", "--signal"]),
  xargs: new Set(["-a", "-d", "-E", "-e", "-I", "-i", "-J", "-L", "-l", "-n", "-P", "-R", "-S", "-s"]),
  stdbuf: new Set(["-i", "-o", "-e"]),
  command: new Set([]),
  nohup: new Set([]),
  setsid: new Set([]),
  time: new Set([]),
};

/** Flags safe to skip without a value, per wrapper; others fail closed. */
const WRAPPER_BARE_FLAGS: Record<string, ReadonlySet<string>> = {
  env: new Set(["-i", "-", "-0", "--null", "--debug", "--ignore-environment"]),
  nice: new Set([]),
  timeout: new Set(["--preserve-status", "--foreground", "-v", "--verbose"]),
  xargs: new Set(["-0", "-o", "-p", "-r", "-t", "-x", "--no-run-if-empty", "--null", "--verbose", "--open-tty"]),
  stdbuf: new Set([]),
  command: new Set(["-p"]),
  nohup: new Set([]),
  setsid: new Set(["-w", "-f", "-c", "--wait", "--fork", "--ctty"]),
  time: new Set(["-p", "-l", "-h"]),
};

/**
 * Locate the command a wrapper runs. Returns ok=false when any argument is
 * not understood - the caller then treats the whole invocation as unknown.
 */
function unwrapWrapper(wrapper: string, args: (string | null)[]): WrapperUnwrapResult {
  const valueFlags = WRAPPER_VALUE_FLAGS[wrapper] ?? new Set<string>();
  const bareFlags = WRAPPER_BARE_FLAGS[wrapper] ?? new Set<string>();
  let index = 0;
  let sawTimeoutDuration = false;
  let sawCommandLookup = false;

  while (index < args.length) {
    const arg = args[index];
    if (arg === null) {
      return { argv: [], ok: false };
    }
    if (arg === "--") {
      index += 1;
      break;
    }
    if (wrapper === "command" && (arg === "-v" || arg === "-V")) {
      sawCommandLookup = true;
      index += 1;
      continue;
    }
    if (arg.startsWith("-") && arg.length > 1) {
      if (valueFlags.has(arg)) {
        index += 2;
        continue;
      }
      const attachedMatch = [...valueFlags].some((flag) => !flag.startsWith("--") && arg.startsWith(flag) && arg.length > flag.length);
      if (attachedMatch || bareFlags.has(arg)) {
        index += 1;
        continue;
      }
      if ([...valueFlags].some((flag) => flag.startsWith("--") && arg.startsWith(`${flag}=`))) {
        index += 1;
        continue;
      }
      // VAR=x tokens handled below; unknown flags fail closed.
      return { argv: [], ok: false };
    }
    if (wrapper === "env" && /^[A-Za-z_][A-Za-z0-9_]*=/.test(arg)) {
      index += 1;
      continue;
    }
    if (wrapper === "timeout" && !sawTimeoutDuration) {
      // First non-flag token is the duration.
      sawTimeoutDuration = true;
      index += 1;
      continue;
    }
    break;
  }

  if (wrapper === "command" && sawCommandLookup) {
    // `command -v name` only prints how `name` would resolve; nothing runs.
    return { argv: ["which", ...args.slice(index)], ok: true };
  }

  return { argv: args.slice(index), ok: true };
}

interface ShellCInvocation {
  script: string | null;
  found: boolean;
}

/** Detect `bash -c 'script'` (also `-lc` style clusters). */
function findShellCScript(args: (string | null)[]): ShellCInvocation {
  let cFlagSeen = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === null) {
      if (cFlagSeen) {
        return { script: null, found: true };
      }
      return { script: null, found: false };
    }
    if (arg === "--") {
      continue;
    }
    if (arg.startsWith("-") && arg.length > 1 && !arg.startsWith("--")) {
      if (arg.includes("c")) {
        cFlagSeen = true;
      }
      continue;
    }
    if (arg.startsWith("--")) {
      continue;
    }
    // First operand: with -c it is the script, otherwise a script file.
    return cFlagSeen ? { script: arg, found: true } : { script: null, found: false };
  }
  return { script: null, found: cFlagSeen };
}

function createEmptyAnalysis(): ShellAnalysis {
  return { commands: [], reads: [], writes: [], deniedSyntax: [], unanalyzable: [] };
}

function mergeAnalysis(into: ShellAnalysis, from: ShellAnalysis): void {
  into.commands.push(...from.commands);
  into.reads.push(...from.reads);
  into.writes.push(...from.writes);
  for (const entry of from.deniedSyntax) {
    pushUnique(into.deniedSyntax, entry);
  }
  for (const entry of from.unanalyzable) {
    pushUnique(into.unanalyzable, entry);
  }
}

function processRedirect(node: MvdanNode, source: string, analysis: ShellAnalysis): void {
  const op = Number(node.Op);
  const display = sliceSource(source, node);

  if (op === REDIRECT_OPS.hdoc || op === REDIRECT_OPS.dashHdoc || op === REDIRECT_OPS.wordHdoc) {
    return; // heredoc/herestring bodies are data
  }
  if (op === REDIRECT_OPS.dplIn) {
    return; // <& duplicates an input fd
  }

  const target = literalWordText(node.Word);

  if (op === REDIRECT_OPS.dplOut) {
    if (target !== null && isDigitsOrDash(target)) {
      return; // 2>&1, >&2, >&- style fd duplication
    }
    // csh-style `>& file` writes the target
    analysis.writes.push({ target, display });
    if (target === null) {
      pushUnique(analysis.unanalyzable, `redirection target contains an expansion: ${display}`);
    }
    return;
  }

  if (WRITE_OPS.has(op)) {
    if (target !== null && SINK_DEVICES.has(target)) {
      return;
    }
    analysis.writes.push({ target, display });
    if (target === null) {
      pushUnique(analysis.unanalyzable, `redirection target contains an expansion: ${display}`);
    }
    return;
  }

  if (op === REDIRECT_OPS.rdrIn || op === REDIRECT_OPS.rdrInOut) {
    if (target !== null && SINK_DEVICES.has(target)) {
      return;
    }
    analysis.reads.push({ target, display });
    if (op === REDIRECT_OPS.rdrInOut) {
      analysis.writes.push({ target, display });
    }
    if (target === null) {
      pushUnique(analysis.unanalyzable, `redirection target contains an expansion: ${display}`);
    }
    return;
  }

  pushUnique(analysis.unanalyzable, `unrecognized redirection: ${display}`);
}

function processCallExpr(node: MvdanNode, source: string, analysis: ShellAnalysis, depth: number): void {
  const words = (node.Args || []) as MvdanNode[];
  if (words.length === 0) {
    return; // pure assignment statement; substitutions in values are walked
  }

  let argv: (string | null)[] = words.map((word) => literalWordText(word));
  const display = sliceSource(source, node);

  // Unwrap wrapper chains: `timeout 5 env FOO=1 cargo test` -> `cargo test`.
  let guard = 0;
  while (argv.length > 0 && argv[0] !== null && WRAPPER_EXECUTABLES.has(argv[0]) && guard < 10) {
    guard += 1;
    const unwrapped = unwrapWrapper(argv[0], argv.slice(1));
    if (!unwrapped.ok) {
      pushUnique(analysis.unanalyzable, `cannot locate the command run by '${argv[0]}': ${display}`);
      return;
    }
    if (unwrapped.argv.length === 0) {
      // Bare wrapper (`env` alone prints the environment): evaluate as itself.
      break;
    }
    argv = unwrapped.argv;
  }

  const executable = argv[0];
  if (executable === null) {
    pushUnique(analysis.unanalyzable, `executable name contains an expansion: ${display}`);
    return;
  }

  if (SHELL_INTERPRETERS.has(executable)) {
    const invocation = findShellCScript(argv.slice(1));
    if (invocation.found) {
      if (invocation.script === null) {
        pushUnique(analysis.unanalyzable, `shell -c script is not a literal string: ${display}`);
        return;
      }
      if (depth >= MAX_SHELL_RECURSION_DEPTH) {
        pushUnique(analysis.unanalyzable, `shell -c nesting too deep: ${display}`);
        return;
      }
      mergeAnalysis(analysis, analyzeShellCommand(invocation.script, depth + 1));
      return;
    }
    // A shell run on a script file (or interactively) stays opaque.
    analysis.commands.push({ argv, display, opaque: true });
    return;
  }

  analysis.commands.push({
    argv,
    display,
    opaque: OPAQUE_EXECUTABLES.has(executable),
  });
}

/**
 * Analyze one bash command string. Never throws; parse failures come back as
 * `unanalyzable` entries.
 */
export function analyzeShellCommand(command: string, depth = 0): ShellAnalysis {
  const analysis = createEmptyAnalysis();

  if (command.length > MAX_COMMAND_LENGTH) {
    pushUnique(analysis.unanalyzable, "command is too long to analyze");
    return analysis;
  }
  if (command.trim().length === 0) {
    return analysis;
  }

  let file: MvdanNode;
  try {
    const parser = syntax.NewParser(syntax.Variant(syntax.LangBash));
    file = parser.Parse(command, "command");
  } catch (error) {
    const message = String((error as { Error?: () => string })?.Error?.() ?? error ?? "parse error");
    pushUnique(analysis.unanalyzable, `shell syntax error: ${message.replace(/^command:/, "")}`);
    return analysis;
  }

  try {
    syntax.Walk(file, (node: MvdanNode | null) => {
      if (node === null) {
        return true;
      }
      const type = syntax.NodeType(node);
      if (type === "CallExpr") {
        processCallExpr(node, command, analysis, depth);
        return true;
      }
      if (type === "Redirect") {
        processRedirect(node, command, analysis);
        return true;
      }
      const denied = DENIED_NODE_TYPES[type];
      if (denied) {
        pushUnique(analysis.deniedSyntax, denied);
        return true;
      }
      if (!TRANSPARENT_NODE_TYPES.has(type)) {
        pushUnique(analysis.unanalyzable, `unsupported shell construct (${type})`);
      }
      return true;
    });
  } catch (error) {
    pushUnique(analysis.unanalyzable, `analysis failed: ${String(error)}`);
  }

  return analysis;
}
