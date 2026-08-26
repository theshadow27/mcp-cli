---
name: no-github-merge-queue
description: GitHub merge queue is NOT available on this project — not on an enterprise plan; never propose it as a fix
metadata:
  type: project
---

**GitHub merge queue cannot be used on `theshadow27/mcp-cli`.** The repo is not on
a plan that offers it. Any design that depends on a merge queue is unbuildable
here, no matter how well it fits.

**Why:** this has been explained to Claude more than once (most recently
2026-08-25, with visible operator frustration). It keeps resurfacing because
`strict_required_status_checks_policy: false` leaves a real hole — required checks
validate the merge-ref as of last-push time, not the true merge result — and a
merge queue is the textbook fix for exactly that hole. It is the right answer to
the wrong repo.

**How to apply:**
- Never propose a merge queue, `gh pr merge` queue submission, or a `done.ts`
  rewiring that polls queue outcomes.
- `strict: true` is also rejected (N² update-branch cascade cost — see
  [[feedback_sprint_bulk_and_cascade]]).
- The operator's suggested direction to explore instead is the **`gh-stacks`**
  extension, with their own caveat that it is *"even more coordination"* — so
  treat it as a spike to evaluate, not a default.
- Merge order stays the orchestrator's responsibility; main-CI is the arbiter.
- #3259's part 4 is written around a merge queue and is therefore unbuildable as
  specified. See [[feedback_never_bypass_gate]].
