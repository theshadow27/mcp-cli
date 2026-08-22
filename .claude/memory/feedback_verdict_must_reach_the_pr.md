---
name: feedback-verdict-must-reach-the-pr
description: Every review/QA brief must require the verdict be written to the PR — label AND comment — not reported back to the dispatcher
metadata:
  type: feedback
---

**A verdict that is not on the PR did not happen.**

Every brief for a review, re-review, or QA session must end with an explicit instruction to
record the verdict **on the pull request** — a label *and* a comment — in addition to reporting
back. Not "report approve or blockers". That phrasing produces a verdict that exists only in a
session transcript, which is invisible to the orchestrator, to CI, to the author, and to every
other session.

**Why:** on 2026-08-22 this happened twice, both from ad-hoc briefs I wrote.

- **#3143** — the arc's root. Re-review returned **approve** at 09:39. The label stayed
  `review:changes`, nothing advanced, and the sprint sat still for four hours with eleven
  issues blocked behind it. Nothing was wrong with the work; the record was missing.
- **#3137** — a thorough four-finding review completed and went idle. The PR had **zero
  comments and no labels for seven hours.**

Sessions spawned through `/adversarial-review` and `/qa` label PRs because those skills say to.
An ad-hoc `mcx claude spawn` brief inherits nothing, so the instruction has to be written every
time.

**How to apply — put this line in every review/QA brief:**

> Record your verdict **on the PR**: apply the label (`review:pass` / `review:changes` /
> `qa:pass` / `qa:fail`) **and** post a comment with your findings. Then report back to me.
> A verdict that is not on the PR did not happen — it is invisible to everyone else and stalls
> the pipeline silently.

Same family as [[feedback-dont-end-on-passive-wait]] and the night's recurring shape: a step
that *looks* complete while the signal never reaches anyone. Related:
[[project-domain-scoped-mcx-3019]].
