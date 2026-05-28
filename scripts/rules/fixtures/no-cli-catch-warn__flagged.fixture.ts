/**
 * @rule no-cli-catch-warn
 * @expect 3
 * @path packages/command/src/commands/run.ts
 *
 * Three unguarded console.warn calls inside .catch() handlers: one in an
 * inline arrow, one in a block-body arrow, and one in a function expression.
 * All should be flagged.
 */

declare function ipcCall(method: string): Promise<void>;

export function startFireAndForget(): void {
  ipcCall("daemon.ping").catch((e) => console.warn("ping failed", e));

  ipcCall("daemon.tick").catch((e) => {
    console.warn("tick failed silently", e);
  });

  ipcCall("daemon.flush").catch(function (e) {
    console.warn("flush failed", e);
  });
}
