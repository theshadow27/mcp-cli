#!/usr/bin/env bun
/**
 * mcpd entry point — signal handlers and process lifecycle.
 * Separated from index.ts so the testable startDaemon() function
 * isn't penalized by untestable process-level boilerplate.
 */

import { startDaemon } from "./index";

async function main(): Promise<void> {
  // Prevent EPIPE on stderr from crashing the daemon when the parent
  // terminal disconnects. This is a safety net — individual write sites
  // also catch EPIPE, but this covers any we might miss.
  process.stderr.on("error", () => {});

  const handle = await startDaemon();

  process.on("SIGTERM", () => {
    handle.shutdown("SIGTERM").then(() => process.exit(0));
  });
  process.on("SIGINT", () => {
    handle.shutdown("SIGINT").then(() => process.exit(0));
  });

  process.on("uncaughtException", (err) => {
    console.error("[mcpd] Uncaught exception:", err);
    handle
      .shutdown("uncaught exception")
      .then(() => process.exit(1))
      .catch(() => process.exit(1));
  });
  process.on("unhandledRejection", (rejection) => {
    console.error("[mcpd] Unhandled rejection:", rejection);
    handle
      .shutdown("unhandled rejection")
      .then(() => process.exit(1))
      .catch(() => process.exit(1));
  });
}

main().catch((err) => {
  console.error("[mcpd] Fatal:", err);
  process.exit(1);
});
