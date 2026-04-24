import { describe, expect, test } from "bun:test";
import { CoalescingPublisher } from "./coalesce";

function collectEmissions<T>(): { emissions: T[]; emit: (e: T) => void } {
  const emissions: T[] = [];
  return { emissions, emit: (e: T) => emissions.push(e) };
}

describe("CoalescingPublisher", () => {
  describe("last-wins policy", () => {
    test("rapid submissions produce one emission after window", async () => {
      const { emissions, emit } = collectEmissions<string>();
      const pub = new CoalescingPublisher(emit);

      pub.submit("k1", "a", { mode: "last-wins", windowMs: 50 });
      pub.submit("k1", "b", { mode: "last-wins", windowMs: 50 });
      pub.submit("k1", "c", { mode: "last-wins", windowMs: 50 });

      expect(emissions).toHaveLength(0);
      await Bun.sleep(80);
      expect(emissions).toEqual(["c"]);
      pub.dispose();
    });

    test("different keys emit independently", async () => {
      const { emissions, emit } = collectEmissions<string>();
      const pub = new CoalescingPublisher(emit);

      pub.submit("k1", "a", { mode: "last-wins", windowMs: 50 });
      pub.submit("k2", "b", { mode: "last-wins", windowMs: 50 });

      await Bun.sleep(80);
      expect(emissions).toHaveLength(2);
      expect(emissions).toContain("a");
      expect(emissions).toContain("b");
      pub.dispose();
    });

    test("uses default 500ms window when windowMs omitted", () => {
      const { emissions, emit } = collectEmissions<string>();
      const pub = new CoalescingPublisher(emit);

      pub.submit("k1", "x", { mode: "last-wins" });
      expect(emissions).toHaveLength(0);
      expect(pub.pendingCount).toBe(1);
      pub.dispose();
    });
  });

  describe("merge policy", () => {
    test("folds events in order and emits once at window close", async () => {
      const { emissions, emit } = collectEmissions<number>();
      const pub = new CoalescingPublisher(emit);
      const merge = (a: number, b: number) => a + b;

      pub.submit("k1", 1, { mode: "merge", merge, windowMs: 50 });
      pub.submit("k1", 2, { mode: "merge", merge, windowMs: 50 });
      pub.submit("k1", 3, { mode: "merge", merge, windowMs: 50 });

      expect(emissions).toHaveLength(0);
      await Bun.sleep(80);
      expect(emissions).toEqual([6]);
      pub.dispose();
    });

    test("merge with objects accumulates fields", async () => {
      interface Stats {
        count: number;
        lastStatus: string;
      }
      const { emissions, emit } = collectEmissions<Stats>();
      const pub = new CoalescingPublisher(emit);

      const merge = (a: Stats, b: Stats): Stats => ({
        count: a.count + b.count,
        lastStatus: b.lastStatus,
      });

      pub.submit("k1", { count: 1, lastStatus: "pending" }, { mode: "merge", merge, windowMs: 50 });
      pub.submit("k1", { count: 1, lastStatus: "running" }, { mode: "merge", merge, windowMs: 50 });
      pub.submit("k1", { count: 1, lastStatus: "done" }, { mode: "merge", merge, windowMs: 50 });

      await Bun.sleep(80);
      expect(emissions).toEqual([{ count: 3, lastStatus: "done" }]);
      pub.dispose();
    });
  });

  describe("never policy", () => {
    test("emits immediately without windowing", () => {
      const { emissions, emit } = collectEmissions<string>();
      const pub = new CoalescingPublisher(emit);

      pub.submit("k1", "immediate", { mode: "never" });
      expect(emissions).toEqual(["immediate"]);
      pub.dispose();
    });

    test("flushes pending state for that key before emitting", async () => {
      const { emissions, emit } = collectEmissions<string>();
      const pub = new CoalescingPublisher(emit);

      pub.submit("k1", "pending-val", { mode: "last-wins", windowMs: 200 });
      expect(emissions).toHaveLength(0);

      pub.submit("k1", "terminal", { mode: "never" });
      expect(emissions).toEqual(["pending-val", "terminal"]);
      expect(pub.pendingCount).toBe(0);
      pub.dispose();
    });

    test("does not affect other keys", async () => {
      const { emissions, emit } = collectEmissions<string>();
      const pub = new CoalescingPublisher(emit);

      pub.submit("k1", "a", { mode: "last-wins", windowMs: 200 });
      pub.submit("k2", "b", { mode: "last-wins", windowMs: 200 });

      pub.submit("k1", "terminal", { mode: "never" });
      expect(emissions).toEqual(["a", "terminal"]);
      expect(pub.pendingCount).toBe(1);

      await Bun.sleep(250);
      expect(emissions).toEqual(["a", "terminal", "b"]);
      pub.dispose();
    });
  });

  describe("flush", () => {
    test("flush(key) emits pending event for that key immediately", () => {
      const { emissions, emit } = collectEmissions<string>();
      const pub = new CoalescingPublisher(emit);

      pub.submit("k1", "val", { mode: "last-wins", windowMs: 5000 });
      expect(emissions).toHaveLength(0);

      pub.flush("k1");
      expect(emissions).toEqual(["val"]);
      expect(pub.pendingCount).toBe(0);
    });

    test("flush() with no key flushes all pending keys", () => {
      const { emissions, emit } = collectEmissions<string>();
      const pub = new CoalescingPublisher(emit);

      pub.submit("k1", "a", { mode: "last-wins", windowMs: 5000 });
      pub.submit("k2", "b", { mode: "last-wins", windowMs: 5000 });
      pub.submit("k3", "c", { mode: "last-wins", windowMs: 5000 });

      pub.flush();
      expect(emissions).toHaveLength(3);
      expect(pub.pendingCount).toBe(0);
    });

    test("flush(key) is a no-op for unknown keys", () => {
      const { emissions, emit } = collectEmissions<string>();
      const pub = new CoalescingPublisher(emit);

      pub.flush("nonexistent");
      expect(emissions).toHaveLength(0);
    });
  });

  describe("dispose", () => {
    test("clears all timers without emitting", async () => {
      const { emissions, emit } = collectEmissions<string>();
      const pub = new CoalescingPublisher(emit);

      pub.submit("k1", "a", { mode: "last-wins", windowMs: 50 });
      pub.submit("k2", "b", { mode: "last-wins", windowMs: 50 });
      expect(pub.pendingCount).toBe(2);

      pub.dispose();
      expect(pub.pendingCount).toBe(0);

      await Bun.sleep(80);
      expect(emissions).toHaveLength(0);
    });

    test("submit is a no-op after dispose", () => {
      const { emissions, emit } = collectEmissions<string>();
      const pub = new CoalescingPublisher(emit);

      pub.dispose();
      pub.submit("k1", "ignored", { mode: "last-wins", windowMs: 50 });
      pub.submit("k1", "also-ignored", { mode: "never" });
      expect(emissions).toHaveLength(0);
      expect(pub.pendingCount).toBe(0);
    });
  });
});
