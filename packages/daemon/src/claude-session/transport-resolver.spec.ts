import { describe, expect, test } from "bun:test";
import { resolveTransport } from "./transport-resolver";

describe("resolveTransport", () => {
  test("explicit 'stdio' always returns stdio", () => {
    expect(resolveTransport("stdio", "2.1.100")).toBe("stdio");
    expect(resolveTransport("stdio", "2.1.122")).toBe("stdio");
    expect(resolveTransport("stdio", "2.1.200")).toBe("stdio");
    expect(resolveTransport("stdio", null)).toBe("stdio");
  });

  test("explicit 'sdk-url' always returns ws", () => {
    expect(resolveTransport("sdk-url", "2.1.200")).toBe("ws");
    expect(resolveTransport("sdk-url", "2.1.100")).toBe("ws");
    expect(resolveTransport("sdk-url", null)).toBe("ws");
  });

  test("auto with version <= 2.1.122 returns ws", () => {
    expect(resolveTransport("auto", "2.1.122")).toBe("ws");
    expect(resolveTransport("auto", "2.1.120")).toBe("ws");
    expect(resolveTransport("auto", "2.1.0")).toBe("ws");
    expect(resolveTransport("auto", "2.0.999")).toBe("ws");
  });

  test("auto with version > 2.1.122 returns stdio", () => {
    expect(resolveTransport("auto", "2.1.123")).toBe("stdio");
    expect(resolveTransport("auto", "2.2.0")).toBe("stdio");
    expect(resolveTransport("auto", "3.0.0")).toBe("stdio");
  });

  test("auto with null version defaults to ws", () => {
    expect(resolveTransport("auto", null)).toBe("ws");
  });

  test("undefined config defaults to auto behavior", () => {
    expect(resolveTransport(undefined, "2.1.122")).toBe("ws");
    expect(resolveTransport(undefined, "2.1.123")).toBe("stdio");
    expect(resolveTransport(undefined, null)).toBe("ws");
  });

  test("pre-release suffixes are parsed correctly", () => {
    expect(resolveTransport("auto", "2.1.123-beta.1")).toBe("stdio");
    expect(resolveTransport("auto", "2.2.0-rc.2")).toBe("stdio");
    expect(resolveTransport("auto", "2.1.122-alpha.0")).toBe("ws");
    expect(resolveTransport("auto", "2.1.100-dev.5")).toBe("ws");
  });

  test("fully non-numeric segments are treated as 0, not NaN", () => {
    // "beta" → parseInt → NaN; || 0 must coerce to 0 (NaN ?? 0 = NaN, NaN || 0 = 0)
    // [NaN,0,0] without guard would make diff=NaN → compareSemver returns 0 (wrong)
    // [0,0,0] with guard is correct: 0.0.0 < 2.1.122 → ws
    expect(resolveTransport("auto", "beta.0.0")).toBe("ws");
    // Empty segment from corrupt split: "2..123" → [2, NaN, 123] → [2, 0, 123]
    // 2.0.123 < 2.1.122 → ws
    expect(resolveTransport("auto", "2..123")).toBe("ws");
  });
});
