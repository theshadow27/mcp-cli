/**
 * Self-test for the guard-reachability harness (#3212).
 *
 * This is the harness's own bypass-fixture pair, mirroring
 * `scripts/rules/fixtures.spec.ts`'s `@expect N` convention: a green case
 * proving the engine correctly certifies a reachable guard, and a RED case
 * proving it actually fires (reports DEAD) when a guard is unreachable from
 * its concrete specs. A harness with only the green case would be exactly
 * the vacuous-check failure mode #3212 exists to kill.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { MutationNotFoundError, applyMutation, evaluateGuard } from "./harness";
import { guards } from "./manifest";
import type { GuardEntry } from "./manifest";

const REACHABLE_DIR = join(import.meta.dir, "fixtures", "reachable-guard");
const DEAD_DIR = join(import.meta.dir, "fixtures", "dead-guard");

const GUARD_MUTATION = { find: /if \(amount <= 0\) \{/, replace: "if (false) {" };

const reachableEntry: GuardEntry = {
  id: "fixture-reachable",
  label: "fixture: guard actually reached by its concrete spec",
  file: "source.ts",
  mutation: GUARD_MUTATION,
  concreteSpecs: ["source.concrete.ts"],
};

const deadEntry: GuardEntry = {
  id: "fixture-dead",
  label: "fixture: guard NOT reached by its concrete spec",
  file: "source.ts",
  mutation: GUARD_MUTATION,
  concreteSpecs: ["source.concrete.ts"],
};

describe("evaluateGuard — bypass fixtures", () => {
  test("REACHABLE: mutating a load-bearing guard breaks its concrete spec", () => {
    const before = readFileSync(join(REACHABLE_DIR, "source.ts"), "utf8");

    const outcome = evaluateGuard(reachableEntry, { repoRoot: REACHABLE_DIR });

    expect(outcome.status).toBe("reachable");
    expect(outcome.fail).toBeGreaterThan(0);
    expect(outcome.pass).toBeGreaterThan(0);
    // The file on disk must be restored byte-for-byte after evaluation.
    expect(readFileSync(join(REACHABLE_DIR, "source.ts"), "utf8")).toBe(before);
  });

  test("DEAD (the bypass case): mutating an unreachable guard changes nothing observable", () => {
    const before = readFileSync(join(DEAD_DIR, "source.ts"), "utf8");

    const outcome = evaluateGuard(deadEntry, { repoRoot: DEAD_DIR });

    expect(outcome.status).toBe("dead");
    expect(outcome.fail).toBe(0);
    expect(outcome.pass).toBeGreaterThan(0);
    expect(readFileSync(join(DEAD_DIR, "source.ts"), "utf8")).toBe(before);
  });

  test("restores the file on disk even when the spec runner throws", () => {
    const before = readFileSync(join(REACHABLE_DIR, "source.ts"), "utf8");
    const boom = (): never => {
      throw new Error("simulated runner crash");
    };

    expect(() => evaluateGuard(reachableEntry, { repoRoot: REACHABLE_DIR, runSpecs: boom })).toThrow(
      "simulated runner crash",
    );
    expect(readFileSync(join(REACHABLE_DIR, "source.ts"), "utf8")).toBe(before);
  });

  test("reports 'error' (not 'dead') when the spec run executes nothing", () => {
    const outcome = evaluateGuard(reachableEntry, {
      repoRoot: REACHABLE_DIR,
      runSpecs: () => ({ exitCode: 0, stdout: "", stderr: "" }),
    });
    expect(outcome.status).toBe("error");
  });

  test("reports 'error' when the spec run never completed (null exit code)", () => {
    const outcome = evaluateGuard(reachableEntry, {
      repoRoot: REACHABLE_DIR,
      runSpecs: () => ({ exitCode: null, stdout: "", stderr: "spawn failed" }),
    });
    expect(outcome.status).toBe("error");
  });
});

describe("applyMutation", () => {
  test("throws MutationNotFoundError when the pattern is stale", () => {
    const staleEntry: GuardEntry = {
      ...reachableEntry,
      mutation: { find: /this pattern does not exist anywhere in the fixture/, replace: "x" },
    };
    expect(() => applyMutation(staleEntry, "some content")).toThrow(MutationNotFoundError);
  });

  test("rejects a mutation regex carrying the global flag", () => {
    const badEntry: GuardEntry = { ...reachableEntry, mutation: { find: /amount/g, replace: "x" } };
    expect(() => applyMutation(badEntry, "amount amount")).toThrow(/'g' flag/);
  });

  test("does not touch disk — pure string transform", () => {
    const result = applyMutation(reachableEntry, "prefix if (amount <= 0) { suffix");
    expect(result).toBe("prefix if (false) { suffix");
  });
});

describe("manifest hygiene", () => {
  test("every registered guard has at least one concrete spec", () => {
    const missing = guards.filter((g) => g.concreteSpecs.length === 0);
    expect(missing.map((g) => g.id)).toEqual([]);
  });

  test("every registered guard's mutation regex avoids the global flag", () => {
    const flagged = guards.filter((g) => g.mutation.find.flags.includes("g"));
    expect(flagged.map((g) => g.id)).toEqual([]);
  });

  test("guard ids are unique", () => {
    const ids = guards.map((g) => g.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
