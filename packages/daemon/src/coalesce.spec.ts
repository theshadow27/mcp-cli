import { describe, expect, test } from "bun:test";
import { CoalescingPublisher } from "./coalesce";
import type { Clock } from "./coalesce";

class FakeClock implements Clock {
  private timers = new Map<number, { fn: () => void; fireAt: number }>();
  private _now = 0;
  private nextId = 0;

  setTimeout(fn: () => void, ms: number): Timer {
    const id = ++this.nextId;
    this.timers.set(id, { fn, fireAt: this._now + ms });
    return id as unknown as Timer;
  }

  clearTimeout(timer: Timer): void {
    this.timers.delete(timer as unknown as number);
  }

  advance(ms: number): void {
    this._now += ms;
    const due = Array.from(this.timers.entries())
      .filter(([, t]) => t.fireAt <= this._now)
      .sort(([, a], [, b]) => a.fireAt - b.fireAt);
    for (const [id] of due) {
      this.timers.delete(id);
    }
    for (const [, t] of due) {
      t.fn();
    }
  }
}

function collectEmissions<T>(): { emissions: T[]; emit: (e: T) => void } {
  const emissions: T[] = [];
  return { emissions, emit: (e: T) => emissions.push(e) };
}

describe("CoalescingPublisher", () => {
  describe("last-wins policy", () => {
    test("rapid submissions produce one emission after window", () => {
      const clock = new FakeClock();
      const { emissions, emit } = collectEmissions<string>();
      const pub = new CoalescingPublisher(emit, clock);

      pub.submit("k1", "a", { mode: "last-wins", windowMs: 50 });
      pub.submit("k1", "b", { mode: "last-wins", windowMs: 50 });
      pub.submit("k1", "c", { mode: "last-wins", windowMs: 50 });

      expect(emissions).toHaveLength(0);
      clock.advance(50);
      expect(emissions).toEqual(["c"]);
      pub.dispose();
    });

    test("different keys emit independently", () => {
      const clock = new FakeClock();
      const { emissions, emit } = collectEmissions<string>();
      const pub = new CoalescingPublisher(emit, clock);

      pub.submit("k1", "a", { mode: "last-wins", windowMs: 50 });
      pub.submit("k2", "b", { mode: "last-wins", windowMs: 50 });

      clock.advance(50);
      expect(emissions).toHaveLength(2);
      expect(emissions).toContain("a");
      expect(emissions).toContain("b");
      pub.dispose();
    });

    test("uses default 500ms window when windowMs omitted", () => {
      const clock = new FakeClock();
      const { emissions, emit } = collectEmissions<string>();
      const pub = new CoalescingPublisher(emit, clock);

      pub.submit("k1", "x", { mode: "last-wins" });
      expect(emissions).toHaveLength(0);
      clock.advance(499);
      expect(emissions).toHaveLength(0);
      clock.advance(1);
      expect(emissions).toEqual(["x"]);
      pub.dispose();
    });

    test("first submission's windowMs is authoritative for re-submissions", () => {
      const clock = new FakeClock();
      const { emissions, emit } = collectEmissions<string>();
      const pub = new CoalescingPublisher(emit, clock);

      pub.submit("k1", "a", { mode: "last-wins", windowMs: 100 });
      clock.advance(50);
      // Re-submit with a much larger window — should still use the original 100ms.
      pub.submit("k1", "b", { mode: "last-wins", windowMs: 5000 });
      clock.advance(100);
      expect(emissions).toEqual(["b"]);
      pub.dispose();
    });
  });

  describe("merge policy", () => {
    test("folds events in order and emits once at window close", () => {
      const clock = new FakeClock();
      const { emissions, emit } = collectEmissions<number>();
      const pub = new CoalescingPublisher(emit, clock);
      const merge = (a: number, b: number) => a + b;

      pub.submit("k1", 1, { mode: "merge", merge, windowMs: 50 });
      pub.submit("k1", 2, { mode: "merge", merge, windowMs: 50 });
      pub.submit("k1", 3, { mode: "merge", merge, windowMs: 50 });

      expect(emissions).toHaveLength(0);
      clock.advance(50);
      expect(emissions).toEqual([6]);
      pub.dispose();
    });

    test("merge with objects accumulates fields", () => {
      const clock = new FakeClock();
      interface Stats {
        count: number;
        lastStatus: string;
      }
      const { emissions, emit } = collectEmissions<Stats>();
      const pub = new CoalescingPublisher(emit, clock);

      const merge = (a: Stats, b: Stats): Stats => ({
        count: a.count + b.count,
        lastStatus: b.lastStatus,
      });

      pub.submit("k1", { count: 1, lastStatus: "pending" }, { mode: "merge", merge, windowMs: 50 });
      pub.submit("k1", { count: 1, lastStatus: "running" }, { mode: "merge", merge, windowMs: 50 });
      pub.submit("k1", { count: 1, lastStatus: "done" }, { mode: "merge", merge, windowMs: 50 });

      clock.advance(50);
      expect(emissions).toEqual([{ count: 3, lastStatus: "done" }]);
      pub.dispose();
    });

    test("merge throws removes the pending entry — no zombie", () => {
      const clock = new FakeClock();
      const { emissions, emit } = collectEmissions<number>();
      const pub = new CoalescingPublisher(emit, clock);

      pub.submit("k1", 1, { mode: "merge", merge: (a, b) => a + b, windowMs: 100 });
      expect(pub.pendingCount).toBe(1);

      const badMerge = (_a: number, _b: number): number => {
        throw new Error("merge failed");
      };
      expect(() => pub.submit("k1", 2, { mode: "merge", merge: badMerge, windowMs: 100 })).toThrow("merge failed");

      // Entry must be gone — no zombie with a dead timer.
      expect(pub.pendingCount).toBe(0);
      clock.advance(200);
      expect(emissions).toHaveLength(0);
      pub.dispose();
    });
  });

  describe("never policy", () => {
    test("emits immediately without windowing", () => {
      const clock = new FakeClock();
      const { emissions, emit } = collectEmissions<string>();
      const pub = new CoalescingPublisher(emit, clock);

      pub.submit("k1", "immediate", { mode: "never" });
      expect(emissions).toEqual(["immediate"]);
      pub.dispose();
    });

    test("flushes pending state for that key before emitting", () => {
      const clock = new FakeClock();
      const { emissions, emit } = collectEmissions<string>();
      const pub = new CoalescingPublisher(emit, clock);

      pub.submit("k1", "pending-val", { mode: "last-wins", windowMs: 200 });
      expect(emissions).toHaveLength(0);

      pub.submit("k1", "terminal", { mode: "never" });
      expect(emissions).toEqual(["pending-val", "terminal"]);
      expect(pub.pendingCount).toBe(0);
      pub.dispose();
    });

    test("does not affect other keys", () => {
      const clock = new FakeClock();
      const { emissions, emit } = collectEmissions<string>();
      const pub = new CoalescingPublisher(emit, clock);

      pub.submit("k1", "a", { mode: "last-wins", windowMs: 200 });
      pub.submit("k2", "b", { mode: "last-wins", windowMs: 200 });

      pub.submit("k1", "terminal", { mode: "never" });
      expect(emissions).toEqual(["a", "terminal"]);
      expect(pub.pendingCount).toBe(1);

      clock.advance(200);
      expect(emissions).toEqual(["a", "terminal", "b"]);
      pub.dispose();
    });
  });

  describe("flush", () => {
    test("flush(key) emits pending event for that key immediately", () => {
      const clock = new FakeClock();
      const { emissions, emit } = collectEmissions<string>();
      const pub = new CoalescingPublisher(emit, clock);

      pub.submit("k1", "val", { mode: "last-wins", windowMs: 5000 });
      expect(emissions).toHaveLength(0);

      pub.flush("k1");
      expect(emissions).toEqual(["val"]);
      expect(pub.pendingCount).toBe(0);
    });

    test("flush() with no key flushes all pending keys", () => {
      const clock = new FakeClock();
      const { emissions, emit } = collectEmissions<string>();
      const pub = new CoalescingPublisher(emit, clock);

      pub.submit("k1", "a", { mode: "last-wins", windowMs: 5000 });
      pub.submit("k2", "b", { mode: "last-wins", windowMs: 5000 });
      pub.submit("k3", "c", { mode: "last-wins", windowMs: 5000 });

      pub.flush();
      expect(emissions).toHaveLength(3);
      expect(pub.pendingCount).toBe(0);
    });

    test("flush(key) is a no-op for unknown keys", () => {
      const clock = new FakeClock();
      const { emissions, emit } = collectEmissions<string>();
      const pub = new CoalescingPublisher(emit, clock);

      pub.flush("nonexistent");
      expect(emissions).toHaveLength(0);
    });

    test("emit throws during flush propagates error and clears entry", () => {
      const clock = new FakeClock();
      const pub = new CoalescingPublisher<string>(() => {
        throw new Error("emit failed");
      }, clock);

      pub.submit("k1", "a", { mode: "last-wins", windowMs: 100 });
      expect(() => pub.flush("k1")).toThrow("emit failed");
      expect(pub.pendingCount).toBe(0);
      pub.dispose();
    });
  });

  describe("dispose", () => {
    test("clears all timers without emitting", () => {
      const clock = new FakeClock();
      const { emissions, emit } = collectEmissions<string>();
      const pub = new CoalescingPublisher(emit, clock);

      pub.submit("k1", "a", { mode: "last-wins", windowMs: 50 });
      pub.submit("k2", "b", { mode: "last-wins", windowMs: 50 });
      expect(pub.pendingCount).toBe(2);

      pub.dispose();
      expect(pub.pendingCount).toBe(0);

      clock.advance(80);
      expect(emissions).toHaveLength(0);
    });

    test("submit is a no-op after dispose", () => {
      const clock = new FakeClock();
      const { emissions, emit } = collectEmissions<string>();
      const pub = new CoalescingPublisher(emit, clock);

      pub.dispose();
      pub.submit("k1", "ignored", { mode: "last-wins", windowMs: 50 });
      pub.submit("k1", "also-ignored", { mode: "never" });
      expect(emissions).toHaveLength(0);
      expect(pub.pendingCount).toBe(0);
    });
  });
});
