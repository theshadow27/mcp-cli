/**
 * Lightweight daemon auto-start for mcpctl.
 *
 * Mirrors the spawn logic in packages/command/src/daemon-lifecycle.ts but without
 * the full locking/cooldown machinery — mcpctl just needs a best-effort attempt
 * to bring a crashed daemon back. The useDaemon polling loop naturally retries.
 */

import {
  DAEMON_READY_SIGNAL,
  DAEMON_START_TIMEOUT_MS,
  resolveDaemonCommand as coreResolveDaemonCommand,
  pingDaemon,
  spawnManaged,
} from "@mcp-cli/core";

/** Dependencies injectable for testing */
export interface EnsureDaemonDeps {
  ping: () => Promise<boolean>;
  spawn: (cmd: string[]) => { stdout: ReadableStream; unref: () => void; kill: () => void };
  resolveCmd: () => string[];
  readySignal: string;
  timeoutMs: number;
}

const defaultDeps: EnsureDaemonDeps = {
  ping: pingDaemon,
  spawn: (cmd) => {
    const [bin, ...args] = cmd;
    const r = spawnManaged(bin, args, { stdout: "pipe", stderr: "pipe" });
    if (!r.ok) throw new Error(`Failed to spawn ${bin}`);
    const stdout = r.handle.stdout;
    if (!stdout) throw new Error("stdout pipe not available");
    return {
      stdout,
      unref: () => r.handle.unref(),
      kill: () => {
        r.handle.kill();
      },
    };
  },
  resolveCmd: () => coreResolveDaemonCommand(import.meta.dir),
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

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);

    const decoder = new TextDecoder();
    const reader = proc.stdout.getReader();
    let stdout = "";

    try {
      while (!ac.signal.aborted) {
        const readResult = await Promise.race([
          reader.read(),
          new Promise<{ done: true; value: undefined }>((_, reject) => {
            ac.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), {
              once: true,
            });
          }),
        ]);
        if (readResult.done) break;
        stdout += decoder.decode(readResult.value, { stream: true });
        if (stdout.includes(readySignal)) {
          clearTimeout(timer);
          proc.unref();
          reader.releaseLock();
          return true;
        }
      }
    } catch {
      // AbortError from timeout — fall through to cleanup
    }

    clearTimeout(timer);
    proc.kill();
    reader.releaseLock();
    return await ping();
  } catch {
    return false;
  }
}
