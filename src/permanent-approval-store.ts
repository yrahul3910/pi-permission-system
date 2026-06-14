import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { evaluatePermission, type PatternPermissionRule } from "./evaluate-permission.js";

function isPersistedRule(value: unknown): value is PatternPermissionRule {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<PatternPermissionRule>;
  return typeof candidate.tool === "string"
    && candidate.tool.trim().length > 0
    && typeof candidate.pattern === "string"
    && candidate.pattern.trim().length > 0
    && (candidate.action === "allow" || candidate.action === "deny" || candidate.action === "ask");
}

function normalizeAction(action: string): PatternPermissionRule["action"] | null {
  return action === "allow" || action === "deny" || action === "ask" ? action : null;
}

export class PermanentApprovalStore {
  private readonly persistencePath: string;
  private rules: PatternPermissionRule[] | undefined;

  constructor(options: { persistencePath: string }) {
    this.persistencePath = options.persistencePath;
  }

  private ensureLoaded(): void {
    if (this.rules === undefined) {
      this.rules = this.loadRules();
    }
  }

  approveAlways(tool: string, pattern: string, action: string): void {
    const normalizedAction = normalizeAction(action);
    const normalizedTool = tool.trim();
    const normalizedPattern = pattern.trim();
    if (!normalizedAction || !normalizedTool || !normalizedPattern) {
      return;
    }

    this.ensureLoaded();
    this.rules!.push({
      tool: normalizedTool,
      pattern: normalizedPattern,
      action: normalizedAction,
    });
    this.saveRules();
  }

  evaluate(tool: string, command: string): { state: PatternPermissionRule["action"]; matchedPattern?: string } {
    this.ensureLoaded();
    const result = evaluatePermission(tool, command, this.rules!);
    return {
      state: result.action,
      matchedPattern: result.matchedPattern,
    };
  }

  getRules(): PatternPermissionRule[] {
    this.ensureLoaded();
    return this.rules!.map((rule) => ({ ...rule }));
  }

  private loadRules(): PatternPermissionRule[] {
    if (!existsSync(this.persistencePath)) {
      return [];
    }

    try {
      const parsed = JSON.parse(readFileSync(this.persistencePath, "utf8")) as unknown;
      return Array.isArray(parsed)
        ? parsed.filter(isPersistedRule).map((rule) => ({
          tool: rule.tool.trim(),
          pattern: rule.pattern.trim(),
          action: rule.action,
        }))
        : [];
    } catch {
      return [];
    }
  }

  private saveRules(): void {
    mkdirSync(dirname(this.persistencePath), { recursive: true });
    const tempPath = `${this.persistencePath}.${process.pid}.tmp`;
    writeFileSync(tempPath, `${JSON.stringify(this.rules, null, 2)}\n`, "utf8");
    renameSync(tempPath, this.persistencePath);
  }
}
