import { getNonEmptyString } from "./common.js";

export type PermissionDecisionState = "approved" | "denied" | "denied_with_reason" | "once" | "always" | "always_family" | "reject";

export type PermissionPromptDecision = {
  approved: boolean;
  state: PermissionDecisionState;
  denialReason?: string;
};

export interface PermissionDecisionUiSelectOptions {
  timeout?: number;
}

export interface PermissionDecisionUi {
  select(title: string, options: string[], optionsOverride?: PermissionDecisionUiSelectOptions): Promise<string | undefined>;
  input(title: string, placeholder?: string): Promise<string | undefined>;
}

export type PermissionDecisionRequestOptions = {
  timeoutMs?: number;
  timeoutDenialReason?: string;
  /**
   * Command family prefixes (e.g. ["wc", "git push"]) for a bash prompt.
   * When set, the dialog offers "Allow for this session: wc, git push".
   * Callers must only pass families derived from the real command via the
   * bash evaluator — never a UI label or forwarded payload — and must
   * re-derive them again before persisting the approval.
   */
  sessionFamilies?: readonly string[];
};

export function formatSessionFamiliesOptionLabel(families: readonly string[]): string {
  return `Allow for this session: ${families.join(", ")}`;
}

/** Decision states that persist a session-scoped approval when approved. */
export function isSessionPersistentDecisionState(state: PermissionDecisionState): boolean {
  return state === "always" || state === "always_family";
}

const APPROVE_ONCE_OPTION = "Allow Once";
const APPROVE_ALWAYS_OPTION = "Allow Always";
const REJECT_OPTION = "Reject";
const REJECT_WITH_REASON_OPTION = "Reject with Reason";
const PERMISSION_DECISION_OPTIONS = [
  APPROVE_ONCE_OPTION,
  APPROVE_ALWAYS_OPTION,
  REJECT_OPTION,
  REJECT_WITH_REASON_OPTION,
] as const;
const PERMISSION_DIALOG_MAX_VISIBLE_LINES = 32;
const PERMISSION_DIALOG_MAX_VISIBLE_CHARACTERS = 2_200;
const PERMISSION_DIALOG_MIN_VISIBLE_LINES = 4;
const PERMISSION_DIALOG_MIN_VISIBLE_CHARACTERS = 200;
/**
 * Terminal rows the host select dialog needs around the prompt text: borders,
 * spacers, up to five decision options, the key-hint line, and the footer
 * rendered below the dialog. Keeping the prompt within
 * `terminal rows - this reserve` lets the whole dialog fit inside the
 * viewport; a dialog taller than the screen forces the TUI to scroll on every
 * repaint (selection moves, countdown ticks), which shows up as vertical
 * jitter.
 */
const PERMISSION_DIALOG_RESERVED_TERMINAL_ROWS = 16;
/** Horizontal padding the host dialog adds around each prompt text line. */
const PERMISSION_DIALOG_HORIZONTAL_PADDING = 2;

export interface PermissionDialogViewport {
  rows?: number;
  columns?: number;
}

export interface PermissionDialogRenderLimits {
  /** Budget of rendered terminal rows available to the prompt text. */
  maxVisibleLines: number;
  /** Budget of characters available to the prompt text. */
  maxVisibleCharacters: number;
  /** Columns one prompt line can use before the host dialog wraps it. */
  contentColumns?: number;
}

function sanitizeViewportDimension(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

function clampToRange(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function readPermissionDialogViewport(): PermissionDialogViewport {
  try {
    const stdout = process.stdout as { rows?: unknown; columns?: unknown } | undefined;
    return {
      rows: sanitizeViewportDimension(stdout?.rows),
      columns: sanitizeViewportDimension(stdout?.columns),
    };
  } catch {
    return {};
  }
}

/**
 * Resolve how much prompt text the permission dialog can show without growing
 * taller than the terminal. Falls back to the static caps when the viewport
 * is unknown (non-TTY stdout, tests, forwarded contexts).
 */
export function resolvePermissionDialogRenderLimits(
  viewport: PermissionDialogViewport = readPermissionDialogViewport(),
): PermissionDialogRenderLimits {
  const rows = sanitizeViewportDimension(viewport.rows);
  const columns = sanitizeViewportDimension(viewport.columns);
  const contentColumns = columns !== undefined
    ? Math.max(20, columns - PERMISSION_DIALOG_HORIZONTAL_PADDING)
    : undefined;

  const maxVisibleLines = rows !== undefined
    ? clampToRange(
      rows - PERMISSION_DIALOG_RESERVED_TERMINAL_ROWS,
      PERMISSION_DIALOG_MIN_VISIBLE_LINES,
      PERMISSION_DIALOG_MAX_VISIBLE_LINES,
    )
    : PERMISSION_DIALOG_MAX_VISIBLE_LINES;

  const characterBudget = contentColumns !== undefined
    ? maxVisibleLines * contentColumns
    : Math.floor(
      (PERMISSION_DIALOG_MAX_VISIBLE_CHARACTERS * maxVisibleLines) / PERMISSION_DIALOG_MAX_VISIBLE_LINES,
    );
  const maxVisibleCharacters = clampToRange(
    characterBudget,
    PERMISSION_DIALOG_MIN_VISIBLE_CHARACTERS,
    PERMISSION_DIALOG_MAX_VISIBLE_CHARACTERS,
  );

  return { maxVisibleLines, maxVisibleCharacters, contentColumns };
}

function splitPromptLines(value: string): string[] {
  return value.split(/\r\n|\r|\n/);
}

/** Rows one logical prompt line occupies once the host dialog word-wraps it. */
function estimateRenderedRows(line: string, contentColumns: number | undefined): number {
  if (contentColumns === undefined || contentColumns <= 0) {
    return 1;
  }
  return Math.max(1, Math.ceil(line.length / contentColumns));
}

function estimateRenderedRowsForLines(lines: readonly string[], contentColumns: number | undefined): number {
  let rows = 0;
  for (const line of lines) {
    rows += estimateRenderedRows(line, contentColumns);
  }
  return rows;
}

function formatPromptCompactionNotice(omittedLines: number, omittedCharacters: number): string {
  const omittedParts = [
    omittedLines > 0 ? `${omittedLines} ${omittedLines === 1 ? "line" : "lines"}` : null,
    omittedCharacters > 0 ? `${omittedCharacters} ${omittedCharacters === 1 ? "character" : "characters"}` : null,
  ].filter((part): part is string => typeof part === "string");
  const omittedSummary = omittedParts.length > 0 ? omittedParts.join(" and ") : "content";
  return `[Permission prompt compacted: omitted ${omittedSummary} to keep the permission dialog usable.]`;
}

export function compactPermissionPromptForSelect(
  value: string,
  limits: PermissionDialogRenderLimits = resolvePermissionDialogRenderLimits(),
): string {
  const { maxVisibleLines, maxVisibleCharacters, contentColumns } = limits;
  const lines = splitPromptLines(value);
  if (
    estimateRenderedRowsForLines(lines, contentColumns) <= maxVisibleLines
    && value.length <= maxVisibleCharacters
  ) {
    return value;
  }

  const noticeRowsReserve = estimateRenderedRows(
    formatPromptCompactionNotice(lines.length, value.length),
    contentColumns,
  );
  const maxPrefixRows = Math.max(1, maxVisibleLines - noticeRowsReserve);
  const prefixLines: string[] = [];
  let usedPrefixRows = 0;
  for (const line of lines) {
    const lineRows = estimateRenderedRows(line, contentColumns);
    if (prefixLines.length > 0 && usedPrefixRows + lineRows > maxPrefixRows) {
      break;
    }
    prefixLines.push(line);
    usedPrefixRows += lineRows;
    if (usedPrefixRows >= maxPrefixRows) {
      break;
    }
  }
  const omittedLines = Math.max(0, lines.length - prefixLines.length);
  let prefix = prefixLines.join("\n");

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const omittedCharacters = Math.max(0, value.length - prefix.length);
    const notice = formatPromptCompactionNotice(omittedLines, omittedCharacters);
    const separatorLength = prefix.trimEnd() ? 1 : 0;
    const maxPrefixCharacters = Math.max(0, maxVisibleCharacters - notice.length - separatorLength);

    if (prefix.length <= maxPrefixCharacters) {
      return prefix.trimEnd() ? `${prefix.trimEnd()}\n${notice}` : notice;
    }

    prefix = prefix.slice(0, maxPrefixCharacters).trimEnd();
  }

  const omittedCharacters = Math.max(0, value.length - prefix.length);
  const notice = formatPromptCompactionNotice(omittedLines, omittedCharacters);
  return prefix.trimEnd() ? `${prefix.trimEnd()}\n${notice}` : notice;
}

export function normalizePermissionDenialReason(value: unknown): string | undefined {
  return getNonEmptyString(value) ?? undefined;
}

export function createDeniedPermissionDecision(
  denialReason?: string,
): PermissionPromptDecision {
  const normalizedReason = normalizePermissionDenialReason(denialReason);
  return normalizedReason
    ? {
      approved: false,
      state: "denied_with_reason",
      denialReason: normalizedReason,
    }
    : {
      approved: false,
      state: "denied",
    };
}

export function isPermissionDecisionState(
  value: unknown,
): value is PermissionDecisionState {
  return value === "approved"
    || value === "denied"
    || value === "denied_with_reason"
    || value === "once"
    || value === "always"
    || value === "always_family"
    || value === "reject";
}

export async function requestPermissionDecisionFromUi(
  ui: PermissionDecisionUi,
  title: string,
  message: string,
  options: PermissionDecisionRequestOptions = {},
): Promise<PermissionPromptDecision> {
  const selectOptions = typeof options.timeoutMs === "number" && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
    ? { timeout: options.timeoutMs }
    : undefined;
  const sessionFamilies = (options.sessionFamilies ?? [])
    .map((family) => family.trim())
    .filter((family) => family.length > 0);
  const sessionFamiliesOption = sessionFamilies.length > 0 ? formatSessionFamiliesOptionLabel(sessionFamilies) : null;
  const decisionOptions = sessionFamiliesOption
    ? [APPROVE_ONCE_OPTION, APPROVE_ALWAYS_OPTION, sessionFamiliesOption, REJECT_OPTION, REJECT_WITH_REASON_OPTION]
    : [...PERMISSION_DECISION_OPTIONS];
  const selected = await ui.select(
    compactPermissionPromptForSelect(`${title}\n${message}`),
    decisionOptions,
    selectOptions,
  );

  if (selected === APPROVE_ONCE_OPTION) {
    return {
      approved: true,
      state: "once",
    };
  }

  if (selected === APPROVE_ALWAYS_OPTION) {
    return {
      approved: true,
      state: "always",
    };
  }

  if (sessionFamiliesOption && selected === sessionFamiliesOption) {
    return {
      approved: true,
      state: "always_family",
    };
  }

  if (selected === REJECT_WITH_REASON_OPTION) {
    const denialReason = normalizePermissionDenialReason(
      await ui.input(
        `${title}\nShare why this request was denied (optional).`,
        "Reason shown back to the agent",
      ),
    );

    return denialReason
      ? { approved: false, state: "reject", denialReason }
      : { approved: false, state: "reject" };
  }

  return options.timeoutDenialReason
    ? { approved: false, state: "reject", denialReason: options.timeoutDenialReason }
    : { approved: false, state: "reject" };
}
