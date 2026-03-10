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
} from "@mcp-cli/core";

/** Dependencies injectable for testing */
export interface EnsureDaemonDeps {
  ping: () => Promise<boolean>;
  spawn: (cmd: string[]) => { stdout: ReadableStream; stderr: ReadableStream; unref: () => void; kill: () => void };
  resolveCmd: () => string[];
  readySignal: string;
  timeoutMs: number;
}

const defaultDeps: EnsureDaemonDeps = {
  ping: pingDaemon,
  spawn: (cmd) => Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" }),
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

    // Abort controller bounds all reads to the timeout window.
    // This prevents reader.read() from blocking indefinitely if the
    // daemon emits partial output then hangs.
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);

    // Wait for MCPD_READY signal on stdout
    const decoder = new TextDecoder();
    const reader = proc.stdout.getReader();
    let stdout = "";

    // Drain stderr to prevent pipe buffer deadlock.
    // Attach .catch() so cancellation doesn't produce an unhandled rejection.
    const stderrReader = proc.stderr.getReader();
    const drainStderr = (async () => {
      try {
        for (;;) {
          const { done } = await stderrReader.read();
          if (done) break;
        }
      } catch {
        // Cancelled or aborted — expected on success/timeout paths
      }
    })();

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
          // Detach — let daemon run independently
          clearTimeout(timer);
          proc.unref();
          reader.releaseLock();
          stderrReader.cancel().catch(() => {});
          await drainStderr;
          return true;
        }
      }
    } catch {
      // AbortError from timeout — fall through to cleanup
    }

    // Timed out or process exited without ready signal — kill to avoid orphans
    clearTimeout(timer);
    proc.kill();
    reader.releaseLock();
    stderrReader.cancel().catch(() => {});
    await drainStderr;
    return await ping();
  } catch {
    return false;
  }
}
