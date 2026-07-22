export const TURN_RUNTIME_UPDATE_INTERVAL_MS = 1_000;

export type WorkingMessageUi = {
  setWorkingMessage?: (message?: string) => void;
};

/** Schedules a repeating callback and returns a cleanup function for it. */
export type TurnRuntimeScheduler = {
  setInterval(callback: () => void, intervalMs: number): () => void;
};

export type TurnRuntimeTrackerOptions = {
  now?: () => number;
  scheduler?: TurnRuntimeScheduler;
};

const defaultScheduler: TurnRuntimeScheduler = {
  setInterval(callback, intervalMs) {
    const timer = setInterval(callback, intervalMs);
    return () => clearInterval(timer);
  },
};

export function formatTurnRuntime(elapsedMs: number): string {
  const totalSeconds = Math.floor(Math.max(0, elapsedMs) / 1_000);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);

  if (hours > 0) {
    return `${hours}h ${String(minutes).padStart(2, "0")}m ${String(seconds).padStart(2, "0")}s`;
  }

  if (totalMinutes > 0) {
    return `${totalMinutes}m ${String(seconds).padStart(2, "0")}s`;
  }

  return `${seconds}s`;
}

export function formatTurnWorkingMessage(elapsedMs: number): string {
  return `Working... (${formatTurnRuntime(elapsedMs)})`;
}

/**
 * Tracks one active Pi agent run. Permission prompts can be nested when tools
 * execute in parallel, so a reference count keeps the clock paused until every
 * outstanding prompt has been answered.
 */
export class TurnRuntimeTracker {
  private readonly now: () => number;
  private readonly scheduler: TurnRuntimeScheduler;
  private startedAt: number | null = null;
  private pausedAt: number | null = null;
  private pausedDurationMs = 0;
  private pauseDepth = 0;
  private stopInterval: (() => void) | null = null;
  private ui: WorkingMessageUi | null = null;

  constructor(options: TurnRuntimeTrackerOptions = {}) {
    this.now = options.now ?? Date.now;
    this.scheduler = options.scheduler ?? defaultScheduler;
  }

  get active(): boolean {
    return this.startedAt !== null;
  }

  get elapsedMs(): number {
    return this.getElapsedMs(this.now());
  }

  start(ui: WorkingMessageUi, startedAt = this.now()): void {
    if (this.active) {
      this.finish(false);
    }

    this.ui = ui;
    this.startedAt = Number.isFinite(startedAt) ? startedAt : this.now();
    this.pausedAt = null;
    this.pausedDurationMs = 0;
    this.pauseDepth = 0;
    this.update(this.now());
    this.startInterval();
  }

  pause(): void {
    if (!this.active) {
      return;
    }

    this.pauseDepth += 1;
    if (this.pauseDepth !== 1) {
      return;
    }

    const now = this.now();
    this.update(now);
    this.pausedAt = now;
    this.stopTimer();
  }

  resume(): void {
    if (!this.active || this.pauseDepth === 0) {
      return;
    }

    this.pauseDepth -= 1;
    if (this.pauseDepth !== 0) {
      return;
    }

    const now = this.now();
    if (this.pausedAt !== null) {
      this.pausedDurationMs += Math.max(0, now - this.pausedAt);
    }
    this.pausedAt = null;
    this.update(now);
    this.startInterval();
  }

  async pauseWhile<T>(operation: () => Promise<T>): Promise<T> {
    this.pause();
    try {
      return await operation();
    } finally {
      this.resume();
    }
  }

  stop(): void {
    if (!this.active) {
      return;
    }

    this.finish(true);
  }

  private finish(resetWorkingMessage: boolean): void {
    this.stopTimer();
    const ui = this.ui;
    this.startedAt = null;
    this.pausedAt = null;
    this.pausedDurationMs = 0;
    this.pauseDepth = 0;
    this.ui = null;

    if (resetWorkingMessage) {
      ui?.setWorkingMessage?.();
    }
  }

  private getElapsedMs(now: number): number {
    if (this.startedAt === null) {
      return 0;
    }

    const activePauseDuration = this.pausedAt === null
      ? 0
      : Math.max(0, now - this.pausedAt);
    return Math.max(0, now - this.startedAt - this.pausedDurationMs - activePauseDuration);
  }

  private update(now = this.now()): void {
    this.ui?.setWorkingMessage?.(formatTurnWorkingMessage(this.getElapsedMs(now)));
  }

  private startInterval(): void {
    if (!this.active || this.stopInterval) {
      return;
    }

    this.stopInterval = this.scheduler.setInterval(
      () => this.update(),
      TURN_RUNTIME_UPDATE_INTERVAL_MS,
    );
  }

  private stopTimer(): void {
    this.stopInterval?.();
    this.stopInterval = null;
  }
}
