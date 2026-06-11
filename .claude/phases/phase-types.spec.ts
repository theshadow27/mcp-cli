import { describe, expect, test } from "bun:test";
import { type GhLabelEvent, type VerdictContext, parsePrEditFlags, validateVerdictLabel } from "./phase-types";

describe("parsePrEditFlags", () => {
  test("parses --remove-label flags", () => {
    const result = parsePrEditFlags(["--remove-label", "qa:fail"]);
    expect(result).toEqual({ addLabels: [], removeLabels: ["qa:fail"] });
  });

  test("parses --add-label flags", () => {
    const result = parsePrEditFlags(["--add-label", "qa:pass"]);
    expect(result).toEqual({ addLabels: ["qa:pass"], removeLabels: [] });
  });

  test("parses mixed --add-label and --remove-label flags", () => {
    const result = parsePrEditFlags(["--add-label", "review:pass", "--remove-label", "review:changes"]);
    expect(result).toEqual({ addLabels: ["review:pass"], removeLabels: ["review:changes"] });
  });

  test("handles multiple labels of the same type", () => {
    const result = parsePrEditFlags(["--remove-label", "a", "--remove-label", "b"]);
    expect(result).toEqual({ addLabels: [], removeLabels: ["a", "b"] });
  });

  test("returns empty arrays for empty input", () => {
    const result = parsePrEditFlags([]);
    expect(result).toEqual({ addLabels: [], removeLabels: [] });
  });

  test("throws on unknown flag", () => {
    expect(() => parsePrEditFlags(["--title", "oops"])).toThrow("prEdit: unknown flag --title");
  });
});

describe("validateVerdictLabel", () => {
  const HEAD_DATE = "2026-05-31T00:00:00Z";
  const ROUND_STARTED_AT = Date.parse("2026-06-01T00:00:00Z");
  const FRESH = "2026-06-02T00:00:00Z"; // postdates round + head → passes (b) and (c)
  const STALE = "2026-05-30T00:00:00Z"; // predates round start → would fail guard (b)

  const ctx = (over: Partial<VerdictContext> = {}): VerdictContext => ({
    prAuthor: "author-login",
    roundStartedAt: ROUND_STARTED_AT,
    headCommitDate: HEAD_DATE,
    ...over,
  });

  const labelEvent = (created_at: string, over: Partial<GhLabelEvent> = {}): GhLabelEvent => ({
    actor: "author-login",
    label: "review:pass",
    created_at,
    ...over,
  });

  test("accepts a fresh verdict that postdates round start and head commit", () => {
    const result = validateVerdictLabel("review:pass", [labelEvent(FRESH)], ctx());
    expect(result.valid).toBe(true);
  });

  // Regression for #2683: a NaN roundStartedAt must fail closed BEFORE reaching the
  // freshness comparison. Without the early guard, `eventTime < NaN` is `false`, so a
  // STALE event would silently slip past guard (b) and advance a stale verdict.
  test("fails closed when roundStartedAt is NaN (does not silently bypass freshness)", () => {
    const result = validateVerdictLabel("review:pass", [labelEvent(STALE)], ctx({ roundStartedAt: NaN }));
    expect(result.valid).toBe(false);
    expect(result.valid === false && result.rejection).toContain("NaN");
  });

  test("NaN guard rejects even an otherwise-fresh event (guard precedes all comparisons)", () => {
    const result = validateVerdictLabel("review:pass", [labelEvent(FRESH)], ctx({ roundStartedAt: NaN }));
    expect(result.valid).toBe(false);
  });

  // Proves the freshness comparison IS live for a real (non-NaN) roundStartedAt — the
  // behavior the NaN guard protects.
  test("rejects a stale verdict that predates round start", () => {
    const result = validateVerdictLabel("review:pass", [labelEvent(STALE)], ctx());
    expect(result.valid).toBe(false);
    expect(result.valid === false && result.rejection).toContain("stale verdict");
  });

  test("fails closed when no matching label event exists", () => {
    const result = validateVerdictLabel("review:pass", [labelEvent(FRESH, { label: "qa:pass" })], ctx());
    expect(result.valid).toBe(false);
  });

  test("fails closed on an unparseable event timestamp", () => {
    const result = validateVerdictLabel("review:pass", [labelEvent("not-a-date")], ctx());
    expect(result.valid).toBe(false);
  });
});
