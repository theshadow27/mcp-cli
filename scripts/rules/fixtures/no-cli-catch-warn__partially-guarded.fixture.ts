/**
 * @rule no-cli-catch-warn
 * @expect 1
 * @path packages/command/src/commands/run.ts
 *
 * A catch body with one DEBUG-gated console.warn and one unconditional
 * console.warn. The guarded warn is exempt; the unconditional warn must still
 * be flagged. The old substring-on-source guard check would have skipped the
 * entire callback once "process.env.DEBUG" appeared anywhere in it.
 */

declare function ipcCall(method: string): Promise<void>;

export function startFireAndForget(): void {
  ipcCall("daemon.ping").catch((e) => {
    if (process.env.DEBUG) console.warn("debug detail", e); // guarded — exempt
    console.warn("always shouted at the user terminal", e); // unguarded — must be flagged
  });
}
