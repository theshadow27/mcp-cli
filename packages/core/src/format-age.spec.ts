import { describe, expect, test } from "bun:test";
import { formatAgo, usesLastUsedStatus } from "./format-age";

const NOW = 1_000_000_000_000;

describe("formatAgo", () => {
  test("distinguishes 'never called' from a stale timestamp", () => {
    expect(formatAgo(undefined, NOW)).toBe("never");
    expect(formatAgo(null, NOW)).toBe("never");
    // lastUsed is omitted (or 0) until the first call completes.
    expect(formatAgo(0, NOW)).toBe("never");
  });

  test("scales through s / m / h / d / w", () => {
    expect(formatAgo(NOW - 5_000, NOW)).toBe("5s");
    expect(formatAgo(NOW - 90_000, NOW)).toBe("1m");
    expect(formatAgo(NOW - 3 * 3_600_000, NOW)).toBe("3h");
    expect(formatAgo(NOW - 2 * 86_400_000, NOW)).toBe("2d");
    expect(formatAgo(NOW - 21 * 86_400_000, NOW)).toBe("3w");
  });

  test("switches unit exactly at each boundary", () => {
    expect(formatAgo(NOW - 59_000, NOW)).toBe("59s");
    expect(formatAgo(NOW - 60_000, NOW)).toBe("1m");
    expect(formatAgo(NOW - 3_600_000, NOW)).toBe("1h");
    expect(formatAgo(NOW - 86_400_000, NOW)).toBe("1d");
    expect(formatAgo(NOW - 7 * 86_400_000, NOW)).toBe("1w");
  });

  // Clock skew between the daemon that stamped lastUsed and the client reading
  // it should not render as "-3s".
  test("clamps a future timestamp to 0s", () => {
    expect(formatAgo(NOW + 5_000, NOW)).toBe("0s");
  });
});

describe("usesLastUsedStatus", () => {
  // HTTP connections are idle-reaped on purpose (#3447), so "disconnected" is
  // their resting state, not a fault worth reporting.
  test("is true only for http", () => {
    expect(usesLastUsedStatus("http")).toBe(true);
    expect(usesLastUsedStatus("stdio")).toBe(false);
    expect(usesLastUsedStatus("sse")).toBe(false);
    expect(usesLastUsedStatus("virtual")).toBe(false);
  });
});
