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
