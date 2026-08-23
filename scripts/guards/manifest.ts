/**
 * Guard registry for the guard-reachability harness (`bun run guards`, #3212).
 *
 * A "guard" here is a runtime check (a thrown error, a refused branch, a
 * rejected input) that some invariant holds. Deleting a guard should turn
 * something red. If it doesn't, either the guard is dead code or its only
 * coverage is a fake that doesn't exercise the real code path — see
 * `scripts/guards/README.md` for the full rationale and the #3038/#3200
 * incident that motivated this.
 *
 * Each entry:
 *   - `file` / `mutation` — a single-site regex mutation that defeats the
 *     guard (mirrors literally deleting it).
 *   - `concreteSpecs` — spec files that MUST exercise a real dependency
 *     (real git, real filesystem, real SQLite — not a hand-written fake).
 *     Only list specs that would actually break if the guard vanished.
 *
 * `bun run doing-it-wrong`'s `fixtures.spec.ts` proves every rule has a
 * fixture that fires; `scripts/guards/harness.spec.ts` does the analogous
 * check for this engine using self-contained bypass fixtures under
 * `fixtures/`. This file is where REAL production guards get registered.
 */

export interface GuardMutation {
  /** Matched once against the guard file's source. Must not carry the 'g' flag. */
  find: RegExp;
  /** Replacement text substituted at the match site — defeats the guard. */
  replace: string;
}

export interface GuardEntry {
  /** Stable id, used in CLI filtering and error messages. */
  id: string;
  /** Human label shown in the `bun run guards` report. */
  label: string;
  /** Repo-relative path to the file containing the guard. */
  file: string;
  /** The mutation applied to simulate the guard being deleted/defeated. */
  mutation: GuardMutation;
  /**
   * Repo-relative paths to spec files that exercise this guard through a
   * real dependency. Only these run during evaluation — fake-based specs
   * are deliberately excluded; they'd only prove the fake is wired up.
   */
  concreteSpecs: string[];
}

export const guards: GuardEntry[] = [
  {
    id: "branch-guard-refusal",
    label: "phase runsOn branch guard refuses a non-matching branch",
    file: "packages/core/src/branch-guard.ts",
    mutation: {
      find: /throw new BranchGuardError\(message, expected, actualValue\);/,
      replace: "return { warning: null };",
    },
    concreteSpecs: ["packages/core/src/branch-guard.concrete.spec.ts"],
  },
];
