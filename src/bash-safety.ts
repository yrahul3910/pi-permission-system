import type { PermissionState } from "./types.js";

export const BASH_SAFETY_CATEGORIES = ["complexSyntax", "redirections", "riskyOptions"] as const;
export type BashSafetyCategory = typeof BASH_SAFETY_CATEGORIES[number];
export type BashSafetyPolicy = Record<BashSafetyCategory, PermissionState>;

export const LEGACY_BASH_SAFETY: BashSafetyPolicy = { complexSyntax: "allow", redirections: "allow", riskyOptions: "allow" };

export interface BashSafetyAnalysis {
  findings: BashSafetyCategory[];
  /** Present only when this is a confidently-tokenized simple command. */
  family?: string;
}

/** Conservative shell scanner. It deliberately treats syntax it cannot model as complex. */
export function analyzeBashSafety(command: string): BashSafetyAnalysis {
  const findings = new Set<BashSafetyCategory>();
  const words: string[] = [];
  let word = "";
  let quote: "single" | "double" | null = null;
  const finish = () => { if (word) { words.push(word); word = ""; } };
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    if (ch === "\\" && quote !== "single") {
      if (i + 1 >= command.length) { findings.add("complexSyntax"); break; }
      word += command[i + 1]; i += 1; continue;
    }
    if (ch === "'" && quote !== "double") { quote = quote === "single" ? null : "single"; continue; }
    if (ch === '"' && quote !== "single") { quote = quote === "double" ? null : "double"; continue; }
    if (quote) { word += ch; continue; }
    if (ch === "`" || ch === "(" || ch === ")" || (ch === "$" && command[i + 1] === "(")) { findings.add("complexSyntax"); }
    if ((ch === "<" || ch === ">") && command[i + 1] === "(") { findings.add("complexSyntax"); }
    if (ch === "|" || ch === ";" || ch === "&" || ch === "\n" || ch === "\r") { findings.add("complexSyntax"); }
    if (ch === "<" || ch === ">") { findings.add("redirections"); }
    if (/\s/.test(ch)) { finish(); continue; }
    word += ch;
  }
  if (quote) findings.add("complexSyntax");
  finish();
  // A shell word which contains a substitution remains unsafe even if the rest scanned.
  const executable = words[0];
  if (executable === "rg" && words.some((word) => word === "--pre" || word.startsWith("--pre="))) findings.add("riskyOptions");
  if (executable === "fd" && words.some((word) => ["-x", "-X"].includes(word) || word === "--exec" || word.startsWith("--exec=") || word === "--exec-batch" || word.startsWith("--exec-batch="))) findings.add("riskyOptions");
  if (executable === "sed" && words.some((word) => word === "-i" || word.startsWith("-i") || word === "--in-place" || word.startsWith("--in-place=") || /\/e(?:$|[^a-zA-Z])/.test(word))) findings.add("riskyOptions");
  if (executable === "git" && words.some((word) => word === "--ext-diff" || word.startsWith("--ext-diff="))) findings.add("riskyOptions");
  return { findings: [...findings], family: findings.size === 0 && executable && /^[A-Za-z0-9_./-]+$/.test(executable) ? executable : undefined };
}

export function mostRestrictive(states: readonly PermissionState[]): PermissionState {
  return states.includes("deny") ? "deny" : states.includes("ask") ? "ask" : "allow";
}
