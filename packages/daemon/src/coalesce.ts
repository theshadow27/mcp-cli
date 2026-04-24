export type SubmitOptions<T> =
  | { mode: "last-wins"; windowMs?: number }
  | { mode: "merge"; merge: (a: T, b: T) => T; windowMs?: number }
  | { mode: "never" };

export interface Clock {
  setTimeout(fn: () => void, ms: number): Timer;
  clearTimeout(timer: Timer): void;
}

interface PendingEntry<T> {
  event: T;
  timer: Timer;
  windowMs: number;
}

const DEFAULT_WINDOW_MS = 500;

const systemClock: Clock = { setTimeout, clearTimeout };

export class CoalescingPublisher<T> {
  private readonly pending = new Map<string, PendingEntry<T>>();
  private readonly emit: (event: T) => void;
  private readonly clock: Clock;
  private disposed = false;

  constructor(emit: (event: T) => void, clock: Clock = systemClock) {
    this.emit = emit;
    this.clock = clock;
  }

  submit(key: string, event: T, opts: SubmitOptions<T>): void {
    if (this.disposed) return;

    if (opts.mode === "never") {
      this.flushKey(key);
      this.emit(event);
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
          // Don't leave a zombie entry with a cleared timer.
          this.pending.delete(key);
          throw err;
        }
      }
    }

    // Lock window duration on first submission; re-submissions don't change it.
    const effectiveWindowMs = existing?.windowMs ?? windowMs;

    const timer = this.clock.setTimeout(() => {
      try {
        this.flushKey(key);
      } catch (err) {
        console.error("[CoalescingPublisher] emit error for key", key, ":", err);
      }
    }, effectiveWindowMs);
    this.pending.set(key, { event: value, timer, windowMs: effectiveWindowMs });
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
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  private flushKey(key: string): void {
    const entry = this.pending.get(key);
    if (!entry) return;
    this.clock.clearTimeout(entry.timer);
    this.pending.delete(key);
    this.emit(entry.event);
  }
}
