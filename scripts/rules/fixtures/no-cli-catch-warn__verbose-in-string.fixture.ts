/**
 * @rule no-cli-catch-warn
 * @expect 2
 * @path packages/command/src/commands/run.ts
 *
 * The word "verbose" appears in string literals and a comment — neither is a
 * guard. Both console.warn calls must be flagged. The old substring-on-source
 * check would have exempted this entire callback because "verbose" appeared in
 * the raw text.
 */

declare function ipcCall(method: string): Promise<void>;

export function startFireAndForget(): void {
  // verbose mode would help here — but this comment is not a guard
  ipcCall("daemon.ping").catch((e) => {
    console.warn("error in verbose mode handler", e); // "verbose" in message — not a guard
  });

  ipcCall("daemon.flush").catch((e) => {
    console.warn("set process.env.DEBUG for verbose output", e); // both magic words in string — not a guard
  });
}
