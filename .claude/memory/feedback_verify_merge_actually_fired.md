---
name: Verify auto-merge actually fired before marking done
description: After qa:pass + gh pr merge --auto, poll until state=MERGED. Don't trust QA verdict + auto-merge queue as proof of merge.
type: feedback
originSessionId: 71cb91f8-0ab6-4c77-99ee-ba04353ce6d1
---
After spawning a QA worker and getting `qa:pass`, the orchestrator MUST verify the PR actually merged before marking the work item `done` or the task `completed`. The pattern that broke sprint 47 (#1847 / issue #1586):

1. QA spawned, verdict = `qa:pass`, label set
2. `gh pr merge --auto` queued the merge
3. Orchestrator marked `phase=done`, task `completed`, byed the QA session
4. Auto-merge **silently stalled** because:
   - Coverage CI flipped red AFTER QA finished (truncated coverage_out.txt mid-write — possibly Bun segfault per #1004)
   - 3 fresh Copilot inline comments posted AFTER QA (about seqAfter being set after publish() — real bug)
5. With the QA session byed and the work item marked done, the orchestrator's wait loop never polled merge state again
6. The user caught it ~25 min later. Without intervention, it would have sat unmerged all night.

**Why:** `gh pr merge --auto` only QUEUES the merge. CI can flip red afterward. Copilot can post threads afterward. QA's snapshot is stale immediately. Sprint 34 had the same regression with #1380 (17 unresolved Copilot threads at merge). Sprint 47 repeated it. The CLAUDE.md "4 PR-comment surfaces" rule exists precisely for this — but the orchestrator keeps trusting the QA worker's snapshot instead of re-checking at merge time.

**How to apply:**

When auto-merging after qa:pass, do NOT mark done immediately. Instead:

```bash
# Right after `gh pr merge --auto`:
gh pr view $PR --json state,mergedAt,mergeable,statusCheckRollup
```

Verify ALL of:
- `state == "MERGED"` (not just OPEN with autoMergeRequest set)
- `mergedAt != null`
- `mergeable == "MERGEABLE"` (not CONFLICTING/UNKNOWN)
- All CI checks `conclusion == "SUCCESS"` (not "" or FAILURE)

If any of those fail: leave phase=qa, do NOT bye the QA session, re-check Copilot threads (they may have appeared post-verdict), re-spawn repair if needed.

For the orchestrator's wait loop: include un-merged "qa:pass" PRs as wait targets, not just session events. A stalled auto-merge produces no `session:result` event but does produce `pr:merged` (if it eventually fires) or `checks:failed`. Subscribe to those.

When 7 of 8 PRs merge cleanly and the orchestrator declares victory, that 8th one is the one most likely to be silently stuck — by anchoring effect, the orchestrator under-checks once a streak forms.
