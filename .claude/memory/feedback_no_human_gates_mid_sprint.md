---
name: no-human-gates-mid-sprint
description: "A sprint must run unattended end-to-end — never park sprint work on operator confirmation mid-sprint; approvals live in planning, surprises spike to next planning, catastrophes spike the sprint"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 11926602-2527-443f-a31e-0063c3e37b1c
  modified: 2026-08-24T14:02:24.552Z
---

Operator ruling (2026-08-24, sprint 79): **nothing in a running sprint may wait
on the human.** "That's the whole point of the sprint. It should be able to run
unattended, end to end, without human intervention."

**Why:** a mid-sprint operator gate is both a planning failure (the approval
should have been secured — or the item excluded — at plan time) and an
operational failure (the orchestrator should have spiked it out instead of
parking it). The plan IS the approval; re-confirming it mid-sprint re-litigates
a decision already made and silently stalls a lane for hours or days.

**How to apply:**
- All human approvals happen at `/sprint plan` time. If an item needs a call
  the operator hasn't made, it doesn't enter the sprint.
- Something unexpected mid-sprint (quota doubt, scope surprise, missing
  decision) → **spike it to next planning** and keep the sprint running. Record
  the spike in the sprint file's amendments.
- If the surprise is catastrophic to the sprint itself → spike the sprint:
  wind down, and call it out in the retro. Never idle waiting for the human.
- Precedent: sprint 79 lane 2 (#3047/#3048) was parked "pending operator quota
  confirmation" — improvised hold, plan had already authorized it; resolved by
  spiking to sprint-80 planning.
- The `/sprint` skill did not state this explicitly at the time — retro item to
  write it into `references/plan.md`/`lanes.md` (meta change, retro workflow).

Related: [[halt-needs-durable-artifact]], [[orchestrator-follows-sprint-skill]].
