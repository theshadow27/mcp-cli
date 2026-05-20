---
name: qa-label-hygiene
description: Correct the qa:fail label on a PR before merging when the only blocker was flaky CI and the orchestrator decided to merge anyway after a rerun.
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 0373c928-f81f-4ebc-8565-9fa473bf2b78
---

When QA returns `qa:fail` with verdict text saying impl is clean and the only blocker is flaky CI (unrelated test failures, `Re-trigger CI to confirm`), the orchestrator can fairly skip a fresh QA round after `gh run rerun --failed` clears green — re-running sonnet just to flip a label is wasteful. But the **PR label must be flipped from `qa:fail` to `qa:pass`** (with a comment citing the rerun + the prior QA's clean impl analysis) **before** arming auto-merge.

**Why:** the merge decision is sound but a `qa:fail`-labelled PR landing in main makes the audit trail misleading. Anything keying on the literal label (branch protection, retro tooling, future workflow gates) sees a failure that wasn't one.

**How to apply:** sprint 58 PR #2171 (issue #2143) merged with stale `qa:fail`. Path forward when "merge on rerun":

```bash
gh pr edit $PR --remove-label qa:fail --add-label qa:pass
gh pr comment $PR --body "Relabeling to qa:pass: prior QA verified impl clean; flaky-CI blocker cleared after \`gh run rerun --failed\` (run $RUN). Flaky test tracked in #NNNN."
mcx pr merge $PR --squash --auto
```

See [[feedback_verify_merge_actually_fired]] for the orthogonal "verify it actually merged" step. Process gap filed at theshadow27/mcp-cli#2177.
