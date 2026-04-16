#!/usr/bin/env bun
/**
 * mcpd entry point — signal handlers and process lifecycle.
 * Separated from index.ts so the testable startDaemon() function
 * isn't penalized by untestable process-level boilerplate.
 */

import { assertBunVersion } from "@mcp-cli/core";
import { startDaemon } from "./index";

assertBunVersion();

/**
 * Worker entries that can be dispatched via argv in compiled binaries.
 *
 * In compiled mode, Bun.spawn([process.execPath, './alias-executor.ts'])
 * re-invokes the mcpd binary with the worker path as an argument. Without
 * this dispatch, the binary unconditionally starts a second daemon (#1411).
 */
const WORKER_ENTRIES: Record<string, string> = {
  "alias-executor.ts": "./alias-executor.ts",
};

/** Check if argv indicates a worker subprocess dispatch. */
export function resolveWorkerEntry(argv: string[]): string | undefined {
  const lastArg = argv.at(-1);
  if (!lastArg) return undefined;
  for (const [suffix, modulePath] of Object.entries(WORKER_ENTRIES)) {
    if (lastArg === `./${suffix}` || lastArg.endsWith(`/${suffix}`)) {
      return modulePath;
    }
  }
  return undefined;
}

async function main(): Promise<void> {
  // Prevent EPIPE on stderr from crashing the daemon when the parent
  // terminal disconnects. This is a safety net — individual write sites
  // also catch EPIPE, but this covers any we might miss.
  process.stderr.on("error", () => {});

  const handle = await startDaemon();

  // Track whether shutdown was triggered by an error (exit code 1) vs clean (exit code 0)
  let exitCode = 0;

  process.on("SIGTERM", () => {
    handle.shutdown("SIGTERM");
  });
  process.on("SIGINT", () => {
    handle.shutdown("SIGINT");
  });

  process.on("uncaughtException", (err) => {
    console.error("[mcpd] Uncaught exception:", err);
    exitCode = 1;
    handle.shutdown("uncaught exception");
  });
  process.on("unhandledRejection", (rejection) => {
    console.error("[mcpd] Unhandled rejection:", rejection);
    exitCode = 1;
    handle.shutdown("unhandled rejection");
  });

  // Single exit point for ALL shutdown paths (SIGTERM, SIGINT, IPC, idle, errors).
  // Before this fix, IPC shutdown completed cleanup but never called process.exit(),
  // leaving the process alive indefinitely under resource contention (#1103).
  await handle.shutdownComplete;
  process.exit(exitCode);
}

if (import.meta.main) {
  const workerEntry = resolveWorkerEntry(process.argv);
  if (workerEntry) {
    import(workerEntry);
  } else {
    main().catch((err) => {
      console.error("[mcpd] Fatal:", err);
      process.exit(1);
    });
  }
}
