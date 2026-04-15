#!/usr/bin/env bun
/**
 * CI guard: the `sub === "run"` block in phase.ts must call assertNoDrift
 * (or detectDrift) before dispatching. Prevents future refactors from
 * silently dropping the drift check.
 *
 * Exit codes:
 *   0 — drift guard found in the run block
 *   1 — drift guard missing or run block not found
 */

const PHASE_PATH = new URL("../packages/command/src/commands/phase.ts", import.meta.url).pathname;

const RUN_BLOCK_START = /if\s*\(\s*sub\s*===\s*["']run["']\s*\)/;
const DRIFT_CALL = /\b(assertNoDrift|detectDrift)\s*\(/;

export function check(source: string): { ok: boolean; reason: string } {
  const lines = source.split("\n");

  let runBlockLine = -1;
  for (let i = 0; i < lines.length; i++) {
    if (RUN_BLOCK_START.test(lines[i])) {
      runBlockLine = i;
      break;
    }
  }

  if (runBlockLine === -1) {
    return { ok: false, reason: 'Could not find `sub === "run"` block in phase.ts' };
  }

  let depth = 0;
  let entered = false;
  for (let i = runBlockLine; i < lines.length; i++) {
    const line = lines[i];

    if (DRIFT_CALL.test(line)) {
      return { ok: true, reason: `assertNoDrift/detectDrift found at line ${i + 1}` };
    }

    for (const ch of line) {
      if (ch === "{") {
        depth++;
        entered = true;
      } else if (ch === "}") {
        depth--;
      }
    }

    if (entered && depth === 0) break;
  }

  return {
    ok: false,
    reason: `The "run" block (line ${runBlockLine + 1}) does not call assertNoDrift or detectDrift`,
  };
}

async function main(): Promise<void> {
  const file = Bun.file(PHASE_PATH);
  if (!(await file.exists())) {
    process.stderr.write(`phase.ts not found at ${PHASE_PATH}\n`);
    process.exit(1);
  }

  const source = await file.text();
  const result = check(source);

  if (result.ok) {
    process.stderr.write(`Phase drift guard OK: ${result.reason}\n`);
    process.exit(0);
  }

  process.stderr.write("\n  Phase drift guard FAILED\n\n");
  process.stderr.write(`  ${result.reason}\n\n`);
  process.stderr.write('  The "run" subcommand in phase.ts must call assertNoDrift()\n');
  process.stderr.write("  before dispatching to prevent silent execution on stale lockfiles.\n\n");
  process.exit(1);
}

if (import.meta.main) main();
