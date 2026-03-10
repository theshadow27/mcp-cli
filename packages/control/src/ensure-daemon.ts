/**
 * Lightweight daemon auto-start for mcpctl.
 *
 * Mirrors the spawn logic in packages/command/src/daemon-lifecycle.ts but without
 * the full locking/cooldown machinery — mcpctl just needs a best-effort attempt
 * to bring a crashed daemon back. The useDaemon polling loop naturally retries.
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  DAEMON_BINARY_NAME,
  DAEMON_DEV_SCRIPT,
  DAEMON_READY_SIGNAL,
  DAEMON_START_TIMEOUT_MS,
  findFileUpward,
  pingDaemon,
} from "@mcp-cli/core";

/** Resolve the daemon command, same strategy as command/daemon-lifecycle.ts */
export function resolveDaemonCommand(): string[] {
  // Compiled mode: mcpd binary next to current executable
  const siblingBinary = join(dirname(process.execPath), DAEMON_BINARY_NAME);
  if (existsSync(siblingBinary)) return [siblingBinary];

  // Dev mode: walk up from this file to find workspace root, then resolve daemon script
  const devScript = findFileUpward(DAEMON_DEV_SCRIPT, import.meta.dir);
  if (devScript) return ["bun", "run", devScript];

  // Fallback: assume mcpd is on PATH
  return [DAEMON_BINARY_NAME];
}

/** Dependencies injectable for testing */
export interface EnsureDaemonDeps {
  ping: () => Promise<boolean>;
  spawn: (cmd: string[]) => { stdout: ReadableStream; stderr: ReadableStream; unref: () => void };
  resolveCmd: () => string[];
  readySignal: string;
  timeoutMs: number;
}

const defaultDeps: EnsureDaemonDeps = {
  ping: pingDaemon,
  spawn: (cmd) => Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" }),
  resolveCmd: resolveDaemonCommand,
  readySignal: DAEMON_READY_SIGNAL,
  timeoutMs: DAEMON_START_TIMEOUT_MS,
};

/**
 * Attempt to start the daemon if it's not responding.
 * Returns true if daemon is reachable after the call, false otherwise.
 * Never throws — errors are swallowed since the polling loop will retry.
 */
export async function ensureDaemonRunning(deps: Partial<EnsureDaemonDeps> = {}): Promise<boolean> {
  const { ping, spawn, resolveCmd, readySignal, timeoutMs } = { ...defaultDeps, ...deps };

  // Already alive? Nothing to do.
  if (await ping()) return true;

  try {
    const cmd = resolveCmd();
    const proc = spawn(cmd);

    // Wait for MCPD_READY signal on stdout
    const decoder = new TextDecoder();
    const reader = proc.stdout.getReader();
    const deadline = Date.now() + timeoutMs;
    let stdout = "";

    // Drain stderr to prevent pipe buffer deadlock
    const stderrReader = proc.stderr.getReader();
    const drainStderr = (async () => {
      for (;;) {
        const { done } = await stderrReader.read();
        if (done) break;
      }
    })();

    while (Date.now() < deadline) {
      const { done, value } = await reader.read();
      if (done) break;
      stdout += decoder.decode(value, { stream: true });
      if (stdout.includes(readySignal)) {
        // Detach — let daemon run independently
        proc.unref();
        reader.releaseLock();
        stderrReader.cancel();
        return true;
      }
    }

    // Timed out or process exited without ready signal
    await drainStderr.catch(() => {});
    return await ping();
  } catch {
    return false;
  }
}
