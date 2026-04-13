/**
 * Test helper: used by phase-transition.spec.ts to exercise withTransitionLock
 * under actual OS-level concurrency (subprocess fan-out). Not part of the
 * production build — import path stays local to the core package.
 *
 * Usage: bun run phase-lock-test-worker.ts <logPath> <index>
 */
import { appendTransitionLog, readTransitionHistory, withTransitionLock } from "./phase-transition";

const [logPath, index] = process.argv.slice(2);
if (!logPath || index === undefined) {
  process.stderr.write("usage: phase-lock-test-worker.ts <logPath> <index>\n");
  process.exit(1);
}

withTransitionLock(logPath, () => {
  const hist = readTransitionHistory(logPath, "#race");
  appendTransitionLog(logPath, {
    ts: `t${index}`,
    workItemId: "#race",
    from: hist.length === 0 ? null : hist[hist.length - 1].to,
    to: `step-${index}`,
  });
});
