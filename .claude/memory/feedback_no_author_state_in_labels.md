---
name: feedback_no_author_state_in_labels
description: the review label set has no author-applicable state — a repaired PR cannot be represented, so authors self-assert review:pass (#3179)
metadata:
  type: feedback
---

`review:changes` / `review:pass` / `qa:fail` / `qa:pass` are **all verdicts rendered by
someone other than the author**. An author who has just pushed a repair has no truthful
label to apply. Phase-driven runs erase `review:changes` on route-to-repair
(`review-fn.ts:257`, correct anti-replay per #2649) so the PR reads as *never reviewed*;
hand-orchestrated runs leave it so the PR reads as *unrepaired*.

**Why:** the state is not missing from the system — `work_items.phase`, `review_round`,
`previous_phase` are all correct in SQLite. It is missing from the **PR**, which is the
surface every human and every non-phase-driven session reads. A state machine whose
state is invisible on the artifact it governs only works while one process is driving it.
Sprint 78 ran largely by hand, which is why it surfaced there.

**How to apply:** until #3179 lands, an author who repairs a PR leaves the existing label
alone, posts a repair comment **naming the new head SHA**, and mails the orchestrator.
Never self-assert `review:pass` — that converts a reviewer gate into self-attestation and
nothing downstream can tell the two apart (cost us #2769/#2779/#2790 once already).
Endorse workers who refuse the flip and explain; that judgment is the behaviour to
reinforce.

When #3179 is implemented: **gate before label**. Creating `review:repaired` before
`labelsConsistent()` blocks on it is worse than not having it — a `review:repaired` +
`qa:pass` PR would merge clean with no re-review. It is meta
(`.claude/phases/**` + `.claude/skills/**`), so it is boundary work, never a worker slot
— see [[feedback_meta_issue_planning_guard]]. Include the staleness rule (a review label
older than the current head is a lie) and the `bootstrap-sprint` update, or every future
project inherits the hole. Related: [[feedback_verdict_must_reach_the_pr]].
