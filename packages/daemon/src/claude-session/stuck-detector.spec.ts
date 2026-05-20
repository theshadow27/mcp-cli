import { describe, expect, test } from "bun:test";
import type { SessionStateEnum } from "@mcp-cli/core";
import { StuckDetector, type StuckDetectorClock, type StuckDetectorConfig, type StuckEvent } from "./stuck-detector";

// ── FakeClock ──────────────────────────────────────────────────────────────

class FakeClock implements StuckDetectorClock {
  private _now = 0;
  private nextId = 1;
  private timers: { id: number; at: number; callback: () => void }[] = [];

  now(): number {
    return this._now;
  }

  setTimeout(callback: () => void, ms: number): unknown {
    const id = this.nextId++;
    this.timers.push({ id, at: this._now + ms, callback });
    return id;
  }

  clearTimeout(timer: unknown): void {
    this.timers = this.timers.filter((t) => t.id !== timer);
  }

  /** Advance virtual time by `ms` milliseconds, firing expired timers in order. */
  advance(ms: number): void {
    const target = this._now + ms;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const next = this.timers.filter((t) => t.at <= target).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      this._now = next.at;
      this.timers = this.timers.filter((t) => t.id !== next.id);
      next.callback();
    }
    this._now = target;
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

const FAST_CONFIG: StuckDetectorConfig = {
  thresholdsMs: [100, 200, 300],
  repeatMs: 300,
};

interface MockSnapshot {
  state: SessionStateEnum;
  tokens: number;
  lastToolCall: { name: string; errorMessage?: string; at: number } | null;
  pendingPermissionCount: number;
  hasActiveToolCall: boolean;
}

function setup(overrides?: Partial<MockSnapshot>) {
  const clock = new FakeClock();
  const snapshot: MockSnapshot = {
    state: "active",
    tokens: 100,
    lastToolCall: null,
    pendingPermissionCount: 0,
    hasActiveToolCall: false,
    ...overrides,
  };
  const events: StuckEvent[] = [];
  const detector = new StuckDetector(
    "test-session",
    FAST_CONFIG,
    () => snapshot,
    (e) => events.push(e),
    clock,
  );
  return { detector, snapshot, events, clock };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("StuckDetector", () => {
  test("fires tier 1 after first threshold", () => {
    const { detector, events, clock } = setup();
    detector.recordProgress(100);

    clock.advance(100);
    expect(events).toHaveLength(1);
    expect(events[0].tier).toBe(1);
    expect(events[0].sessionId).toBe("test-session");
    expect(events[0].sinceMs).toBeGreaterThanOrEqual(100);

    detector.dispose();
  });

  test("escalates through tiers 1→2→3", () => {
    const { detector, events, clock } = setup();
    detector.recordProgress(100);

    clock.advance(300); // past all three thresholds
    expect(events).toHaveLength(3);
    expect(events[0].tier).toBe(1);
    expect(events[1].tier).toBe(2);
    expect(events[2].tier).toBe(3);

    detector.dispose();
  });

  test("repeats tier 3 after all thresholds exhausted", () => {
    const { detector, events, clock } = setup();
    detector.recordProgress(100);

    clock.advance(600); // 300ms thresholds + 300ms repeatMs
    expect(events.length).toBeGreaterThanOrEqual(4);
    expect(events[2].tier).toBe(3);
    expect(events[3].tier).toBe(3);

    detector.dispose();
  });

  test("progress resets timer — no stuck event fires", () => {
    const { detector, events, clock } = setup();
    detector.recordProgress(100);

    // Record progress at 50ms (before threshold), then advance past original threshold
    clock.advance(50);
    detector.recordProgress(100);
    clock.advance(80); // 50+80=130ms total, but timer reset at 50ms so only 80ms elapsed

    expect(events).toHaveLength(0);

    detector.dispose();
  });

  test("progress resets tier counter — restarts from tier 1", () => {
    const { detector, events, clock } = setup();
    detector.recordProgress(100);

    // Wait for tier 1
    clock.advance(100);
    expect(events).toHaveLength(1);
    expect(events[0].tier).toBe(1);

    // Record progress — should reset
    detector.recordProgress(200);

    // Next event should be tier 1 again
    clock.advance(100);
    expect(events).toHaveLength(2);
    expect(events[1].tier).toBe(1);

    detector.dispose();
  });

  test("permission request suspends detection", () => {
    const { detector, snapshot, events, clock } = setup();

    // Start with permission pending
    snapshot.pendingPermissionCount = 1;
    snapshot.state = "waiting_permission";
    detector.recordProgress(100);

    // Advance past threshold — timer fires but is re-scheduled due to pending permission
    clock.advance(100);
    expect(events).toHaveLength(0);

    // Clear permission — next scheduled evaluation should fire
    snapshot.pendingPermissionCount = 0;
    snapshot.state = "active";

    clock.advance(100); // advance again to trigger the rescheduled timer
    expect(events).toHaveLength(1);
    expect(events[0].tier).toBe(1);

    detector.dispose();
  });

  test("non-active state stops detection", () => {
    const { detector, events, clock } = setup({ state: "idle" });
    detector.recordProgress(100);

    clock.advance(500);
    expect(events).toHaveLength(0);

    detector.dispose();
  });

  test("tokenDelta tracks token changes between emissions", () => {
    const { detector, snapshot, events, clock } = setup();
    detector.recordProgress(100);

    // Add some tokens before tier 1 fires
    snapshot.tokens = 112;

    clock.advance(100); // tier 1 fires
    expect(events).toHaveLength(1);
    expect(events[0].tokenDelta).toBe(12);

    // No more tokens before tier 2
    clock.advance(100); // tier 2 fires
    expect(events).toHaveLength(2);
    expect(events[1].tokenDelta).toBe(0);

    detector.dispose();
  });

  test("lastTool and lastToolError from snapshot", () => {
    const { detector, snapshot, events, clock } = setup();
    snapshot.lastToolCall = { name: "Monitor", errorMessage: "No matching rule", at: 0 };
    detector.recordProgress(100);

    clock.advance(100);
    expect(events).toHaveLength(1);
    expect(events[0].lastTool).toBe("Monitor");
    expect(events[0].lastToolError).toBe("No matching rule");

    detector.dispose();
  });

  test("dispose prevents further emissions", () => {
    const { detector, events, clock } = setup();
    detector.recordProgress(100);

    detector.dispose();
    expect(detector.isDisposed).toBe(true);

    clock.advance(500);
    expect(events).toHaveLength(0);
  });

  test("dispose is idempotent", () => {
    const { detector } = setup();
    detector.dispose();
    detector.dispose();
    expect(detector.isDisposed).toBe(true);
  });

  test("no timer leak after dispose", () => {
    const { detector, events, clock } = setup();
    detector.recordProgress(100);

    detector.dispose();

    clock.advance(600);
    expect(events).toHaveLength(0);
  });

  test("recordProgress after dispose is a no-op", () => {
    const { detector, events, clock } = setup();
    detector.dispose();
    detector.recordProgress(100);

    clock.advance(300);
    expect(events).toHaveLength(0);
  });

  test("no duplicate emissions on flapping", () => {
    const { detector, snapshot, events, clock } = setup();
    detector.recordProgress(100);

    // Let tier 1 fire
    clock.advance(100);
    expect(events).toHaveLength(1);

    // Flap: permission blocks (timer fires but reschedules), then unblocks
    snapshot.state = "waiting_permission";
    snapshot.pendingPermissionCount = 1;
    clock.advance(50); // mid-flight timer fires, reschedules
    snapshot.state = "active";
    snapshot.pendingPermissionCount = 0;

    // Should eventually get tier 2, not a duplicate tier 1
    clock.advance(100);
    expect(events.length).toBeGreaterThanOrEqual(2);
    expect(events[1].tier).toBe(2);

    detector.dispose();
  });

  test("active tool call suppresses stuck events", () => {
    const { detector, snapshot, events, clock } = setup({ hasActiveToolCall: true });
    snapshot.lastToolCall = { name: "Bash", at: 0 };
    detector.recordProgress(100);

    clock.advance(600);
    expect(events).toHaveLength(0);

    detector.dispose();
  });

  test("stuck fires after active tool call completes with no progress (true positive: frozen session)", () => {
    const { detector, snapshot, events, clock } = setup({ hasActiveToolCall: true });
    snapshot.lastToolCall = { name: "Bash", at: 0 };
    detector.recordProgress(100);

    // Tool active — timer fires but reschedules
    clock.advance(100);
    expect(events).toHaveLength(0);

    // Tool completes — next scheduled evaluation fires the stuck event
    snapshot.hasActiveToolCall = false;
    clock.advance(100);
    expect(events).toHaveLength(1);
    expect(events[0].tier).toBe(1);
    expect(events[0].lastTool).toBe("Bash");

    detector.dispose();
  });

  test("active tool call resumes detection after tool completes with progress", () => {
    const { detector, snapshot, events, clock } = setup({ hasActiveToolCall: true });
    snapshot.lastToolCall = { name: "Bash", at: 0 };
    detector.recordProgress(100);

    // Tool active — suppressed
    clock.advance(100);
    expect(events).toHaveLength(0);

    // Tool completes, progress recorded (normal flow) — resets timer
    snapshot.hasActiveToolCall = false;
    detector.recordProgress(200);

    clock.advance(100);
    expect(events).toHaveLength(1);
    expect(events[0].tier).toBe(1);

    detector.dispose();
  });

  test("constructor throws on empty thresholdsMs", () => {
    expect(
      () =>
        new StuckDetector(
          "test-session",
          { thresholdsMs: [], repeatMs: 300 },
          () => ({
            state: "active" as SessionStateEnum,
            tokens: 0,
            lastToolCall: null,
            pendingPermissionCount: 0,
            hasActiveToolCall: false,
          }),
          () => {},
        ),
    ).toThrow("thresholdsMs must be non-empty");
  });

  test("constructor throws on non-ascending thresholdsMs", () => {
    const makeSnapshot = () => ({
      state: "active" as SessionStateEnum,
      tokens: 0,
      lastToolCall: null,
      pendingPermissionCount: 0,
      hasActiveToolCall: false,
    });
    expect(() => new StuckDetector("s", { thresholdsMs: [100, 100], repeatMs: 300 }, makeSnapshot, () => {})).toThrow(
      "strictly ascending",
    );
    expect(() => new StuckDetector("s", { thresholdsMs: [200, 100], repeatMs: 300 }, makeSnapshot, () => {})).toThrow(
      "strictly ascending",
    );
  });

  test("constructor throws on non-positive thresholdsMs values", () => {
    const makeSnapshot = () => ({
      state: "active" as SessionStateEnum,
      tokens: 0,
      lastToolCall: null,
      pendingPermissionCount: 0,
      hasActiveToolCall: false,
    });
    expect(() => new StuckDetector("s", { thresholdsMs: [0], repeatMs: 300 }, makeSnapshot, () => {})).toThrow(
      "positive finite number",
    );
    expect(() => new StuckDetector("s", { thresholdsMs: [-100], repeatMs: 300 }, makeSnapshot, () => {})).toThrow(
      "positive finite number",
    );
    expect(
      () => new StuckDetector("s", { thresholdsMs: [Number.POSITIVE_INFINITY], repeatMs: 300 }, makeSnapshot, () => {}),
    ).toThrow("positive finite number");
    expect(
      () => new StuckDetector("s", { thresholdsMs: [100, 0, 300], repeatMs: 300 }, makeSnapshot, () => {}),
    ).toThrow("positive finite number");
  });

  test("constructor throws on non-positive repeatMs", () => {
    const makeSnapshot = () => ({
      state: "active" as SessionStateEnum,
      tokens: 0,
      lastToolCall: null,
      pendingPermissionCount: 0,
      hasActiveToolCall: false,
    });
    expect(() => new StuckDetector("s", { thresholdsMs: [100], repeatMs: 0 }, makeSnapshot, () => {})).toThrow(
      "repeatMs must be positive",
    );
    expect(() => new StuckDetector("s", { thresholdsMs: [100], repeatMs: -1 }, makeSnapshot, () => {})).toThrow(
      "repeatMs must be positive",
    );
  });
});
