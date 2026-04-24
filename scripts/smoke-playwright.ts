#!/usr/bin/env bun
/**
 * Compiled-binary smoke test for playwright runtime resolution.
 *
 * Verifies that resolvePlaywright() can find playwright from an explicit
 * on-disk path when running as a compiled Bun binary — the scenario that
 * caused #1601 and is fixed by #1615 but was previously untested in CI.
 *
 * Builds a tiny probe binary with --external playwright (matching how
 * dist/mcpd is built), then runs it against the installed node_modules/
 * playwright path.  No running daemon is required.
 *
 * Run after `bun install`:
 *   bun scripts/smoke-playwright.ts
 *
 * Exits 0 if the resolver works, 1 if it fails.
 */

import { existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { $ } from "bun";

const PROBE_SRC = resolve("scripts/playwright-resolver-probe.ts");
const PROBE_OUT = resolve("dist/playwright-resolver-probe");

// playwright is a workspace devDependency — it must be in node_modules after
// `bun install`.  We use this as the on-disk candidate to avoid needing a
// vendor-dir install during CI.
const PLAYWRIGHT_CANDIDATE = resolve("node_modules/playwright");

let failed = false;

function fail(msg: string): void {
  console.error(`  ✗ ${msg}`);
  failed = true;
}

function pass(msg: string): void {
  console.error(`  ✓ ${msg}`);
}

console.error("Playwright resolver binary smoke test\n");

// ── Pre-flight ──────────────────────────────────────────────────────────────

if (!existsSync(PLAYWRIGHT_CANDIDATE)) {
  console.error(`ERROR: ${PLAYWRIGHT_CANDIDATE} not found — run 'bun install' first.`);
  process.exit(1);
}

// ── Compile probe ───────────────────────────────────────────────────────────

console.error("Compiling probe binary...");

await $`mkdir -p dist`;

const buildResult =
  await $`bun build --compile --minify --external playwright --external playwright-core ${PROBE_SRC} --outfile ${PROBE_OUT}`
    .quiet()
    .nothrow();

if (buildResult.exitCode !== 0) {
  console.error(`ERROR: probe compilation failed (exit ${buildResult.exitCode}):`);
  console.error(buildResult.stderr.toString());
  process.exit(1);
}

pass("probe compiled");

// ── Run probe ───────────────────────────────────────────────────────────────

console.error("\nRunning probe against on-disk playwright candidate...");

const runResult = await $`${PROBE_OUT} ${PLAYWRIGHT_CANDIDATE}`.quiet().nothrow();

if (runResult.exitCode !== 0) {
  fail(
    `probe exited ${runResult.exitCode}: ${runResult.stderr.toString().trim() || runResult.stdout.toString().trim()}`,
  );
} else {
  let parsed: unknown;
  try {
    parsed = JSON.parse(runResult.stdout.toString());
  } catch {
    fail(`probe output is not valid JSON: ${runResult.stdout.toString().trim()}`);
    parsed = null;
  }

  if (parsed && typeof parsed === "object" && (parsed as Record<string, unknown>).ok === true) {
    pass("probe resolved playwright and returned {ok:true}");
  } else {
    fail(`unexpected probe output: ${runResult.stdout.toString().trim()}`);
  }
}

// ── Clean up probe binary ───────────────────────────────────────────────────

try {
  rmSync(PROBE_OUT);
} catch {
  // non-fatal
}

// ── Summary ─────────────────────────────────────────────────────────────────

console.error("");
if (failed) {
  console.error("FAIL: playwright resolver binary smoke test failed.");
  process.exit(1);
} else {
  console.error("PASS: playwright resolver works correctly from compiled binary.");
}
