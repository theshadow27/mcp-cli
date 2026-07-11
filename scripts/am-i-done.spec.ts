import { describe, expect, it } from "bun:test";

import type { Step } from "./_runner/types";
import { CI, COMPREHENSIVE, PRE_COMMIT, PRE_PUSH } from "./am-i-done";

const names = (steps: { name: string }[]) => steps.map((s) => s.name);
const leased = (steps: Step[]) => steps.filter((s) => s.lease).map((s) => s.name);

describe("am-i-done step lists", () => {
  // #2737: `mcx phase check` now resolves its working-tree files (.mcx.lock,
  // phase sources) against the worktree's own root (findWorktreeRoot), not the
  // main checkout — so it is sound from a linked worktree and the local hooks
  // run it. This is what closed the false-positive/false-negative that had
  // kept it out of the local gates. Sprints run entirely in worktrees.
  it("wires phase-lock into the pre-commit hook", () => {
    expect(names(PRE_COMMIT)).toContain("phase-lock");
  });

  it("wires phase-lock into the pre-push hook", () => {
    expect(names(PRE_PUSH)).toContain("phase-lock");
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
