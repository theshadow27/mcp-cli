import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pollUntil } from "../../../test/harness";
import type { Manifest } from "./manifest";
import {
  DisallowedTransitionError,
  RegressionError,
  TransitionLockBusyError,
  UnknownPhaseError,
  appendAttempt,
  appendTransitionLog,
  commitTransition,
  historyTargets,
  isCommitted,
  levenshtein,
  pruneStaleHistory,
  readAllTransitions,
  readTransitionHistory,
  suggestPhases,
  transitionDbPath,
  validateTransition,
  withTransitionWriter,
} from "./phase-transition";

/** Short deadline for the deliberately-contended nested-lock test. */
const NESTED_LOCK_TIMEOUT_MS = 50;

/** Helper process that holds a read or write lock so contention is observable. */
const holdWorkerPath = join(import.meta.dir, "phase-lock-hold-worker.ts");

const manifest: Manifest = {
  version: 1,
  initial: "impl",
  phases: {
    impl: { source: "./impl.ts", next: ["adversarial-review", "qa", "needs-attention"] },
    "adversarial-review": { source: "./review.ts", next: ["repair", "qa"] },
    repair: { source: "./repair.ts", next: ["adversarial-review", "qa"] },
    qa: { source: "./qa.ts", next: ["done", "needs-attention"] },
    "needs-attention": { source: "./na.ts", next: ["impl", "done"] },
    done: { source: "./done.ts", next: [] },
  },
};

describe("levenshtein", () => {
  test("basic distances", () => {
    expect(levenshtein("", "abc")).toBe(3);
    expect(levenshtein("abc", "")).toBe(3);
    expect(levenshtein("abc", "abc")).toBe(0);
    expect(levenshtein("qaa", "qa")).toBe(1);
    expect(levenshtein("kitten", "sitting")).toBe(3);
  });
});

describe("suggestPhases", () => {
  test("suggests near-miss names", () => {
    const out = suggestPhases("qaa", ["qa", "adversarial-review", "repair", "impl"]);
    expect(out[0]).toBe("qa");
    expect(out.length).toBeLessThanOrEqual(3);
  });

  test("caps at 3", () => {
    const out = suggestPhases("aaaa", ["aaa", "aaab", "aaac", "aaad", "aaae"]);
    expect(out.length).toBe(3);
  });

  test("returns empty when nothing is close", () => {
    expect(suggestPhases("banana", ["implementation"])).toEqual([]);
  });
});

describe("validateTransition — unknown phase", () => {
  test("throws UnknownPhaseError with suggestions", () => {
    try {
      validateTransition({ manifest, from: "impl", target: "qaa" });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(UnknownPhaseError);
      const e = err as UnknownPhaseError;
      expect(e.target).toBe("qaa");
      expect(e.suggestions).toContain("qa");
      expect(e.message).toContain('unknown phase "qaa"');
      expect(e.message).toContain("did you mean");
    }
  });

  test("--force does NOT bypass unknown phase", () => {
    expect(() => validateTransition({ manifest, from: "impl", target: "qaa", force: { message: "trust me" } })).toThrow(
      UnknownPhaseError,
    );
  });

  test("throws when --from is unknown too", () => {
    expect(() => validateTransition({ manifest, from: "bogus", target: "qa" })).toThrow(UnknownPhaseError);
  });

  test("--force bypasses unknown-from (recovery from renamed manifest phase)", () => {
    // A manifest rename mid-sprint leaves in-flight work items referencing a stale phase.
    // --force must allow recovery; unknown-target stays fatal.
    const result = validateTransition({
      manifest,
      from: "old-phase-name",
      target: "qa",
      force: { message: "manifest renamed mid-sprint" },
    });
    expect(result.forced).toBe(true);
  });
});

describe("validateTransition — initial phase enforcement", () => {
  test("first transition must target manifest.initial", () => {
    expect(() => validateTransition({ manifest, from: null, target: "done" })).toThrow(DisallowedTransitionError);
  });

  test("first transition to manifest.initial is allowed", () => {
    const result = validateTransition({ manifest, from: null, target: "impl" });
    expect(result).toEqual({ from: null, target: "impl", forced: false });
  });

  test("--force bypasses initial phase check", () => {
    const result = validateTransition({ manifest, from: null, target: "done", force: { message: "intentional skip" } });
    expect(result.forced).toBe(true);
  });

  test("initial enforcement is skipped once history is non-empty (from is inferred by caller)", () => {
    // history non-empty means the work item is in progress; from is resolved before this call.
    const result = validateTransition({ manifest, from: "impl", target: "qa", history: ["impl"] });
    expect(result.forced).toBe(false);
  });
});

describe("validateTransition — disallowed", () => {
  test("throws when target not in phases[from].next", () => {
    try {
      validateTransition({ manifest, from: "impl", target: "repair" });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(DisallowedTransitionError);
      const e = err as DisallowedTransitionError;
      expect(e.from).toBe("impl");
      expect(e.target).toBe("repair");
      expect(e.allowed).toEqual(["adversarial-review", "qa", "needs-attention"]);
      expect(e.message).toContain("is not an approved transition");
      expect(e.message).toContain('approved from "impl"');
    }
  });

  test("allows valid transition", () => {
    const result = validateTransition({ manifest, from: "impl", target: "qa" });
    expect(result).toEqual({ from: "impl", target: "qa", forced: false });
  });

  test("--force bypasses disallowed transition", () => {
    const result = validateTransition({
      manifest,
      from: "impl",
      target: "repair",
      force: { message: "escape hatch" },
    });
    expect(result.forced).toBe(true);
  });
});

describe("validateTransition — regression", () => {
  test("throws when target is in history and not a declared back-edge", () => {
    // qa.next = [done, needs-attention] — impl is NOT a declared edge from qa.
    // impl is in history → RegressionError, not DisallowedTransitionError.
    try {
      validateTransition({
        manifest,
        from: "qa",
        target: "impl",
        history: ["impl", "adversarial-review", "qa"],
        workItemId: "#1241",
      });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(RegressionError);
      const e = err as RegressionError;
      expect(e.message).toContain("would regress the flow");
      expect(e.message).toContain("#1241");
      expect(e.message).toContain("impl → adversarial-review → qa");
    }
  });

  test("--force bypasses regression with message", () => {
    const result = validateTransition({
      manifest,
      from: "qa",
      target: "impl",
      history: ["impl", "adversarial-review", "qa"],
      force: { message: "rewriting from scratch" },
    });
    expect(result.forced).toBe(true);
  });

  test("no regression when no history", () => {
    const result = validateTransition({ manifest, from: "impl", target: "qa" });
    expect(result.forced).toBe(false);
  });

  test("declared back-edge (graph cycle) does NOT throw regression", () => {
    // repair.next includes adversarial-review — this is a declared cycle.
    // Traversing a declared edge never requires --force, even if the target
    // was visited before. RegressionError is reserved for undeclared revisits.
    const result = validateTransition({
      manifest,
      from: "repair",
      target: "adversarial-review",
      history: ["impl", "adversarial-review", "repair"],
    });
    expect(result.forced).toBe(false);
  });

  test("undeclared revisit (not in from.next) throws RegressionError", () => {
    // qa.next = [done, needs-attention] — impl is not reachable from qa, and was visited.
    expect(() =>
      validateTransition({
        manifest,
        from: "qa",
        target: "impl",
        history: ["impl", "adversarial-review", "qa"],
      }),
    ).toThrow(RegressionError);
  });
});

describe("transition log I/O", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mcx-phase-log-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("read on missing log returns empty without creating a database", () => {
    expect(readTransitionHistory(join(dir, "nope.jsonl"), "#1")).toEqual([]);
    // A read must not materialise storage as a side effect.
    expect(readdirSync(dir)).toEqual([]);
  });

  test("append then read", () => {
    const log = join(dir, "nested", "transitions.jsonl");
    appendTransitionLog(log, { ts: "2026-01-01T00:00:00Z", workItemId: "#1", from: null, to: "impl" });
    appendTransitionLog(log, { ts: "2026-01-01T00:01:00Z", workItemId: "#1", from: "impl", to: "qa" });
    appendTransitionLog(log, { ts: "2026-01-01T00:02:00Z", workItemId: "#2", from: null, to: "impl" });

    const entries = readTransitionHistory(log, "#1");
    expect(entries.length).toBe(2);
    expect(historyTargets(entries)).toEqual(["impl", "qa"]);
  });

  test("append creates the database beside the log path", () => {
    const log = join(dir, "transitions.jsonl");
    appendTransitionLog(log, { ts: "t1", workItemId: "#1", from: null, to: "impl" });
    expect(transitionDbPath(log)).toBe(join(dir, "transitions.db"));
    // No jsonl is written any more, and the rollback journal is gone post-commit.
    expect(readdirSync(dir)).toEqual(["transitions.db"]);
  });

  test("filters by workItemId, including the null work item", () => {
    const log = join(dir, "transitions.jsonl");
    appendTransitionLog(log, { ts: "t1", workItemId: null, from: null, to: "impl" });
    appendTransitionLog(log, { ts: "t2", workItemId: "#99", from: null, to: "qa" });
    expect(readTransitionHistory(log, null).length).toBe(1);
    expect(readTransitionHistory(log, null)[0].to).toBe("impl");
    expect(readTransitionHistory(log, "#99").length).toBe(1);
    expect(readTransitionHistory(log, "#99")[0].to).toBe("qa");
  });

  test("readAllTransitions returns every entry in insertion order", () => {
    const log = join(dir, "transitions.jsonl");
    appendTransitionLog(log, { ts: "t1", workItemId: "#1", from: null, to: "impl" });
    appendTransitionLog(log, { ts: "t2", workItemId: "#2", from: null, to: "impl" });
    appendTransitionLog(log, { ts: "t3", workItemId: null, from: "impl", to: "qa" });
    const all = readAllTransitions(log);
    expect(all.length).toBe(3);
    expect(all.map((e) => e.ts)).toEqual(["t1", "t2", "t3"]);
  });

  test("readAllTransitions on missing log returns empty", () => {
    expect(readAllTransitions(join(dir, "nope.jsonl"))).toEqual([]);
  });

  test("records force message and status", () => {
    const log = join(dir, "transitions.jsonl");
    appendTransitionLog(log, {
      ts: "t1",
      workItemId: "#1",
      from: "adversarial-review",
      to: "impl",
      forceMessage: "rewriting from scratch",
      status: "committed",
    });
    appendTransitionLog(log, { ts: "t2", workItemId: "#1", from: "impl", to: "qa", status: "attempted" });
    const entries = readTransitionHistory(log, "#1");
    expect(entries[0].forceMessage).toBe("rewriting from scratch");
    expect(entries[0].status).toBe("committed");
    expect(entries[1].status).toBe("attempted");
    // An entry written without a status stays status-less (legacy semantics).
    expect(entries[1].forceMessage).toBeUndefined();
    expect(isCommitted(entries[0])).toBe(true);
    expect(isCommitted(entries[1])).toBe(false);
  });
});

describe("bounded reads and filter pushdown (#1375)", () => {
  let dir: string;
  let log: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mcx-phase-tail-"));
    log = join(dir, "transitions.jsonl");
    for (let i = 0; i < 10; i++) {
      appendTransitionLog(log, {
        ts: `t${i}`,
        workItemId: i % 2 === 0 ? "#even" : "#odd",
        from: null,
        to: `step-${i}`,
        ...(i === 7 ? { forceMessage: "forced seven" } : {}),
      });
    }
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("tail returns the newest N entries, still oldest-first", () => {
    const tailed = readAllTransitions(log, { tail: 3 });
    expect(tailed.map((e) => e.to)).toEqual(["step-7", "step-8", "step-9"]);
  });

  test("tail larger than the table returns everything", () => {
    expect(readAllTransitions(log, { tail: 500 })).toHaveLength(10);
  });

  test("tail of zero or negative returns empty", () => {
    expect(readAllTransitions(log, { tail: 0 })).toEqual([]);
    expect(readAllTransitions(log, { tail: -5 })).toEqual([]);
  });

  test("omitting tail preserves the unbounded default", () => {
    expect(readAllTransitions(log)).toHaveLength(10);
  });

  test("workItemId filter is applied before the tail, not after", () => {
    // Filtering after a tail would yield fewer than 3 rows; pushdown yields 3.
    const tailed = readAllTransitions(log, { workItemId: "#odd", tail: 3 });
    expect(tailed.map((e) => e.to)).toEqual(["step-5", "step-7", "step-9"]);
  });

  test("null workItemId means no filter (matches filterTransitionLog semantics)", () => {
    expect(readAllTransitions(log, { workItemId: null })).toHaveLength(10);
  });

  test("forcedOnly filters to entries carrying a forceMessage", () => {
    const forced = readAllTransitions(log, { forcedOnly: true });
    expect(forced).toHaveLength(1);
    expect(forced[0].forceMessage).toBe("forced seven");
  });

  test("forcedOnly composes with workItemId", () => {
    expect(readAllTransitions(log, { forcedOnly: true, workItemId: "#odd" })).toHaveLength(1);
    expect(readAllTransitions(log, { forcedOnly: true, workItemId: "#even" })).toHaveLength(0);
  });

  test("readTransitionHistory accepts a tail", () => {
    const tailed = readTransitionHistory(log, "#even", undefined, { tail: 2 });
    expect(tailed.map((e) => e.to)).toEqual(["step-6", "step-8"]);
  });

  test("a non-integer tail is rejected rather than reaching SQL", () => {
    expect(() => readAllTransitions(log, { tail: Number.NaN })).toThrow(TypeError);
    expect(() => readAllTransitions(log, { tail: Number.POSITIVE_INFINITY })).toThrow(TypeError);
    expect(() => readAllTransitions(log, { tail: 2.5 })).toThrow(/tail must be an integer/);
  });
});

describe("journal mode (#1372)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mcx-phase-journal-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("the store runs on the rollback journal, never WAL", () => {
    // Load-bearing for #1372: WAL needs a `-shm` mmap that network filesystems
    // cannot provide, so an NFS-mounted `~/` would fail to open or corrupt.
    // Asserted on the file the store actually created, in its default
    // configuration — if anyone "optimizes" this to WAL, this test fails.
    const log = join(dir, "transitions.jsonl");
    appendTransitionLog(log, { ts: "t1", workItemId: "#1", from: null, to: "impl" });

    const db = new Database(transitionDbPath(log), { readonly: true });
    try {
      expect(db.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get()?.journal_mode).toBe("delete");
    } finally {
      db.close();
    }
    // A rollback-journal store leaves no sidecar files behind once committed.
    expect(readdirSync(dir)).toEqual(["transitions.db"]);
  });
});

describe("legacy jsonl migration (#1328)", () => {
  let dir: string;
  let log: string;

  const jsonlLine = (e: Record<string, unknown>) => `${JSON.stringify(e)}\n`;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mcx-phase-migrate-"));
    log = join(dir, "transitions.jsonl");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("imports an existing jsonl on first open, preserving order and fields", () => {
    writeFileSync(
      log,
      jsonlLine({ ts: "t1", workItemId: "#7", from: null, to: "impl", status: "committed" }) +
        jsonlLine({ ts: "t2", workItemId: "#7", from: "impl", to: "qa", status: "attempted" }) +
        jsonlLine({ ts: "t3", workItemId: "#8", from: null, to: "impl", forceMessage: "why not" }),
      "utf-8",
    );

    const all = readAllTransitions(log);
    expect(all).toHaveLength(3);
    expect(all.map((e) => e.ts)).toEqual(["t1", "t2", "t3"]);
    expect(all[0]).toEqual({ ts: "t1", workItemId: "#7", from: null, to: "impl", status: "committed" });
    expect(all[1].status).toBe("attempted");
    expect(all[2]).toEqual({ ts: "t3", workItemId: "#8", from: null, to: "impl", forceMessage: "why not" });
  });

  test("legacy entry without status round-trips as status-less, and still gates", () => {
    writeFileSync(log, jsonlLine({ ts: "t1", workItemId: "#7", from: null, to: "impl" }), "utf-8");
    const entries = readTransitionHistory(log, "#7");
    expect(entries[0].status).toBeUndefined();
    expect(isCommitted(entries[0])).toBe(true);
  });

  test("jsonl is parked as .migrated, never deleted", () => {
    writeFileSync(log, jsonlLine({ ts: "t1", workItemId: "#7", from: null, to: "impl" }), "utf-8");
    readAllTransitions(log);

    expect(existsSync(log)).toBe(false);
    expect(existsSync(`${log}.migrated`)).toBe(true);
    expect(readFileSync(`${log}.migrated`, "utf-8")).toContain('"to":"impl"');
    expect(readdirSync(dir).sort()).toEqual(["transitions.db", "transitions.jsonl.migrated"]);
  });

  test("a second migration does not overwrite an existing .migrated file", () => {
    writeFileSync(log, jsonlLine({ ts: "first", workItemId: "#7", from: null, to: "impl" }), "utf-8");
    readAllTransitions(log);
    // A stale binary writes a fresh jsonl after the first migration.
    writeFileSync(log, jsonlLine({ ts: "second", workItemId: "#7", from: "impl", to: "qa" }), "utf-8");
    readAllTransitions(log);

    expect(readFileSync(`${log}.migrated`, "utf-8")).toContain('"ts":"first"');
    const parked = readdirSync(dir).filter((n) => n.includes(".migrated"));
    expect(parked).toHaveLength(2);
    // Both generations of entries are in the store.
    expect(readAllTransitions(log).map((e) => e.ts)).toEqual(["first", "second"]);
  });

  test("rapid successive parks never clobber an older parked generation", () => {
    // Regression: the park name was `${log}.migrated.${Date.now()}`, so two
    // parks inside one millisecond computed the same name and renameSync
    // silently destroyed the older one. The parked jsonl is the artifact
    // recovery reads from when the DB is what went wrong, so every generation
    // must survive. 40 parks in a tight loop reliably collides on a ms clock.
    const generations = 40;
    for (let i = 0; i < generations; i++) {
      writeFileSync(log, jsonlLine({ ts: `gen${i}`, workItemId: "#7", from: null, to: "impl" }), "utf-8");
      readAllTransitions(log);
    }

    // Asserted over the whole directory, so a leftover staging file or an
    // unmigrated jsonl fails here too: one park per generation and nothing else.
    const files = readdirSync(dir).sort();
    expect(files).toHaveLength(generations + 1);
    expect(files[0]).toBe("transitions.db");
    const parked = files.slice(1);
    for (const name of parked) expect(name.startsWith("transitions.jsonl.migrated")).toBe(true);
    // Every generation is recoverable from its own parked file.
    const parkedContents = parked.map((n) => readFileSync(join(dir, n), "utf-8")).join("");
    for (let i = 0; i < generations; i++) {
      expect(parkedContents).toContain(`"ts":"gen${i}"`);
    }
    // The DB holds every generation too.
    expect(readAllTransitions(log)).toHaveLength(generations);
  });

  test("reopening does not re-import (no duplicate rows)", () => {
    writeFileSync(
      log,
      jsonlLine({ ts: "t1", workItemId: "#7", from: null, to: "impl" }) +
        jsonlLine({ ts: "t2", workItemId: "#7", from: "impl", to: "qa" }),
      "utf-8",
    );

    expect(readAllTransitions(log)).toHaveLength(2);
    expect(readAllTransitions(log)).toHaveLength(2);
    expect(readTransitionHistory(log, "#7")).toHaveLength(2);
  });

  test("entries appended after migration follow the imported history", () => {
    writeFileSync(log, jsonlLine({ ts: "t1", workItemId: "#7", from: null, to: "impl" }), "utf-8");
    appendTransitionLog(log, { ts: "t2", workItemId: "#7", from: "impl", to: "qa" });
    expect(historyTargets(readTransitionHistory(log, "#7"))).toEqual(["impl", "qa"]);
  });

  test("corrupt lines are reported with line numbers and good lines still import", () => {
    writeFileSync(
      log,
      `${jsonlLine({ ts: "t1", workItemId: "#1", from: null, to: "impl" })}not-json\n${jsonlLine({
        ts: "t2",
        workItemId: "#1",
        from: "impl",
        to: "qa",
      })}`,
      "utf-8",
    );

    const corrupt: Array<{ line: number; text: string }> = [];
    const entries = readTransitionHistory(log, "#1", (lineNumber, line) => {
      corrupt.push({ line: lineNumber, text: line });
    });

    expect(historyTargets(entries)).toEqual(["impl", "qa"]);
    expect(corrupt).toEqual([{ line: 2, text: "not-json" }]);
  });

  test("a truncated final line does not lose the preceding entries", () => {
    // The crash-mid-append case from #1328: last line is a partial JSON object.
    writeFileSync(
      log,
      `${jsonlLine({ ts: "t1", workItemId: "#1", from: null, to: "impl" })}{"ts":"t2","workItemId":"#1","fr`,
      "utf-8",
    );
    const corrupt: number[] = [];
    const entries = readTransitionHistory(log, "#1", (lineNumber) => corrupt.push(lineNumber));
    expect(historyTargets(entries)).toEqual(["impl"]);
    expect(corrupt).toEqual([2]);
  });

  test("an empty jsonl migrates to an empty store", () => {
    writeFileSync(log, "", "utf-8");
    expect(readAllTransitions(log)).toEqual([]);
    expect(existsSync(`${log}.migrated`)).toBe(true);
  });

  test("a staging file abandoned by a crashed import is recovered on next open", () => {
    // Simulates a crash after the atomic rename-claim but before COMMIT: the
    // data lives only in the staging file, and must not be stranded there.
    writeFileSync(
      join(dir, `transitions.jsonl.importing.${Date.now()}-abcd1234`),
      jsonlLine({ ts: "t1", workItemId: "#7", from: null, to: "impl" }),
      "utf-8",
    );

    expect(readAllTransitions(log).map((e) => e.ts)).toEqual(["t1"]);
    expect(readdirSync(dir).some((n) => n.includes(".importing."))).toBe(false);
  });

  test("concurrent first-open imports the jsonl exactly once", async () => {
    // Every worker races to migrate the same jsonl and then appends one entry.
    // A double import would inflate the count; a lost import would deflate it.
    const workerPath = join(import.meta.dir, "phase-lock-test-worker.ts");
    writeFileSync(
      log,
      jsonlLine({ ts: "seed-1", workItemId: "#race", from: null, to: "seed-a" }) +
        jsonlLine({ ts: "seed-2", workItemId: "#race", from: "seed-a", to: "seed-b" }),
      "utf-8",
    );

    const procs = Array.from({ length: 8 }, (_, i) =>
      Bun.spawn(["bun", "run", workerPath, log, String(i)], { stderr: "pipe" }),
    );
    const results = await Promise.all(
      procs.map(async (p) => ({ code: await p.exited, stderr: await new Response(p.stderr).text() })),
    );
    const failed = results.filter((r) => r.code !== 0);
    expect(failed.map((r) => r.stderr).join("\n")).toBe("");

    // The imported history must precede every concurrently-appended entry:
    // a worker that raced past a half-finished import would both reorder the
    // log and validate its own transition against an empty history.
    const entries = readTransitionHistory(log, "#race");
    expect(entries).toHaveLength(10);
    expect(entries.slice(0, 2).map((e) => e.ts)).toEqual(["seed-1", "seed-2"]);

    // Exactly one park, and no staging file left behind.
    expect(readdirSync(dir).sort()).toEqual(["transitions.db", "transitions.jsonl.migrated"]);
  }, 30_000);
});

describe("commitTransition / withTransitionWriter (issue #1328)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mcx-phase-commit-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("commitTransition appends and infers from from history tail", () => {
    const log = join(dir, "transitions.jsonl");
    const r1 = commitTransition(log, { manifest, from: null, target: "impl", workItemId: "#1" });
    expect(r1.from).toBeNull();
    expect(r1.target).toBe("impl");

    const r2 = commitTransition(log, { manifest, from: null, target: "qa", workItemId: "#1" });
    expect(r2.from).toBe("impl");
    expect(r2.target).toBe("qa");

    expect(historyTargets(readTransitionHistory(log, "#1"))).toEqual(["impl", "qa"]);
  });

  test("commitTransition surfaces validation errors without appending", () => {
    const log = join(dir, "transitions.jsonl");
    commitTransition(log, { manifest, from: null, target: "impl", workItemId: "#1" });
    expect(() => commitTransition(log, { manifest, from: null, target: "done", workItemId: "#1" })).toThrow(
      DisallowedTransitionError,
    );
    // The failed transaction must roll back, leaving no partial append.
    expect(historyTargets(readTransitionHistory(log, "#1"))).toEqual(["impl"]);
  });

  test("commitTransition ignores attempted entries when inferring from", () => {
    const log = join(dir, "transitions.jsonl");
    commitTransition(log, { manifest, from: null, target: "impl", workItemId: "#1" });
    appendAttempt(log, { workItemId: "#1", from: "impl", target: "needs-attention" });
    // The attempt must not become the inferred `from`.
    const r = commitTransition(log, { manifest, from: null, target: "qa", workItemId: "#1" });
    expect(r.from).toBe("impl");
  });

  test("commitTransition records the force message", () => {
    const log = join(dir, "transitions.jsonl");
    const r = commitTransition(log, {
      manifest,
      from: null,
      target: "done",
      workItemId: "#1",
      force: { message: "skipping ahead" },
    });
    expect(r.forced).toBe(true);
    expect(readTransitionHistory(log, "#1")[0].forceMessage).toBe("skipping ahead");
  });

  test("concurrent writers are serialised; no history is lost or torn", async () => {
    const log = join(dir, "transitions.jsonl");
    const workerPath = join(import.meta.dir, "phase-lock-test-worker.ts");

    // Spawn 10 concurrent child processes. Each independently reads the tail
    // and appends inside one write transaction. This is actual OS-level
    // concurrency — Promise.all of synchronous calls cannot stress it, since
    // JS is single-threaded.
    //
    // Without serialisation, concurrent reads produce stale history snapshots:
    // multiple writers see the same tail and append conflicting `from` values.
    const procs = Array.from({ length: 10 }, (_, i) => Bun.spawn(["bun", "run", workerPath, log, String(i)]));
    const exitCodes = await Promise.all(procs.map((p) => p.exited));
    expect(exitCodes.every((c) => c === 0)).toBe(true);

    const entries = readTransitionHistory(log, "#race");
    expect(entries.length).toBe(10);
    // Every entry's `from` must equal the previous entry's `to` — the
    // invariant broken by an unserialised read/append race.
    for (let i = 0; i < entries.length; i++) {
      if (i === 0) {
        expect(entries[i].from).toBeNull();
      } else {
        expect(entries[i].from).toBe(entries[i - 1].to);
      }
    }
    // Every `to` is unique — no double-write.
    const tos = entries.map((e) => e.to);
    expect(new Set(tos).size).toBe(tos.length);
  }, 30_000);

  test("withTransitionWriter rejects async fn to prevent an early commit", () => {
    const log = join(dir, "transitions.jsonl");
    expect(() => withTransitionWriter(log, () => Promise.resolve() as unknown as undefined)).toThrow(
      /withTransitionWriter: fn must be synchronous/,
    );
  });

  test("withTransitionWriter rolls back when fn throws", () => {
    const log = join(dir, "transitions.jsonl");
    appendTransitionLog(log, { ts: "t1", workItemId: "#1", from: null, to: "impl" });

    expect(() =>
      withTransitionWriter(log, (writer) => {
        writer.insert({ ts: "t2", workItemId: "#1", from: "impl", to: "qa" });
        throw new Error("handler blew up");
      }),
    ).toThrow("handler blew up");

    expect(historyTargets(readTransitionHistory(log, "#1"))).toEqual(["impl"]);
  });

  test("writer.history sees uncommitted inserts from the same transaction", () => {
    const log = join(dir, "transitions.jsonl");
    withTransitionWriter(log, (writer) => {
      writer.insert({ ts: "t1", workItemId: "#1", from: null, to: "impl" });
      expect(historyTargets(writer.history("#1"))).toEqual(["impl"]);
    });
    expect(historyTargets(readTransitionHistory(log, "#1"))).toEqual(["impl"]);
  });

  test("a contended writer waits for the lock and still commits", async () => {
    // The 10-way fan-out above proves the transaction boundary matters, but its
    // transactions are sub-millisecond, so it never shows a contended writer
    // *waiting*. Here a child process holds the write lock for HOLD_MS while
    // this writer, given a generous timeout, must block at BEGIN IMMEDIATE and
    // then succeed rather than raising TransitionLockBusyError.
    const HOLD_MS = 400;
    const log = join(dir, "transitions.jsonl");
    const ready = join(dir, "held");
    const child = Bun.spawn(["bun", "run", holdWorkerPath, "write", log, ready, String(HOLD_MS)]);

    await pollUntil(() => existsSync(ready));
    const startedAt = Date.now();
    appendTransitionLog(log, { ts: "contender", workItemId: "#hold", from: "impl", to: "qa" }, { timeoutMs: 30_000 });
    const waitedMs = Date.now() - startedAt;

    expect(await child.exited).toBe(0);
    // Blocked for a meaningful fraction of the hold rather than erroring out.
    expect(waitedMs).toBeGreaterThan(HOLD_MS / 4);
    // Both writes are present, in lock order.
    expect(historyTargets(readTransitionHistory(log, "#hold"))).toEqual(["impl", "qa"]);
  });

  test("a busy COMMIT retries instead of discarding the validated entry", async () => {
    // A reader holding SHARED across the commit point blocks COMMIT's
    // RESERVED -> EXCLUSIVE upgrade, so COMMIT itself returns SQLITE_BUSY and
    // SQLite leaves the transaction ACTIVE. Rolling back there threw away an
    // already-validated entry and misreported it as another run's contention.
    //
    // The reader has to arrive *after* BEGIN IMMEDIATE — a reader already
    // holding SHARED beforehand blocks the schema bootstrap instead, which is
    // the separate case covered by the next test. Hence the spawn-and-wait
    // inside `fn`, polled synchronously because `fn` must not return a Promise.
    // HOLD_MS > timeoutMs makes the first COMMIT attempt fail; HOLD_MS is well
    // inside the retry budget (3 attempts x timeoutMs) so a retry succeeds.
    const COMMIT_TIMEOUT_MS = 400;
    const HOLD_MS = 600;
    const log = join(dir, "transitions.jsonl");
    const ready = join(dir, "reader-held");
    // Materialise the store so the reader has a db file to open.
    appendTransitionLog(log, { ts: "t0", workItemId: "#busy", from: null, to: "impl" });

    let child: ReturnType<typeof Bun.spawn> | undefined;
    withTransitionWriter(
      log,
      (writer) => {
        writer.insert({ ts: "t1", workItemId: "#busy", from: "impl", to: "qa" });
        child = Bun.spawn(["bun", "run", holdWorkerPath, "read", log, ready, String(HOLD_MS)]);
        const deadline = Date.now() + 10_000;
        while (!existsSync(ready) && Date.now() < deadline) Bun.sleepSync(5);
        expect(existsSync(ready)).toBe(true);
      },
      { timeoutMs: COMMIT_TIMEOUT_MS },
    );

    expect(await child?.exited).toBe(0);
    // The entry survived the busy COMMIT rather than being silently dropped.
    expect(historyTargets(readTransitionHistory(log, "#busy"))).toEqual(["impl", "qa"]);
  });

  test("a reader blocking the schema bootstrap surfaces as lock contention", async () => {
    // `openForWrite` -> `applySchema` writes before BEGIN IMMEDIATE, so a reader
    // holding SHARED makes it fail. That happens outside the transaction, and
    // used to escape as a raw unclassified SQLiteError instead of the typed
    // error every caller of this store knows how to interpret.
    const HOLD_MS = 400;
    const log = join(dir, "transitions.jsonl");
    const ready = join(dir, "bootstrap-reader-held");
    appendTransitionLog(log, { ts: "t0", workItemId: "#boot", from: null, to: "impl" });

    const child = Bun.spawn(["bun", "run", holdWorkerPath, "read", log, ready, String(HOLD_MS)]);
    await pollUntil(() => existsSync(ready));

    expect(() =>
      appendTransitionLog(
        log,
        { ts: "t1", workItemId: "#boot", from: "impl", to: "qa" },
        { timeoutMs: NESTED_LOCK_TIMEOUT_MS },
      ),
    ).toThrow(TransitionLockBusyError);

    expect(await child.exited).toBe(0);
  });

  test("a rollback-journal locking failure is classified as lock contention", () => {
    // SQLITE_PROTOCOL is the rollback journal's locking-protocol failure — the
    // flaky shared-mount case the NOT-WAL decision exists to serve — so it must
    // surface as the typed retryable error, not a raw SQLiteError. (The WAL-only
    // SQLITE_BUSY_SNAPSHOT it replaced was unreachable in this journal mode.)
    const log = join(dir, "transitions.jsonl");
    expect(() =>
      withTransitionWriter(log, () => {
        throw Object.assign(new Error("locking protocol"), { code: "SQLITE_PROTOCOL" });
      }),
    ).toThrow(TransitionLockBusyError);
  });

  test("a held write lock surfaces TransitionLockBusyError, not a silent skip", () => {
    const log = join(dir, "transitions.jsonl");
    expect(() =>
      withTransitionWriter(log, () => {
        // Nested call is a second connection contending for the same write
        // lock; with a short timeout it must fail loudly.
        withTransitionWriter(log, () => undefined, { timeoutMs: NESTED_LOCK_TIMEOUT_MS });
      }),
    ).toThrow(TransitionLockBusyError);
  });
});

describe("pruneStaleHistory (#2463)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "prune-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("removes entries for the work item older than cutoff, preserves others", () => {
    const log = join(dir, "transitions.jsonl");
    appendTransitionLog(log, {
      ts: "2026-05-01T00:00:00Z",
      workItemId: "#42",
      from: null,
      to: "impl",
      status: "committed",
    });
    appendTransitionLog(log, {
      ts: "2026-05-01T01:00:00Z",
      workItemId: "#42",
      from: "impl",
      to: "triage",
      status: "committed",
    });
    appendTransitionLog(log, {
      ts: "2026-05-01T00:30:00Z",
      workItemId: "#99",
      from: null,
      to: "impl",
      status: "committed",
    });
    appendTransitionLog(log, {
      ts: "2026-06-01T00:00:00Z",
      workItemId: "#42",
      from: null,
      to: "impl",
      status: "committed",
    });

    const cutoff = new Date("2026-05-27T14:49:10Z");
    const pruned = pruneStaleHistory(log, "#42", cutoff);

    expect(pruned).toBe(2);
    const remaining = readAllTransitions(log);
    expect(remaining).toHaveLength(2);
    expect(remaining[0].workItemId).toBe("#99");
    expect(remaining[1].workItemId).toBe("#42");
    expect(remaining[1].ts).toBe("2026-06-01T00:00:00Z");
  });

  test("returns 0 and changes nothing when no entries match", () => {
    const log = join(dir, "transitions.jsonl");
    appendTransitionLog(log, {
      ts: "2026-06-01T00:00:00Z",
      workItemId: "#42",
      from: null,
      to: "impl",
      status: "committed",
    });

    const cutoff = new Date("2026-05-01T00:00:00Z");
    const pruned = pruneStaleHistory(log, "#42", cutoff);

    expect(pruned).toBe(0);
    expect(readAllTransitions(log)).toHaveLength(1);
  });

  test("returns 0 when no log exists", () => {
    const log = join(dir, "nonexistent", "transitions.jsonl");
    const pruned = pruneStaleHistory(log, "#42", new Date());
    expect(pruned).toBe(0);
  });

  test("returns 0 when the store is empty", () => {
    const log = join(dir, "transitions.jsonl");
    writeFileSync(log, "", "utf-8");

    const pruned = pruneStaleHistory(log, "#42", new Date());
    expect(pruned).toBe(0);
  });

  test("removes all stale entries when every entry for the item is stale", () => {
    const log = join(dir, "transitions.jsonl");
    appendTransitionLog(log, {
      ts: "2026-01-01T00:00:00Z",
      workItemId: "#10",
      from: null,
      to: "impl",
      status: "committed",
    });
    appendTransitionLog(log, {
      ts: "2026-01-02T00:00:00Z",
      workItemId: "#10",
      from: "impl",
      to: "triage",
      status: "committed",
    });

    const pruned = pruneStaleHistory(log, "#10", new Date("2026-06-01T00:00:00Z"));
    expect(pruned).toBe(2);
    expect(readAllTransitions(log)).toHaveLength(0);
  });

  test("prunes attempted entries too, and only for the named work item", () => {
    const log = join(dir, "transitions.jsonl");
    appendTransitionLog(log, {
      ts: "2026-01-01T00:00:00Z",
      workItemId: "#50",
      from: null,
      to: "impl",
      status: "attempted",
    });
    appendTransitionLog(log, {
      ts: "2026-01-01T00:00:00Z",
      workItemId: "#42",
      from: null,
      to: "impl",
      status: "attempted",
    });

    const pruned = pruneStaleHistory(log, "#42", new Date("2026-06-01T00:00:00Z"));
    expect(pruned).toBe(1);
    const remaining = readAllTransitions(log);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].workItemId).toBe("#50");
  });

  test("keeps entries whose ts is unparseable rather than pruning them", () => {
    // `ts` is caller-supplied; an unparseable value must not be silently
    // treated as "infinitely old" and deleted.
    const log = join(dir, "transitions.jsonl");
    appendTransitionLog(log, { ts: "not-a-date", workItemId: "#42", from: null, to: "impl", status: "committed" });

    const pruned = pruneStaleHistory(log, "#42", new Date("2026-06-01T00:00:00Z"));
    expect(pruned).toBe(0);
    expect(readAllTransitions(log)).toHaveLength(1);
  });

  test("prune leaves no journal or temp files behind (#2685)", () => {
    const log = join(dir, "transitions.jsonl");
    appendTransitionLog(log, {
      ts: "2026-01-01T00:00:00Z",
      workItemId: "#42",
      from: null,
      to: "impl",
      status: "committed",
    });

    const pruned = pruneStaleHistory(log, "#42", new Date("2026-06-01T00:00:00Z"));
    expect(pruned).toBe(1);
    expect(readdirSync(dir).sort()).toEqual(["transitions.db"]);
  });
});
