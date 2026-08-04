/**
 * Test helper: used by phase-transition.spec.ts to exercise
 * `withTransitionWriter` under actual OS-level concurrency (subprocess
 * fan-out). Not part of the production build — import path stays local to the
 * core package.
 *
 * Reads the history and appends a chained entry inside one transaction, which
 * is the same read-modify-write shape `commitTransition` uses. Without
 * serialisation, concurrent workers observe the same tail and produce a broken
 * `from`/`to` chain (#1328).
 *
 * Usage: bun run phase-lock-test-worker.ts <logPath> <index>
 */
import { withTransitionWriter } from "./phase-transition";

const [logPath, index] = process.argv.slice(2);
if (!logPath || index === undefined) {
  process.stderr.write("usage: phase-lock-test-worker.ts <logPath> <index>\n");
  process.exit(1);
}

withTransitionWriter(logPath, (writer) => {
  const hist = writer.history("#race");
  writer.insert({
    ts: `t${index}`,
    workItemId: "#race",
    from: hist.length === 0 ? null : hist[hist.length - 1].to,
    to: `step-${index}`,
  });
});
