/**
 * @rule no-cli-catch-warn
 * @expect 0
 * @path packages/daemon/src/commands/run.ts
 *
 * console.warn inside .catch() in packages/daemon/ is fine — the daemon
 * runs under installDaemonLogCapture() which absorbs warnings into its
 * ring buffer. The rule only applies to packages/command/.
 */

declare function ipcCall(method: string): Promise<void>;

export function startFireAndForget(): void {
  ipcCall("daemon.ping").catch((e) => console.warn("ping failed", e));
}
