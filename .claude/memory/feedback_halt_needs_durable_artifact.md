---
name: feedback-halt-needs-durable-artifact
description: When you halt or freeze a sprint, write a durable artifact — markdown prose is read by nobody
metadata:
  type: feedback
---

When an orchestrator halts — quota freeze, operator stop, blocked-on-X — writing the resume plan into the sprint markdown file is **not** a handoff. Nothing polls markdown. Put the halt somewhere a future context can find it without being told to look: a comment on the container PR, a work-item row, a `ScheduleWakeup`, or an issue. Then say in your final message that the sprint is halted and what owes a resume.

**Why:** sprint 77 froze at 2026-08-03 13:52Z. The orchestrator wrote a correct, numbered, act-in-this-order resume plan into `.claude/sprints/sprint-77.md` and stopped. Its context ended, taking the only thing that knew about the resume trigger with it. Nothing detected the stall for **19 days**: no Results section, no retro, container PR #2923 left draft, and PR #2964 sitting CI-green at `review:changes` for 17 days with a completed re-review nobody read. Filed #3031 (stranded-PR detector), #3032 (draft container PR liveness), #3033 (halt has no durable resume state).

**How to apply:** before ending a turn on a halt, ask "what would find this if I never come back?" If the answer is "someone opens a markdown file", that is not an answer. Also: never end a turn on a passive wait when the producer might be dead — see [[feedback_dont_end_on_passive_wait]]. Related: [[feedback_quota_status_staleness]] (the meter that caused this freeze reads 8% while critical), [[project_sprint_operator]] (the reconciler arc, #1942/#2577, is the structural fix).
