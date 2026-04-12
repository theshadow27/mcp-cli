---
name: ScheduleWakeup is blind polling — don't use it during active orchestration
description: In sprint orchestration, prefer `mcx claude wait` over ScheduleWakeup for monitoring spawned sessions — wait is event-driven, ScheduleWakeup is a fixed delay
type: feedback
originSessionId: 517b04ce-04d8-47dd-9d3e-d9a3d3574dd0
---
`ScheduleWakeup` is a harness feature for self-paced `/loop` work. It schedules a fixed delay (60–3600s) before re-entering the prompt.

**Don't use it to monitor spawned sessions during `/sprint` run.** Use `mcx claude wait --timeout <ms>` instead.

**Why:** `mcx claude wait` unblocks on *any* session event — idle, result, permission_request, plan-mode approval, worker asking a question. If a worker hits a plan-mode prompt 30 seconds into a 270-second `ScheduleWakeup`, the orchestrator sleeps 4+ more minutes while 5 opus sessions sit idle. That's lost throughput and possibly lost money (a stuck session can burn tokens retrying). The whole point of event-driven waits is that different threads progress at different speeds — blind polling gets throughput of the slowest planned check, not the fastest actual event.

**How to apply:** Once impl/review/QA sessions are spawned, the monitor loop should use `mcx claude wait --timeout 300000` (5 min) between every status check. The timeout is an upper bound; `wait` unblocks immediately on any session event. So a longer timeout has no throughput downside — drop to 30000 only when actively supervising a specific session. Only consider `ScheduleWakeup` for genuinely idle orchestration states where no sessions are running and nothing external is expected to change — but even then, `mcx claude wait` handles the "nothing happening" case fine via its own timeout.

Flagged by user during sprint 32 after I mistakenly scheduled a 270s blind wakeup instead of using `wait`.
