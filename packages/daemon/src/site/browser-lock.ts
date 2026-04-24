/**
 * Creates a serial async mutex. All callers queue behind the previous holder;
 * no two calls execute concurrently. The lock is released in `finally` so
 * throws still unblock waiting callers.
 */
export function createBrowserLock() {
  let lock: Promise<void> = Promise.resolve();
  return async function withBrowserLock<T>(fn: () => Promise<T>): Promise<T> {
    const prev = lock;
    let release!: () => void;
    lock = new Promise<void>((r) => {
      release = r;
    });
    try {
      await prev;
      return await fn();
    } finally {
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
