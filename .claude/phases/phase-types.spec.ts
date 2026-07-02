import { describe, expect, test } from "bun:test";
import {
  type GhLabelEvent,
  type VerdictContext,
  labelsConsistent,
  parsePrEditFlags,
  requiresArtifactCheck,
  validateVerdictLabel,
} from "./phase-types";

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

describe("requiresArtifactCheck", () => {
  test("matches scripts/build.ts", () => {
    expect(requiresArtifactCheck(["scripts/build.ts"])).toBe(true);
  });

  test("matches scripts/daemon-workers.ts", () => {
    expect(requiresArtifactCheck(["scripts/daemon-workers.ts"])).toBe(true);
  });

  test("matches the worker-path resolver", () => {
    expect(requiresArtifactCheck(["packages/daemon/src/worker-path.ts"])).toBe(true);
  });

  test("matches any *-worker.ts entrypoint", () => {
    expect(requiresArtifactCheck(["packages/daemon/src/mail-session-worker.ts"])).toBe(true);
  });

  test("matches worker-plugin.ts in any directory", () => {
    expect(requiresArtifactCheck(["packages/daemon/src/worker-plugin.ts"])).toBe(true);
  });

  test("does not match ordinary source files", () => {
    expect(requiresArtifactCheck(["packages/command/src/main.ts", "packages/core/src/config.ts"])).toBe(false);
  });

  test("does not match a spec for a worker (endsWith guard is on -worker.ts, not worker*.spec)", () => {
    expect(requiresArtifactCheck(["packages/daemon/src/mock-server.ts"])).toBe(false);
  });

  test("ignores blank entries", () => {
    expect(requiresArtifactCheck(["", "  "])).toBe(false);
  });

  test("returns true if ANY file in the set matches", () => {
    expect(requiresArtifactCheck(["docs/x.md", "scripts/build.ts"])).toBe(true);
  });
});

describe("labelsConsistent", () => {
  test("ok when no verdict labels present", () => {
    expect(labelsConsistent(["bug", "enhancement"])).toEqual({ ok: true, blocking: [] });
  });

  test("ok with qa:pass + review:pass", () => {
    expect(labelsConsistent(["qa:pass", "review:pass"])).toEqual({ ok: true, blocking: [] });
  });

  test("blocks a lingering review:changes even with review:pass present", () => {
    const r = labelsConsistent(["qa:pass", "review:pass", "review:changes"]);
    expect(r.ok).toBe(false);
    expect(r.blocking).toContain("review:changes");
  });

  test("blocks contradictory qa:pass + qa:fail", () => {
    const r = labelsConsistent(["qa:pass", "qa:fail"]);
    expect(r.ok).toBe(false);
    expect(r.blocking).toEqual(expect.arrayContaining(["qa:pass", "qa:fail"]));
  });

  test("trims whitespace before matching", () => {
    expect(labelsConsistent([" review:changes "]).ok).toBe(false);
  });
});
