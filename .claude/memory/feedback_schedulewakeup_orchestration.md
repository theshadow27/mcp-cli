---
name: Wait on the monitor stream + its heartbeat, not ScheduleWakeup
description: During active orchestration, wait on the `mcx monitor` event stream (the default primitive), not ScheduleWakeup or `mcx claude wait`. Rely on the stream's `heartbeat` event to observe wall-time and catch a silent worker.
type: feedback
originSessionId: 517b04ce-04d8-47dd-9d3e-d9a3d3574dd0
---
`ScheduleWakeup` is a harness feature for self-paced `/loop` work: a fixed delay (60–3600s) before re-entering the prompt. It is **blind** — it cannot unblock early when a session event arrives.

**During `/sprint` run, wait on the `mcx monitor` event stream — not ScheduleWakeup, and not `mcx claude wait`.** `mcx monitor` is the canonical primitive (`run.md` is authoritative for the exact invocation and the event catalog). `mcx claude wait` is legacy interactive CLI that loses the pre-enriched event payloads.

**Why a fixed delay loses:** if a worker hits a plan-mode prompt 30s into a 270s ScheduleWakeup, the orchestrator sleeps 4+ more minutes while sessions sit idle — you get the throughput of the slowest *planned* check, not the fastest *actual* event. The monitor stream is push-shaped: each event lands as a notification the moment it happens.

**Observe wall-time via the `heartbeat` event.** A pure event stream goes quiet when nothing is happening, so the orchestrator loses its sense of elapsed time and can't notice "this worker has been silent for 20 minutes." The monitor stream emits a periodic `heartbeat` event for exactly this — use it as the wall-clock tick to trip a staleness check on a too-quiet session. (A worker that silently wedged and was never noticed contributed to the sprint 69/70 collapse — the orchestrator must be able to see time passing, not just events arriving.)

**ScheduleWakeup is correct only for genuinely-idle states** where no sessions are running and nothing external will change before a known time — e.g. a quota pause sleeping to `resetsAt`. Even then, the monitor stream's own timeout handles "nothing happening" fine.

Flagged by the user during sprint 32 (originally about `mcx claude wait`); updated post-sprint-70 once `mcx monitor` became the default and `mcx claude wait` was demoted to legacy.
