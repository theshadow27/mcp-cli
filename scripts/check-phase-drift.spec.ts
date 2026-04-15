import { describe, expect, test } from "bun:test";
import { check } from "./check-phase-drift.ts";

describe("check-phase-drift", () => {
  test("passes when assertNoDrift is in the run block", () => {
    const source = `
    if (sub === "run") {
      const argv = args.slice(1);
      assertNoDrift(d);
      await runPhase(argv, d);
      return;
    }`;
    expect(check(source)).toEqual({ ok: true, reason: "assertNoDrift/detectDrift found at line 4" });
  });

  test("passes when detectDrift is in the run block", () => {
    const source = `
    if (sub === "run") {
      const result = detectDrift(d);
      if (!result.ok) throw new Error("drift");
      return;
    }`;
    expect(check(source)).toEqual({ ok: true, reason: "assertNoDrift/detectDrift found at line 3" });
  });

  test("passes with single-quoted run check", () => {
    const source = `
    if (sub === 'run') {
      assertNoDrift(d);
      return;
    }`;
    expect(check(source)).toEqual({ ok: true, reason: "assertNoDrift/detectDrift found at line 3" });
  });

  test("fails when drift call is missing from run block", () => {
    const source = `
    if (sub === "run") {
      const argv = args.slice(1);
      await runPhase(argv, d);
      return;
    }`;
    const result = check(source);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("does not call assertNoDrift");
  });

  test("fails when run block is not found", () => {
    const source = `
    if (sub === "list") {
      listPhases();
      return;
    }`;
    const result = check(source);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("Could not find");
  });

  test("ignores assertNoDrift outside the run block", () => {
    const source = `
    if (sub === "install") {
      assertNoDrift(d);
      return;
    }
    if (sub === "run") {
      await runPhase(argv, d);
      return;
    }`;
    const result = check(source);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("does not call assertNoDrift");
  });
});
