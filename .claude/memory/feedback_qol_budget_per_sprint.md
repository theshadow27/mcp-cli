---
name: feedback-qol-budget-per-sprint
description: Standing grant — up to 2 quality-of-life fixes per sprint may be slotted alongside goal work, provided the arc stays on track
metadata:
  type: feedback
---

Operator grant, 2026-08-22 (#3019 arc): a sprint plan may include **up to two**
quality-of-life / orchestration-reliability fixes alongside its goal issues — "sneak in any
quality of life fixes like that... max 2 per sprint. use em well."

**Why:** the arc is six sprints long, and the failures that cost the most are not feature
bugs — they are harness failures that make a stopped system look like a working one. Fixing
those early compounds across every remaining sprint. Fixing them late is paying the cost
five more times first.

**How to apply:** spend the two slots on things that reduce *orchestration* failure, not on
general backlog cleanup — the backlog is not the prize. Prefer a fix that turns an invisible
failure into a detectable one. Two is a ceiling, not a quota; zero is fine if nothing
qualifies.

Planned spend across the arc, in priority order (all filed 2026-08-22, mostly by the
sprint orchestrators themselves):

- **79**: #3107 (`/goal` interception + `spawn --goal` — binds an orchestrator's exit
  criterion in the harness instead of a brief) and #3104 (`[RATE LIMITED]` sticky-for-the-turn
  false signal).
- **80**: #3033 (orchestrator halt on quota freeze has no durable resume trigger) and #3031
  (detect stranded PRs — `review:changes` stale vs head commit). Together these two are
  precisely what would have prevented sprint 77's 19-day stall.
- **81**: #3032 (draft sprint container PRs rot silently — no liveness signal), plus one open.
- **82–83**: hold open; spend on whatever the earlier sprints surface.

Related: [[project-domain-scoped-mcx-3019]], [[feedback-dont-end-on-passive-wait]].
