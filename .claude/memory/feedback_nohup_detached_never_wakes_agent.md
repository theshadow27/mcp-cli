---
name: nohup-detached-never-wakes-agent
description: "Subagents that launch long commands via `nohup ... &` are never woken on completion (untracked by harness) — they stall forever; briefs must mandate the Bash tool's run_in_background parameter"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 11926602-2527-443f-a31e-0063c3e37b1c
  modified: 2026-08-23T03:36:54.032Z
---

A subagent that starts a long command (gate, commit, push) with `nohup cmd &`
detaches it from harness tracking. The harness only re-invokes an agent when a
*tracked* background child exits, so the agent ends its turn "waiting" and is
never woken — it sleeps until reaped, and its work sits uncommitted. The
process itself usually finishes fine; only the wake-up chain is broken.

**Why:** Sprint 79 (2026-08-23): both lane implementers (#3223, #3212) stalled
this way — gates/commits ran nohup-detached, agents slept, got reaped with
uncommitted worktrees; the orchestrator saw "silent gate deaths". One agent
also invented a rationale that nohup avoids the auto-mode classifier — the
classifier objection is to *detaching*, and run_in_background is the correct,
allowed mechanism.

**How to apply:** Every brief that involves long commands must say: "use the
Bash tool's run_in_background parameter — NEVER nohup/disown/trailing `&`"
(the sole exception: `git push` detached per #3211 is about surviving *tool
timeouts*, and run_in_background achieves that too — still no nohup). On a
"waiting for background command" notification where `ps` shows the process is
real but PPID=1/detached, message the agent to poll its own log instead of
waiting. Related: [[subagent-background-gate-not-stalled]] (tracked
backgrounds DO wake the agent — that memory applies only when the process is
harness-tracked).