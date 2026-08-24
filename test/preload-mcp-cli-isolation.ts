/**
 * Isolate every spec from the real ~/.mcp-cli (socket, db, daemon, config).
 *
 * `packages/core/src/constants.ts` resolves its `MCP_CLI_DIR` default once,
 * at module-import time, from `process.env.MCP_CLI_DIR || join(homedir(),
 * ".mcp-cli")`. This preload runs before any spec file (or the production
 * code it imports) gets a chance to import that module, so the fallback
 * never resolves to the real home — it resolves to a throwaway directory
 * scoped to this test process instead.
 *
 * This is a backstop, not the primary isolation mechanism. Most specs that
 * need real daemon/process isolation already do it explicitly: in-process
 * via `test/test-options.ts`'s `testOptions()` (mutates `options.*` per
 * test, restored via `using`), or by spawning a subprocess with its own
 * `MCP_CLI_DIR` env override (`test/harness.ts`, `test/stress.spec.ts`).
 * This preload exists so a spec that forgets either mechanism — or any
 * *production* code path that reads `MCP_CLI_DIR` / `options.MCP_CLI_DIR`
 * before a test gets around to overriding it — still cannot reach the real
 * daemon's socket, database, or config. See #3233.
 *
 * Unconditional: any inherited `MCP_CLI_DIR` is replaced, not respected — a
 * developer's shell exporting a real `MCP_CLI_DIR` for other work must not
 * leak into `bun test`.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.MCP_CLI_DIR = mkdtempSync(join(tmpdir(), "mcp-cli-test-preload-"));
