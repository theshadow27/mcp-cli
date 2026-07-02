import { describe, expect, it } from "bun:test";

import type { Step } from "./_runner/types";
import { CI, COMPREHENSIVE, PRE_COMMIT, PRE_PUSH } from "./am-i-done";

const names = (steps: { name: string }[]) => steps.map((s) => s.name);
const leased = (steps: Step[]) => steps.filter((s) => s.lease).map((s) => s.name);

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

  // #2761: test-changed in the pre-push gate runs a near-full parallel spec
  // set on a packages/core diff, which stacks on top of leased COMPREHENSIVE
  // runs from other worktrees and re-creates the oversubscription #2690 fixed.
  // CI steps stay unleased — each CI runner is its own host.
  it("leases test-changed in the pre-push gate (#2761)", () => {
    expect(leased(PRE_PUSH)).toContain("test-changed");
  });

  it("does not lease test-changed in CI (each runner is its own host)", () => {
    expect(leased(CI)).not.toContain("test-changed");
  });
});
