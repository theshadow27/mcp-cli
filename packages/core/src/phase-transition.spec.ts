import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Manifest } from "./manifest";
import {
  DisallowedTransitionError,
  RegressionError,
  UnknownPhaseError,
  appendTransitionLog,
  commitTransition,
  historyTargets,
  levenshtein,
  readTransitionHistory,
  suggestPhases,
  validateTransition,
  withTransitionLock,
} from "./phase-transition";

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

  test("read on missing file returns empty", () => {
    expect(readTransitionHistory(join(dir, "nope.jsonl"), "#1")).toEqual([]);
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

  test("filters by workItemId", () => {
    const log = join(dir, "transitions.jsonl");
    appendTransitionLog(log, { ts: "t1", workItemId: null, from: null, to: "impl" });
    appendTransitionLog(log, { ts: "t2", workItemId: "#99", from: null, to: "qa" });
    expect(readTransitionHistory(log, null).length).toBe(1);
    expect(readTransitionHistory(log, "#99").length).toBe(1);
  });

  test("skips malformed lines and reports them via onCorrupt", () => {
    const log = join(dir, "transitions.jsonl");
    appendTransitionLog(log, { ts: "t1", workItemId: "#1", from: null, to: "impl" });
    // Corrupt the file with a bad line
    require("node:fs").appendFileSync(log, "not-json\n", "utf-8");
    appendTransitionLog(log, { ts: "t2", workItemId: "#1", from: "impl", to: "qa" });
    const corrupt: Array<{ line: number; text: string }> = [];
    const entries = readTransitionHistory(log, "#1", (lineNumber, line) => {
      corrupt.push({ line: lineNumber, text: line });
    });
    expect(historyTargets(entries)).toEqual(["impl", "qa"]);
    expect(corrupt).toEqual([{ line: 2, text: "not-json" }]);
  });

  test("records force message", () => {
    const log = join(dir, "transitions.jsonl");
    appendTransitionLog(log, {
      ts: "t1",
      workItemId: "#1",
      from: "adversarial-review",
      to: "impl",
      forceMessage: "rewriting from scratch",
    });
    const entries = readTransitionHistory(log, "#1");
    expect(entries[0].forceMessage).toBe("rewriting from scratch");
  });
});

describe("commitTransition / withTransitionLock (issue #1328)", () => {
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
    // log must not have the bad append
    expect(historyTargets(readTransitionHistory(log, "#1"))).toEqual(["impl"]);
  });

  test("withTransitionLock serializes concurrent writers; no history is lost", async () => {
    const log = join(dir, "transitions.jsonl");
    const workerPath = join(import.meta.dir, "phase-lock-test-worker.ts");

    // Spawn 10 concurrent child processes. Each process independently
    // reads the tail and appends under withTransitionLock. This is actual
    // OS-level concurrency — Promise.all of synchronous fn() cannot stress
    // O_EXCL contention since JS is single-threaded.
    //
    // Without the lock, concurrent reads produce stale history snapshots:
    // multiple writers see the same tail and append conflicting `from` values.
    // With the lock, each writer commits before the next reads.
    const procs = Array.from({ length: 10 }, (_, i) => Bun.spawn(["bun", "run", workerPath, log, String(i)]));
    const exitCodes = await Promise.all(procs.map((p) => p.exited));
    expect(exitCodes.every((c) => c === 0)).toBe(true);

    const entries = readTransitionHistory(log, "#race");
    expect(entries.length).toBe(10);
    // Every entry's `from` must equal the previous entry's `to` — the
    // invariant broken by an unlocked read/append race.
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
  }, 20_000); // serialized under lock; 10 subprocess spawns worst-case ~10s

  test("withTransitionLock rejects async fn to prevent early lock release", () => {
    const log = join(dir, "transitions.jsonl");
    expect(() => withTransitionLock(log, () => Promise.resolve() as unknown as undefined)).toThrow(
      /withTransitionLock: fn must be synchronous/,
    );
  });

  test("withTransitionLock times out when lock is held", () => {
    const log = join(dir, "transitions.jsonl");
    expect(() =>
      withTransitionLock(
        log,
        () => {
          // Inner attempt with short timeout should fail — lock is held.
          withTransitionLock(log, () => undefined, { timeoutMs: 50 });
        },
        { timeoutMs: 1000 },
      ),
    ).toThrow(/could not acquire transition lock/);
  });

  test("withTransitionLock reaps stale lockfile", () => {
    const log = join(dir, "transitions.jsonl");
    const lockPath = `${log}.lock`;
    require("node:fs").mkdirSync(dir, { recursive: true });
    require("node:fs").writeFileSync(lockPath, "", "utf-8");
    // Backdate lock mtime to be "stale"
    const past = new Date(Date.now() - 60_000);
    require("node:fs").utimesSync(lockPath, past, past);

    let ran = false;
    withTransitionLock(
      log,
      () => {
        ran = true;
      },
      { staleMs: 1000, timeoutMs: 500 },
    );
    expect(ran).toBe(true);
  });
});
