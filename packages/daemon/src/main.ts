#!/usr/bin/env bun
/**
 * mcpd entry point — signal handlers and process lifecycle.
 * Separated from index.ts so the testable startDaemon() function
 * isn't penalized by untestable process-level boilerplate.
 */

import { assertBunVersion } from "@mcp-cli/core";
import { startDaemon } from "./index";
import { workerPath } from "./worker-path";

assertBunVersion();

/**
 * Worker source filenames dispatchable via argv in compiled binaries.
 *
 * In compiled mode, Bun.spawn([process.execPath, <worker-path>]) re-invokes the
 * mcpd binary with the worker path as an argument. Without this dispatch, the
 * binary unconditionally starts a second daemon (#1411).
 */
const WORKER_ENTRIES = ["alias-executor.ts"];

/** Extension-less stem so a `.ts` source matches an embedded `.js`. */
function entryStem(name: string): string {
  return name.replace(/\.[cm]?[jt]s$/, "");
}

/**
 * If argv indicates a worker subprocess dispatch, return the canonical worker
 * source filename (to be resolved via the layout-tolerant resolver before
 * import), else undefined.
 *
 * The daemon spawns `mcpd <resolved-worker-path>`, where that path is the
 * embedded module resolved via `workerPath()` — `.js` in a compiled binary
 * (`/$bunfs/…`), `.ts` in dev. Matching a literal `.ts` suffix therefore misses
 * the compiled dispatch and starts a second daemon (#2821), so match the stem
 * against both extensions.
 */
export function resolveWorkerEntry(argv: string[]): string | undefined {
  const lastArg = argv.at(-1);
  if (!lastArg) return undefined;
  for (const entry of WORKER_ENTRIES) {
    const stem = entryStem(entry);
    if (
      lastArg === `./${stem}.ts` ||
      lastArg === `./${stem}.js` ||
      lastArg.endsWith(`/${stem}.ts`) ||
      lastArg.endsWith(`/${stem}.js`)
    ) {
      return entry;
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
    // Resolve through the layout-tolerant resolver rather than importing a
    // predicted literal path: the embedded module layout is Bun-outbase
    // dependent (#2801), and a predicted `./alias-executor.ts` fails to
    // resolve in the compiled binary's module graph (#2821).
    import(workerPath(workerEntry));
  } else {
    main().catch((err) => {
      console.error("[mcpd] Fatal:", err);
      process.exit(1);
    });
  }
}
