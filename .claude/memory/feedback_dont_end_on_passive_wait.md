---
name: dont-end-on-passive-wait
description: "Never end an orchestrator turn on a passive event-wait that may not fire — Monitor bound to an orphaned daemon goes 6h blind, ~400k tokens recomputed"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: a81bdc87-9910-4c6d-b635-8ad10f93d64f
---

Do not end a turn (or hand off control) by sitting on a passive event-wait
(`Monitor`, `mcx claude wait`, ScheduleWakeup) when the upstream signal might
never fire. If the daemon dies, gets orphaned, or the producer crashes, the
wait blocks silently — the 5-minute Anthropic prompt cache expires, and the
next legitimate wake re-processes the full conversation context at full
price. Sprint history has at least one ~6-hour blind window from this
shape (~400k tokens of cache miss).

**Why:** Monitor / ScheduleWakeup / `mcx claude wait` are *push* surfaces.
They are correct when something will definitely push to them. They are
*dangerous* as turn terminators when correctness depends on a producer
that may have crashed, been killed, or never started. The orchestrator
cannot tell "silence because nothing happened yet" from "silence because
the producer is gone" without an active check.

**How to apply:**
- Drive actively: poll bounded windows (≤ 270s to stay in cache), check
  state, then re-arm the wait. Bounded polls survive producer death;
  unbounded waits don't.
- Before arming a long Monitor, sanity-check the producer is alive:
  `mcx status` for the daemon, `mcx claude ls` for sessions you expect
  to emit.
- The `Monitor` tool's persistent stream IS fine — but only because
  task-notifications are harness-backed and survive daemon restarts; the
  failure mode is the daemon never emitting, which the orchestrator
  catches by acting on the *task list* state in parallel.
- See related: [[feedback-schedulewakeup-orchestration]],
  [[feedback-background-task-notify]],
  [[feedback-context-rot]].

Original incident logged in sprint 64 plan (2026-05-26).
