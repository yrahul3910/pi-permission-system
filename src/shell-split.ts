/**
 * Split a shell command string into individual subcommands at shell operators
 * (|, &&, ||, ;) while respecting quoting, escaping, and subshell nesting.
 *
 * Returns an array of trimmed subcommand strings. If the input has no operators
 * or is a single command, returns a single-element array with the original command.
 */
export function splitShellSubcommands(command: string): string[] {
  const subcommands: string[] = [];
  let current = "";
  let i = 0;
  let singleQuote = false;
  let doubleQuote = false;
  let parenDepth = 0;

  while (i < command.length) {
    const ch = command[i];

    // Handle escape sequences outside single quotes
    if (ch === "\\" && !singleQuote && i + 1 < command.length) {
      current += ch + command[i + 1];
      i += 2;
      continue;
    }

    // Handle single quotes (no interpretation inside)
    if (ch === "'" && !doubleQuote) {
      singleQuote = !singleQuote;
      current += ch;
      i += 1;
      continue;
    }

    // Handle double quotes
    if (ch === '"' && !singleQuote) {
      doubleQuote = !doubleQuote;
      current += ch;
      i += 1;
      continue;
    }

    // Inside quotes, everything is literal
    if (singleQuote || doubleQuote) {
      current += ch;
      i += 1;
      continue;
    }

    // Track parenthesis nesting for subshells: $(...) and (...)
    if (ch === "(") {
      parenDepth += 1;
      current += ch;
      i += 1;
      continue;
    }

    if (ch === ")" && parenDepth > 0) {
      parenDepth -= 1;
      current += ch;
      i += 1;
      continue;
    }

    // Track backtick subshells
    if (ch === "`") {
      current += ch;
      i += 1;
      // Consume until matching backtick
      while (i < command.length && command[i] !== "`") {
        if (command[i] === "\\" && i + 1 < command.length) {
          current += command[i] + command[i + 1];
          i += 2;
        } else {
          current += command[i];
          i += 1;
        }
      }
      if (i < command.length) {
        current += command[i]; // closing backtick
        i += 1;
      }
      continue;
    }

    // Only split when at top level (not inside parens)
    if (parenDepth === 0) {
      // Check for || (must check before single |)
      if (ch === "|" && i + 1 < command.length && command[i + 1] === "|") {
        pushSubcommand(subcommands, current);
        current = "";
        i += 2;
        continue;
      }

      // Check for single | (pipe)
      if (ch === "|") {
        pushSubcommand(subcommands, current);
        current = "";
        i += 1;
        continue;
      }

      // Check for &&
      if (ch === "&" && i + 1 < command.length && command[i + 1] === "&") {
        pushSubcommand(subcommands, current);
        current = "";
        i += 2;
        continue;
      }

      // Check for ;
      if (ch === ";") {
        pushSubcommand(subcommands, current);
        current = "";
        i += 1;
        continue;
      }
    }

    current += ch;
    i += 1;
  }

  pushSubcommand(subcommands, current);

  // If splitting produced nothing useful, return the original command
  if (subcommands.length === 0) {
    return [command.trim()];
  }

  return subcommands;
}

function pushSubcommand(subcommands: string[], raw: string): void {
  const trimmed = raw.trim();
  if (trimmed.length > 0) {
    subcommands.push(trimmed);
  }
}

/**
 * Check whether a pattern string contains an unescaped shell operator (|, &&, ||, ;).
 * Used to determine if a pattern was intentionally written to match compound commands.
 */
export function containsShellOperator(pattern: string): boolean {
  let i = 0;
  let singleQuote = false;
  let doubleQuote = false;

  while (i < pattern.length) {
    const ch = pattern[i];

    if (ch === "\\" && !singleQuote && i + 1 < pattern.length) {
      i += 2;
      continue;
    }

    if (ch === "'" && !doubleQuote) {
      singleQuote = !singleQuote;
      i += 1;
      continue;
    }

    if (ch === '"' && !singleQuote) {
      doubleQuote = !doubleQuote;
      i += 1;
      continue;
    }

    if (singleQuote || doubleQuote) {
      i += 1;
      continue;
    }

    // Check for || (before |)
    if (ch === "|" && i + 1 < pattern.length && pattern[i + 1] === "|") {
      return true;
    }

    // Single |
    if (ch === "|") {
      return true;
    }

    // &&
    if (ch === "&" && i + 1 < pattern.length && pattern[i + 1] === "&") {
      return true;
    }

    // ;
    if (ch === ";") {
      return true;
    }

    i += 1;
  }

  return false;
}
