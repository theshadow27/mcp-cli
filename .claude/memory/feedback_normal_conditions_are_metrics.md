---
name: feedback-normal-conditions-are-metrics
description: Normal recurring operating conditions belong in _metrics as counters, never repeated per-occurrence into the mcx monitor event stream
metadata:
  type: feedback
---

A **normal** operating condition — one where the system retries and makes progress on
its own — must be tracked as a **metric** (counter/gauge in `_metrics`), not emitted as
a per-occurrence event on the `mcx monitor` stream. Operator, sprint 81, on
`worker.ratelimited`: *"rate limit is normal, and should just be tracked as a metric,
not repeated literally into the stream."* They also noted it had been irritating for
"a bit too many sprints."

**Why:** an event stream is for things that change what the orchestrator does next. A
normal condition repeated per retry (`worker.ratelimited` fired ~1 event / 5s / session
at `severity: urgent`, with account quota at 12%) drowns the actionable events and
forces the orchestrator to grep the whole event type out — which then costs it *all*
visibility into that signal, including real escalation. Filtering-to-survive is the
tell that the event should never have been an event.

**Shape it as a ratio, not a count.** Operator, same conversation: the number of
rate-limit events depends on the Claude account type behind the session (Max / Pro /
API key / Bedrock all differ wildly for identical work), so an absolute counter is not
comparable across boxes or accounts. Count rate-limited vs non-rate-limited responses
*per context* and expose the ratio; also log whatever quota detail the signal itself
carries instead of discarding it. This is backpressure telemetry — it exists so the
harness can modulate concurrency, not so anyone gets paged.

**Intercept at the wrapper, not downstream.** Operator, same conversation: the
absorption point is where the wrapper consumes frames from the provider process
(`packages/daemon/src/claude-session/ws-server.ts`, `case "session:rate_limited"`) —
convert to the metric there and propagate no further. "No further" explicitly includes
the UI: the monitor stream, the per-session log ring buffer behind `mcx claude log`,
and `mcpctl` session views. Consumer-side filtering is the anti-pattern; it makes every
consumer independently learn to ignore the thing, and the only move left to the
orchestrator is to `grep -v` the whole type out and lose the signal for good.

**How to apply:** when reviewing or designing an event producer, ask whether the
condition is self-resolving. If yes → counter in `packages/daemon/src/metrics.ts`,
readable on demand. If a stream event is genuinely warranted, emit on **state
transition** (entering / leaving a sustained condition), never per occurrence, and
reserve `urgent` for things that actually block. See [[feedback_quota_status_staleness]]
— the rate-limit badge is soft backpressure, not a hard block — and
[[feedback_worker_escape_hatch]] for what the stream *is* for.
