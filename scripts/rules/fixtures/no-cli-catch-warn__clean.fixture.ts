/**
 * @rule no-cli-catch-warn
 * @expect 0
 * @path packages/command/src/commands/run.ts
 *
 * Four safe patterns: silent swallow, console.error, DEBUG-gated warn,
 * and verbose-gated warn. None should be flagged.
 */

declare const verbose: boolean;
declare function ipcCall(method: string): Promise<void>;

export function startFireAndForget(): void {
  // Silent swallow — correct for fire-and-forget bookkeeping
  ipcCall("daemon.ping").catch(() => {});

  // console.error is acceptable for user-facing errors
  ipcCall("daemon.tick").catch((e) => {
    console.error("tick failed", e);
  });

  // DEBUG-gated warn — exempt
  ipcCall("daemon.flush").catch((e) => {
    if (process.env.DEBUG) console.warn("flush failed", e);
  });

  // verbose-gated warn — exempt
  ipcCall("daemon.sync").catch((e) => {
    if (verbose) console.warn("sync failed", e);
  });
}
