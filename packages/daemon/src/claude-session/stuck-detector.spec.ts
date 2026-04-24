import { afterEach, describe, expect, test } from "bun:test";
import type { SessionStateEnum } from "@mcp-cli/core";
import { pollUntil } from "../../../../test/harness";
import { StuckDetector, type StuckDetectorConfig, type StuckEvent } from "./stuck-detector";

const FAST_CONFIG: StuckDetectorConfig = {
  thresholdsMs: [100, 200, 300],
  repeatMs: 300,
};

interface MockSnapshot {
  state: SessionStateEnum;
  tokens: number;
  lastToolCall: { name: string; errorMessage?: string; at: number } | null;
  pendingPermissionCount: number;
}

function setup(overrides?: Partial<MockSnapshot>) {
  const snapshot: MockSnapshot = {
    state: "active",
    tokens: 100,
    lastToolCall: null,
    pendingPermissionCount: 0,
    ...overrides,
  };
  const events: StuckEvent[] = [];
  const detector = new StuckDetector(
    "test-session",
    FAST_CONFIG,
    () => snapshot,
    (e) => events.push(e),
  );
  return { detector, snapshot, events };
}

describe("StuckDetector", () => {
  let detector: StuckDetector | null = null;

  afterEach(() => {
    detector?.dispose();
    detector = null;
  });

  test("fires tier 1 after first threshold", async () => {
    const { detector: d, events } = setup();
    detector = d;
    d.recordProgress(100);

    await pollUntil(() => events.length >= 1, 2000);
    expect(events[0].tier).toBe(1);
    expect(events[0].sessionId).toBe("test-session");
    expect(events[0].sinceMs).toBeGreaterThanOrEqual(90);
  });

  test("escalates through tiers 1→2→3", async () => {
    const { detector: d, events } = setup();
    detector = d;
    d.recordProgress(100);

    await pollUntil(() => events.length >= 3, 2000);
    expect(events[0].tier).toBe(1);
    expect(events[1].tier).toBe(2);
    expect(events[2].tier).toBe(3);
  });

  test("repeats tier 3 after all thresholds exhausted", async () => {
    const { detector: d, events } = setup();
    detector = d;
    d.recordProgress(100);

    await pollUntil(() => events.length >= 4, 3000);
    expect(events[2].tier).toBe(3);
    expect(events[3].tier).toBe(3);
  });

  test("progress resets timer — no stuck event fires", async () => {
    const { detector: d, events } = setup();
    detector = d;
    d.recordProgress(100);

    // Keep recording progress faster than the threshold
    const interval = setInterval(() => d.recordProgress(100), 50);
    await Bun.sleep(250);
    clearInterval(interval);

    expect(events.length).toBe(0);
  });

  test("progress resets tier counter — restarts from tier 1", async () => {
    const { detector: d, events } = setup();
    detector = d;
    d.recordProgress(100);

    // Wait for tier 1
    await pollUntil(() => events.length >= 1, 2000);
    expect(events[0].tier).toBe(1);

    // Record progress — should reset
    d.recordProgress(200);

    // Next event should be tier 1 again, not tier 2
    await pollUntil(() => events.length >= 2, 2000);
    expect(events[1].tier).toBe(1);
  });

  test("permission request suspends detection", async () => {
    const { detector: d, snapshot, events } = setup();
    detector = d;

    // Start with permission pending
    snapshot.pendingPermissionCount = 1;
    snapshot.state = "waiting_permission";
    d.recordProgress(100);

    // Wait well past threshold — should not fire
    await Bun.sleep(250);
    expect(events.length).toBe(0);

    // Clear permission — detector should eventually fire
    snapshot.pendingPermissionCount = 0;
    snapshot.state = "active";

    await pollUntil(() => events.length >= 1, 2000);
    expect(events[0].tier).toBe(1);
  });

  test("non-active state stops detection", async () => {
    const { detector: d, snapshot, events } = setup({ state: "idle" });
    detector = d;
    d.recordProgress(100);

    await Bun.sleep(250);
    expect(events.length).toBe(0);
  });

  test("tokenDelta tracks token changes between emissions", async () => {
    const { detector: d, snapshot, events } = setup();
    detector = d;
    d.recordProgress(100);

    // Add some tokens before tier 1 fires
    snapshot.tokens = 112;

    await pollUntil(() => events.length >= 1, 2000);
    expect(events[0].tokenDelta).toBe(12);

    // No more tokens before tier 2
    await pollUntil(() => events.length >= 2, 2000);
    expect(events[1].tokenDelta).toBe(0);
  });

  test("lastTool and lastToolError from snapshot", async () => {
    const { detector: d, snapshot, events } = setup();
    detector = d;
    snapshot.lastToolCall = { name: "Monitor", errorMessage: "No matching rule", at: Date.now() };
    d.recordProgress(100);

    await pollUntil(() => events.length >= 1, 2000);
    expect(events[0].lastTool).toBe("Monitor");
    expect(events[0].lastToolError).toBe("No matching rule");
  });

  test("dispose prevents further emissions", async () => {
    const { detector: d, events } = setup();
    detector = d;
    d.recordProgress(100);

    d.dispose();
    expect(d.isDisposed).toBe(true);

    await Bun.sleep(200);
    expect(events.length).toBe(0);
  });

  test("dispose is idempotent", () => {
    const { detector: d } = setup();
    detector = d;
    d.dispose();
    d.dispose();
    expect(d.isDisposed).toBe(true);
  });

  test("no timer leak after dispose", async () => {
    const { detector: d, events } = setup();
    detector = d;
    d.recordProgress(100);

    // Dispose mid-flight
    d.dispose();

    // Wait past all thresholds
    await Bun.sleep(500);
    expect(events.length).toBe(0);
  });

  test("recordProgress after dispose is a no-op", async () => {
    const { detector: d, events } = setup();
    detector = d;
    d.dispose();
    d.recordProgress(100);

    await Bun.sleep(200);
    expect(events.length).toBe(0);
  });

  test("no duplicate emissions on flapping", async () => {
    const { detector: d, events, snapshot } = setup();
    detector = d;
    d.recordProgress(100);

    // Let tier 1 fire
    await pollUntil(() => events.length >= 1, 2000);

    // Flap: permission blocks, then unblocks rapidly
    snapshot.state = "waiting_permission";
    snapshot.pendingPermissionCount = 1;
    await Bun.sleep(30);
    snapshot.state = "active";
    snapshot.pendingPermissionCount = 0;

    // Should eventually get tier 2, not a duplicate tier 1
    await pollUntil(() => events.length >= 2, 2000);
    expect(events[1].tier).toBe(2);
  });
});
