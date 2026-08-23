---
name: subagent-background-gate-not-stalled
description: "A subagent task-notification saying \"waiting for background gate/command\" is NOT a stall — the harness auto-resumes it when the background command completes; verify with ps before intervening"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 11926602-2527-443f-a31e-0063c3e37b1c
  modified: 2026-08-23T00:10:41.554Z
---

A background subagent that launches a long command (e.g. `bun run am-i-done`)
in the background and ends its turn fires a task-notification whose result
reads "waiting for the gate to finish". This is normal operation, not a stall:
the harness re-invokes the subagent when its background command exits, same as
it does for the orchestrator.

**Why:** Sprint 79 launch (2026-08-23) — I nudged both lanes via SendMessage to
"run the gate in foreground"; the user corrected me: "the agent will resume
when the background command completes. watch the process they spawn if you
don't believe me." `ps` confirmed both gates live and progressing.

**How to apply:** On such a notification, do nothing. If suspicious, verify
with `ps -eo pid,ppid,etime,args | grep am-i-done` (or the named command).
Intervene only if ~10 minutes pass with NO gate process running AND the worker
still idle — that combination is a real problem. Do not add "foreground the
gate" to lane briefs; backgrounding long gates is fine and keeps worker
context cheap. Related: [[foreground-am-i-done-unstick]] applies only to
rate-limit retry loops, not to a healthy backgrounded gate.
