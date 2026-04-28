import { describe, expect, test } from "bun:test";
import {
  BUILTIN_STRATEGIES,
  STRATEGY_HOST_CHECK_IPV6_LOOPBACK_V1,
  STRATEGY_NOOP_PRE_2_1_120,
  compareVersion,
  countOccurrences,
  replaceAllBytes,
  resolveStrategy,
} from "./strategies";

const enc = new TextEncoder();

describe("compareVersion", () => {
  test("equal versions", () => {
    expect(compareVersion("2.1.121", "2.1.121")).toBe(0);
  });
  test("less / greater on patch", () => {
    expect(compareVersion("2.1.119", "2.1.120")).toBeLessThan(0);
    expect(compareVersion("2.1.121", "2.1.120")).toBeGreaterThan(0);
  });
  test("less / greater on minor and major", () => {
    expect(compareVersion("2.0.99", "2.1.0")).toBeLessThan(0);
    expect(compareVersion("3.0.0", "2.99.99")).toBeGreaterThan(0);
  });
  test("missing segments treated as zero", () => {
    expect(compareVersion("2", "2.0.0")).toBe(0);
    expect(compareVersion("2.1", "2.1.0")).toBe(0);
  });
});

describe("countOccurrences / replaceAllBytes", () => {
  test("counts non-overlapping occurrences", () => {
    const buf = enc.encode("aaaaaa");
    expect(countOccurrences(buf, enc.encode("aa"))).toBe(3);
  });
  test("replaces all occurrences", () => {
    const buf = enc.encode("foo bar foo bar foo");
    const out = replaceAllBytes(buf, enc.encode("foo"), enc.encode("XYZ"));
    expect(new TextDecoder().decode(out)).toBe("XYZ bar XYZ bar XYZ");
  });
  test("rejects length mismatch", () => {
    expect(() => replaceAllBytes(enc.encode("hi"), enc.encode("h"), enc.encode("hi"))).toThrow();
  });
  test("does not mutate input", () => {
    const buf = enc.encode("foo");
    const original = new Uint8Array(buf);
    replaceAllBytes(buf, enc.encode("foo"), enc.encode("bar"));
    expect(buf).toEqual(original);
  });
});

describe("STRATEGY_NOOP_PRE_2_1_120", () => {
  test("matches versions below 2.1.120", () => {
    expect(STRATEGY_NOOP_PRE_2_1_120.matches("2.1.119")).toBe(true);
    expect(STRATEGY_NOOP_PRE_2_1_120.matches("2.1.91")).toBe(true);
    expect(STRATEGY_NOOP_PRE_2_1_120.matches("1.99.99")).toBe(true);
  });
  test("does not match 2.1.120+", () => {
    expect(STRATEGY_NOOP_PRE_2_1_120.matches("2.1.120")).toBe(false);
    expect(STRATEGY_NOOP_PRE_2_1_120.matches("2.1.121")).toBe(false);
  });
  test("apply returns input unchanged (copy)", () => {
    const buf = enc.encode("hello world");
    const out = STRATEGY_NOOP_PRE_2_1_120.apply(buf);
    expect(out).toEqual(buf);
    expect(out).not.toBe(buf); // new buffer, not same reference
  });
  test("validate is always ok", () => {
    expect(STRATEGY_NOOP_PRE_2_1_120.validate(new Uint8Array(0)).ok).toBe(true);
  });
});

describe("STRATEGY_HOST_CHECK_IPV6_LOOPBACK_V1", () => {
  test("matches 2.1.120 and 2.1.121", () => {
    expect(STRATEGY_HOST_CHECK_IPV6_LOOPBACK_V1.matches("2.1.120")).toBe(true);
    expect(STRATEGY_HOST_CHECK_IPV6_LOOPBACK_V1.matches("2.1.121")).toBe(true);
  });
  test("does not match earlier or later versions", () => {
    expect(STRATEGY_HOST_CHECK_IPV6_LOOPBACK_V1.matches("2.1.119")).toBe(false);
    expect(STRATEGY_HOST_CHECK_IPV6_LOOPBACK_V1.matches("2.1.122")).toBe(false);
    expect(STRATEGY_HOST_CHECK_IPV6_LOOPBACK_V1.matches("2.2.0")).toBe(false);
  });
  test("apply replaces all 4 occurrences in a synthetic buffer", () => {
    const synthetic = enc.encode(
      "prefix...claude-staging.fedstart.com...middle...claude-staging.fedstart.com...more...claude-staging.fedstart.com...end...claude-staging.fedstart.com...tail",
    );
    const out = STRATEGY_HOST_CHECK_IPV6_LOOPBACK_V1.apply(synthetic);
    const decoded = new TextDecoder().decode(out);
    expect(decoded).not.toContain("claude-staging.fedstart.com");
    expect(countOccurrences(out, enc.encode("[000:000:000:000:000:0:0:1]"))).toBe(4);
  });
  test("apply preserves length", () => {
    const synthetic = enc.encode(`${"x".repeat(100)}claude-staging.fedstart.com${"y".repeat(100)}`);
    const out = STRATEGY_HOST_CHECK_IPV6_LOOPBACK_V1.apply(synthetic);
    expect(out.length).toBe(synthetic.length);
  });
  test("validate accepts correct count of replacements", () => {
    const synthetic = enc.encode(`${"[000:000:000:000:000:0:0:1].".repeat(4)}filler`);
    expect(STRATEGY_HOST_CHECK_IPV6_LOOPBACK_V1.validate(synthetic)).toEqual({ ok: true });
  });
  test("validate rejects unreplaced source occurrences", () => {
    const synthetic = enc.encode("claude-staging.fedstart.com left over");
    const result = STRATEGY_HOST_CHECK_IPV6_LOOPBACK_V1.validate(synthetic);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/unreplaced/);
  });
  test("validate rejects wrong replacement count", () => {
    const synthetic = enc.encode("[000:000:000:000:000:0:0:1].".repeat(3));
    const result = STRATEGY_HOST_CHECK_IPV6_LOOPBACK_V1.validate(synthetic);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/expected 4/);
  });
});

describe("resolveStrategy", () => {
  test("picks noop for old versions", () => {
    expect(resolveStrategy("2.1.119")?.id).toBe("noop-pre-2.1.120");
  });
  test("picks ipv6 loopback for 2.1.120-2.1.121", () => {
    expect(resolveStrategy("2.1.120")?.id).toBe("host-check-ipv6-loopback-v1");
    expect(resolveStrategy("2.1.121")?.id).toBe("host-check-ipv6-loopback-v1");
  });
  test("returns null for unsupported newer versions", () => {
    expect(resolveStrategy("2.1.122")).toBeNull();
    expect(resolveStrategy("3.0.0")).toBeNull();
  });
  test("registry order is first-match-wins", () => {
    const overlapping = [
      { ...STRATEGY_NOOP_PRE_2_1_120, id: "first", matches: () => true },
      { ...STRATEGY_HOST_CHECK_IPV6_LOOPBACK_V1, id: "second", matches: () => true },
    ];
    expect(resolveStrategy("2.1.121", overlapping)?.id).toBe("first");
  });
});

describe("BUILTIN_STRATEGIES", () => {
  test("includes both built-in strategies", () => {
    expect(BUILTIN_STRATEGIES).toHaveLength(2);
    expect(BUILTIN_STRATEGIES.map((s) => s.id)).toEqual(["noop-pre-2.1.120", "host-check-ipv6-loopback-v1"]);
  });
});
