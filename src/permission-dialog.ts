export type PermissionDecisionState = "approved" | "denied" | "denied_with_reason" | "once" | "always" | "reject";

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
};

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

export function normalizePermissionDenialReason(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
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
  const selected = await ui.select(
    `${title}\n${message}`,
    [...PERMISSION_DECISION_OPTIONS],
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
