/**
 * Test helper: holds a lock on the transition store for a fixed duration so
 * phase-transition.spec.ts can observe a *contended* writer from the parent
 * process. The 10-way fan-out worker proves the transaction boundary matters,
 * but its transactions are sub-millisecond, so it never demonstrates that a
 * contended writer waits rather than erroring.
 *
 * Two modes, both signalling `<readyFile>` once the lock is actually held so the
 * parent can poll for readiness instead of sleeping:
 *
 * - `write`: holds the `BEGIN IMMEDIATE` write lock, so the parent's writer must
 *   wait for it at `BEGIN` and then succeed (`busy_timeout` doing its job).
 * - `read`: holds a SHARED read lock across the parent's commit point, which is
 *   what makes the parent's `COMMIT` — not its `BEGIN` — return SQLITE_BUSY.
 *
 * Usage: bun run phase-lock-hold-worker.ts <write|read> <logPath> <readyFile> <holdMs>
 */
import { Database } from "bun:sqlite";
import { writeFileSync } from "node:fs";
import { transitionDbPath, withTransitionWriter } from "./phase-transition";

const [mode, logPath, readyFile, holdMsRaw] = process.argv.slice(2);
if (!mode || !logPath || !readyFile || !holdMsRaw) {
  process.stderr.write("usage: phase-lock-hold-worker.ts <write|read> <logPath> <readyFile> <holdMs>\n");
  process.exit(1);
}
const holdMs = Number(holdMsRaw);

if (mode === "write") {
  withTransitionWriter(logPath, (writer) => {
    writer.insert({ ts: "held", workItemId: "#hold", from: null, to: "impl" });
    writeFileSync(readyFile, "held");
    Bun.sleepSync(holdMs);
  });
} else {
  const db = new Database(transitionDbPath(logPath), { readonly: true });
  try {
    db.exec("BEGIN");
    db.query("SELECT count(*) AS n FROM transitions").get();
    writeFileSync(readyFile, "held");
    Bun.sleepSync(holdMs);
    db.exec("ROLLBACK");
  } finally {
    db.close();
  }
}
