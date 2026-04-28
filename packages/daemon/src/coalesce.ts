export type SubmitOptions<T> =
  | { mode: "last-wins"; windowMs?: number; maxWaitMs?: number }
  | { mode: "merge"; merge: (a: T, b: T) => T; windowMs?: number; maxWaitMs?: number }
  | { mode: "never" };

export interface Clock {
  setTimeout(fn: () => void, ms: number): Timer;
  clearTimeout(timer: Timer): void;
  now(): number;
}

export interface CoalescerMetrics {
  pendingKeys: { set(n: number): void };
  overflowTotal: { inc(n?: number): void };
  emitErrors: { inc(n?: number): void };
}

export interface CoalescerOptions {
  clock?: Clock;
  maxKeys?: number;
  metrics?: CoalescerMetrics;
}

interface PendingEntry<T> {
  event: T;
  timer: Timer;
  windowMs: number;
  pendingAt: number;
}

const DEFAULT_WINDOW_MS = 500;
const DEFAULT_MAX_KEYS = 10_000;

const systemClock: Clock = { setTimeout, clearTimeout, now: Date.now };

export class CoalescingPublisher<T> {
  private readonly pending = new Map<string, PendingEntry<T>>();
  private readonly emit: (event: T) => void;
  private readonly clock: Clock;
  private readonly maxKeys: number;
  private readonly metrics: CoalescerMetrics | null;
  private disposed = false;

  constructor(emit: (event: T) => void, opts: CoalescerOptions = {}) {
    this.emit = emit;
    this.clock = opts.clock ?? systemClock;
    const maxKeys = opts.maxKeys ?? DEFAULT_MAX_KEYS;
    if (!Number.isFinite(maxKeys) || maxKeys < 1) {
      throw new RangeError(`CoalescingPublisher: maxKeys must be a positive integer, got ${maxKeys}`);
    }
    this.maxKeys = Math.trunc(maxKeys);
    this.metrics = opts.metrics ?? null;
  }

  submit(key: string, event: T, opts: SubmitOptions<T>): void {
    if (this.disposed) return;

    if (opts.mode === "never") {
      this.flushKey(key);
      try {
        this.emit(event);
      } catch (err) {
        this.metrics?.emitErrors.inc();
        throw err;
      }
      return;
    }

    const windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
    const existing = this.pending.get(key);
    let value = event;

    if (existing) {
      this.clock.clearTimeout(existing.timer);
      if (opts.mode === "merge") {
        try {
          value = opts.merge(existing.event, event);
        } catch (err) {
          this.pending.delete(key);
          this.updatePendingGauge();
          throw err;
        }
      }
    } else if (this.pending.size >= this.maxKeys) {
      const oldest = this.pending.keys().next();
      if (!oldest.done) {
        try {
          this.flushKey(oldest.value);
        } finally {
          this.metrics?.overflowTotal.inc();
        }
      }
    }

    const effectiveWindowMs = existing?.windowMs ?? windowMs;
    const pendingAt = existing?.pendingAt ?? this.clock.now();

    let timerMs = effectiveWindowMs;
    if (opts.maxWaitMs !== undefined && existing) {
      const remainingMs = pendingAt + opts.maxWaitMs - this.clock.now();
      timerMs = Math.min(effectiveWindowMs, Math.max(0, remainingMs));
    }

    const timer = this.clock.setTimeout(() => {
      try {
        this.flushKey(key);
      } catch (err) {
        console.error("[CoalescingPublisher] emit error for key", key, ":", err);
      }
    }, timerMs);
    this.pending.set(key, { event: value, timer, windowMs: effectiveWindowMs, pendingAt });
    this.updatePendingGauge();
  }

  flush(key?: string): void {
    if (key !== undefined) {
      this.flushKey(key);
      return;
    }
    for (const k of Array.from(this.pending.keys())) {
      this.flushKey(k);
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const entry of this.pending.values()) {
      this.clock.clearTimeout(entry.timer);
    }
    this.pending.clear();
    this.updatePendingGauge();
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  private flushKey(key: string): void {
    const entry = this.pending.get(key);
    if (!entry) return;
    this.clock.clearTimeout(entry.timer);
    this.pending.delete(key);
    this.updatePendingGauge();
    try {
      this.emit(entry.event);
    } catch (err) {
      this.metrics?.emitErrors.inc();
      throw err;
    }
  }

  private updatePendingGauge(): void {
    this.metrics?.pendingKeys.set(this.pending.size);
  }
}
