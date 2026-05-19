interface BrowserLockOptions {
  /** Emit a warning when a caller waits longer than this for the lock. Default: 200ms. */
  warnThresholdMs?: number;
  /** Override the warning sink. Default: console.warn. Injected for testing. */
  warn?: (msg: string) => void;
}

/**
 * Creates a serial async mutex. All callers queue behind the previous holder;
 * no two calls execute concurrently. The lock is released in `finally` so
 * throws still unblock waiting callers.
 *
 * Emits a structured warning when a caller waits longer than `warnThresholdMs`
 * (default 200ms) so contention is visible in the daemon log without a code
 * change to reproduce.
 */
export function createBrowserLock(options: BrowserLockOptions = {}) {
  const { warnThresholdMs = 200, warn = (msg: string) => console.warn(msg) } = options;
  let lock: Promise<void> = Promise.resolve();
  // Tracks callers currently inside withBrowserLock (holding or waiting). Used to
  // distinguish genuine contention (queueSize > 0 on entry) from the initial
  // resolved-promise await that every first caller goes through.
  let queueSize = 0;
  return async function withBrowserLock<T>(fn: () => Promise<T>, label?: string): Promise<T> {
    const contended = queueSize > 0;
    queueSize++;
    const prev = lock;
    let release!: () => void;
    lock = new Promise<void>((r) => {
      release = r;
    });
    try {
      const start = performance.now();
      await prev;
      const waited = performance.now() - start;
      if (contended && waited > warnThresholdMs) {
        const callerSuffix = label ? ` (caller: ${label})` : "";
        warn(`[site-worker] browser-lock: waiting ${Math.round(waited)}ms for lock${callerSuffix}`);
      }
      return await fn();
    } finally {
      queueSize--;
      release();
    }
  };
}

/**
 * Races `work` against a deadline. Rejects with a descriptive error if `ms`
 * elapses first, ensuring the lock is released by the caller's `finally`.
 * The timeout handle is always cleared to avoid keeping the event loop alive.
 */
export async function withDeadline<T>(ms: number, label: string, work: Promise<T>): Promise<T> {
  let id: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    id = setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(id);
  }
}
