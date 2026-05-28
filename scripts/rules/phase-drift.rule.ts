/**
 * Rule: phase-drift
 *
 * The `if (sub === "run")` block in `packages/command/src/commands/phase.ts`
 * must call `assertNoDrift` (or `detectDrift`) before dispatching. Prevents
 * future refactors from silently dropping the drift check that gates
 * `mcx phase run` against stale `.mcx.lock` files.
 *
 * Two violation shapes:
 *   1. The `sub === "run"` block exists but does not call assertNoDrift /
 *      detectDrift anywhere inside it.
 *   2. The block is missing entirely (suggests a refactor renamed `sub` or
 *      restructured dispatch).
 *
 * File-scoped via a fast-path early return — other files are skipped
 * without any work.
 *
 * Migrated from the standalone `scripts/check-phase-drift.ts`.
 */

import type { CheckRule } from "./_engine/rule";

const PHASE_REL = "packages/command/src/commands/phase.ts";
const RUN_BLOCK_START = /if\s*\(\s*sub\s*===\s*["']run["']\s*\)/;
const DRIFT_CALL = /\b(assertNoDrift|detectDrift|autoInstallOnDrift)\s*\(/;

const rule: CheckRule = {
  id: "phase-drift",
  kind: "check",
  scold: 'phase.ts `sub === "run"` block must call assertNoDrift / autoInstallOnDrift / detectDrift before dispatching',
  guidance: [
    "the run-block guards `mcx phase run` against stale .mcx.lock — silently skipping it ships drift",
    "use `await autoInstallOnDrift(cwd, d)` (auto-reinstalls on drift) or `assertNoDrift(d)` (aborts) inside the block",
    "if the block was intentionally renamed, update this rule's RUN_BLOCK_START regex in the same PR",
  ],
  documentation: "phase.ts run-block drift guard",
  check({ file, violated }) {
    if (file.relPath !== PHASE_REL) return;

    const lines = file.content.split("\n");

    let runBlockLine = -1;
    for (let i = 0; i < lines.length; i++) {
      if (RUN_BLOCK_START.test(lines[i] ?? "")) {
        runBlockLine = i;
        break;
      }
    }

    if (runBlockLine === -1) {
      violated(1, 1, `Could not find \`sub === "run"\` block in ${PHASE_REL}`);
      return;
    }

    let depth = 0;
    let entered = false;
    for (let i = runBlockLine; i < lines.length; i++) {
      const line = lines[i] ?? "";

      if (DRIFT_CALL.test(line)) return;

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

    violated(runBlockLine + 1, 1, `the "run" block does not call assertNoDrift or detectDrift`);
  },
};

export default rule;
