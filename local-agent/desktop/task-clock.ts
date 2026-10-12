export class TaskTimeoutError extends Error { constructor() { super('The active task reached its one-hour execution limit. Completed actions are preserved; send a new request to continue.'); this.name = 'TaskTimeoutError'; } }

/** Counts active work only; approval expiry is independently enforced by the host. */
export class TaskClock {
  private controller = new AbortController();
  private timer?: ReturnType<typeof setTimeout>;
  private startedAt?: number;
  private left: number;
  private waits = 0;
  private closed = false;
  private now: () => number;
  constructor(budgetMs = 3_600_000, now: () => number = Date.now) { this.left = budgetMs; this.now = now; }
  get signal(): AbortSignal { return this.controller.signal; }
  get remainingMs(): number { return Math.max(0, this.left - (this.startedAt === undefined ? 0 : this.now() - this.startedAt)); }
  start(): void { if (this.closed || this.startedAt !== undefined || this.waits || this.signal.aborted) return; this.startedAt = this.now(); this.arm(); }
  pause(): void { this.waits++; if (this.waits !== 1) return; this.left = this.remainingMs; this.startedAt = undefined; if (this.timer) clearTimeout(this.timer); }
  resume(): void { if (!this.waits) return; this.waits--; if (!this.waits) this.start(); }
  private arm(): void { if (this.timer) clearTimeout(this.timer); this.timer = setTimeout(() => this.controller.abort(new TaskTimeoutError()), this.remainingMs); this.timer.unref?.(); }
  close(): void { this.closed = true; if (this.timer) clearTimeout(this.timer); this.left = this.remainingMs; this.startedAt = undefined; }
}
