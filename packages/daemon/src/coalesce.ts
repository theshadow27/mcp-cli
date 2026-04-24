export type SubmitOptions<T> =
  | { mode: "last-wins"; windowMs?: number }
  | { mode: "merge"; merge: (a: T, b: T) => T; windowMs?: number }
  | { mode: "never" };

interface PendingEntry<T> {
  event: T;
  timer: Timer;
}

const DEFAULT_WINDOW_MS = 500;

export class CoalescingPublisher<T> {
  private readonly pending = new Map<string, PendingEntry<T>>();
  private readonly emit: (event: T) => void;
  private disposed = false;

  constructor(emit: (event: T) => void) {
    this.emit = emit;
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
      clearTimeout(existing.timer);
      if (opts.mode === "merge") {
        value = opts.merge(existing.event, event);
      }
    }

    const timer = setTimeout(() => {
      this.flushKey(key);
    }, windowMs);
    this.pending.set(key, { event: value, timer });
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
      clearTimeout(entry.timer);
    }
    this.pending.clear();
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  private flushKey(key: string): void {
    const entry = this.pending.get(key);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(key);
    this.emit(entry.event);
  }
}
