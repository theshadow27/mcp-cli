---
name: orchestrator-follows-sprint-skill
description: "Orchestrators MUST follow the /sprint skill (.claude/skills/sprint/references/*.md) — operational how-to lives THERE, not in memory; don't improvise waiting/spawning/merging patterns from memory fragments"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 11926602-2527-443f-a31e-0063c3e37b1c
  modified: 2026-08-23T20:50:59.463Z
---

The sprint skill is the operating manual for orchestration: spawn shape,
waiting/monitor primitive, label lifecycle, merge path, session economics all
live in `.claude/skills/sprint/references/*.md` (lanes.md for the lane model).
An orchestrator session must load and follow it — and when practice diverges
from the skill, fix the skill (retro/meta commit on the sprint branch), not
route around it or grow a parallel doctrine in memory files.

**Why:** Sprint 79 (2026-08-23): operational guidance scattered into memories
("don't end on passive wait", monitor setup) caused token churn — subagents
inherited orchestrator-only rules and emitted filler no-op calls; the
orchestrator hand-rolled watchdog bash and hand-merged PRs instead of using
the machinery the skill documents. Operator: monitor setup belongs in the
/sprint skill, not MEMORY.md; those memories were deleted and their corrected
lessons folded into lanes.md (rule 8 + "Waiting on the world" section).

**How to apply:** Before orchestrating, read the sprint skill references —
they are canonical. Memories carry only what the skill/repo cannot: user
preferences, cross-project facts, open-defect warnings. Orchestrator-only
rules must never be phrased so a worker brief inherits them. Related:
[[feedback_meta_issue_planning_guard]] (meta files are orchestrator+retro
territory).
