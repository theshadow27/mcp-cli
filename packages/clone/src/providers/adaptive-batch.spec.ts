import { describe, expect, test } from "bun:test";
import { AdaptiveBatchSizer } from "./adaptive-batch";

describe("AdaptiveBatchSizer", () => {
  test("starts at max", () => {
    expect(new AdaptiveBatchSizer().size).toBe(250);
    expect(new AdaptiveBatchSizer({ max: 100 }).size).toBe(100);
  });

  test("shrink halves the size", () => {
    const sizer = new AdaptiveBatchSizer({ max: 250, min: 25 });
    expect(sizer.shrink()).toBe(true);
    expect(sizer.size).toBe(125);
    expect(sizer.shrink()).toBe(true);
    expect(sizer.size).toBe(62);
  });

  test("shrink clamps at the floor and then reports exhaustion", () => {
    const sizer = new AdaptiveBatchSizer({ max: 100, min: 25 });
    sizer.shrink(); // 50
    sizer.shrink(); // 25
    expect(sizer.size).toBe(25);
    expect(sizer.shrink()).toBe(false);
    expect(sizer.size).toBe(25);
  });

  test("a floor at or above the ceiling is capped so adaptation still works", () => {
    // A floor equal to the ceiling would make the first 429 fatal, silently
    // turning the feature off for small --batch-size values.
    const sizer = new AdaptiveBatchSizer({ max: 10, min: 50 });
    expect(sizer.size).toBe(10);
    expect(sizer.min).toBe(5);
    expect(sizer.shrink()).toBe(true);
    expect(sizer.size).toBe(5);
    expect(sizer.shrink()).toBe(false);
  });

  test("the default floor is capped at half a small ceiling", () => {
    expect(new AdaptiveBatchSizer({ max: 250 }).min).toBe(25);
    expect(new AdaptiveBatchSizer({ max: 30 }).min).toBe(15);
    expect(new AdaptiveBatchSizer({ max: 1 }).min).toBe(1);
  });

  test("grows after a run of fast successes", () => {
    const sizer = new AdaptiveBatchSizer({ max: 250, min: 25, growAfter: 3, fastLatencyMs: 1000 });
    sizer.shrink(); // 125
    sizer.onSuccess(10);
    sizer.onSuccess(10);
    expect(sizer.size).toBe(125); // streak not yet reached
    sizer.onSuccess(10);
    expect(sizer.size).toBe(188);
  });

  test("growth is capped at max", () => {
    const sizer = new AdaptiveBatchSizer({ max: 100, growAfter: 1, fastLatencyMs: 1000 });
    sizer.onSuccess(10);
    sizer.onSuccess(10);
    expect(sizer.size).toBe(100);
  });

  test("a slow success holds steady and resets the streak", () => {
    const sizer = new AdaptiveBatchSizer({ max: 250, min: 25, growAfter: 2, fastLatencyMs: 1000 });
    sizer.shrink(); // 125
    sizer.onSuccess(10);
    sizer.onSuccess(5000); // slow — resets
    expect(sizer.size).toBe(125);
    sizer.onSuccess(10);
    expect(sizer.size).toBe(125); // streak restarted, needs one more
    sizer.onSuccess(10);
    expect(sizer.size).toBe(188);
  });

  test("shrink resets an in-progress growth streak", () => {
    const sizer = new AdaptiveBatchSizer({ max: 250, min: 25, growAfter: 2, fastLatencyMs: 1000 });
    sizer.shrink(); // 125
    sizer.onSuccess(10);
    sizer.shrink(); // 62, streak cleared
    sizer.onSuccess(10);
    expect(sizer.size).toBe(62);
  });
});
