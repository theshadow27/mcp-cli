---
name: rate-limited-send-first
description: "Rate-limited worker sessions are revived with a send, never a restart; sessions may also have finished with unrecorded bookkeeping"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 235f1eb0-e362-4577-b6fc-10766581b80f
---

When a quota exhaustion interrupts worker sessions mid-sprint, a rate-limit result frame ends the session's turn but preserves the session and its context. After the window resets, `mcx claude send <id> "limit reset, resume where you left off"` continues from full context — sprint 76 revived all 6 interrupted sessions this way with zero restarts and zero lost work.

**Why:** Restarting by session id re-pays the entire context ($3–7/worker observed) and risks divergent re-implementation; the send costs one turn.

**How to apply:** After a limit reset: (1) `mcx claude log <id> --tail` each idle session first — some finished *before* the limit and only lost their work-item bookkeeping (branch/prNumber never written; backfill via `work_items_update` then run normal triage), (2) send a resume nudge to the truly interrupted ones, (3) only consider respawn if a nudged session errors. Related: [[feedback-schedulewakeup-orchestration]], [[quota-status-staleness]].
