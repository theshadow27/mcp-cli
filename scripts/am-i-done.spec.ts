import { describe, expect, it } from "bun:test";

import { CI, COMPREHENSIVE, PRE_COMMIT, PRE_PUSH } from "./am-i-done";

const names = (steps: { name: string }[]) => steps.map((s) => s.name);

describe("am-i-done step lists", () => {
  // #2737: `mcx phase check` resolves its root to the main checkout from a
  // linked worktree, so the local hooks must NOT run phase-lock — it would
  // false-positive-block every clean worktree commit/push and false-negative
  // the worktree's own lock drift. Sprints run entirely in worktrees.
  it("does not wire phase-lock into the pre-commit hook", () => {
    expect(names(PRE_COMMIT)).not.toContain("phase-lock");
  });

  it("does not wire phase-lock into the pre-push hook", () => {
    expect(names(PRE_PUSH)).not.toContain("phase-lock");
  });

  // The check is sound against a real checkout (root == repo root), so CI and
  // the default full run keep it — that is where committed lock drift is caught.
  it("keeps phase-lock in the CI gate", () => {
    expect(names(CI)).toContain("phase-lock");
  });

  it("keeps phase-lock in the comprehensive (default) run", () => {
    expect(names(COMPREHENSIVE)).toContain("phase-lock");
  });
});
