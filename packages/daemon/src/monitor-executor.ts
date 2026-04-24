/**
 * Monitor executor subprocess script.
 *
 * Launched by Bun.spawn from the MonitorRuntime to run a defineMonitor
 * alias's async generator in an isolated subprocess. Reads config from
 * stdin as JSON, evals the bundled JS, iterates the generator, and writes
 * each yielded event as NDJSON to stdout.
 *
 * Fault isolation: a monitor that deadlocks, leaks memory, or panics
 * takes down this subprocess, not the daemon.
 *
 * Shutdown: SIGTERM triggers the AbortController, giving the generator
 * a chance to clean up before the process exits.
 */

import { evalMonitorBundled, stubProxy } from "@mcp-cli/core";

interface ExecutorInput {
  bundledJs: string;
  aliasName: string;
}

async function main(): Promise<void> {
  const stdinText = await Bun.stdin.text();
  const { bundledJs, aliasName } = JSON.parse(stdinText) as ExecutorInput;

  const stderrWrite = (data: string) => process.stderr.write(`[monitor:${aliasName}] ${data}\n`);
  console.log = stderrWrite;
  console.warn = stderrWrite;
  console.error = stderrWrite;
  console.info = stderrWrite;
  console.debug = stderrWrite;

  const monitor = await evalMonitorBundled(bundledJs, stubProxy);

  const ac = new AbortController();

  process.on("SIGTERM", () => {
    ac.abort();
  });

  const gen = monitor.subscribe({ signal: ac.signal, mcp: stubProxy });

  try {
    for await (const event of gen) {
      const line = JSON.stringify(event);
      process.stdout.write(`${line}\n`);
    }
  } catch (err) {
    if (ac.signal.aborted) return;
    throw err;
  }
}

main().catch((err) => {
  process.stderr.write(`[monitor-executor] fatal: ${String(err)}\n`);
  process.exit(1);
});
