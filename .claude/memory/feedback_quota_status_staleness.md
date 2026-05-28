---
name: feedback_quota_status_staleness
description: quota_status utilization can be stale/frozen; [RATE LIMITED] flag is soft backpressure, not a hard block
metadata:
  type: feedback
---

`mcx call _metrics quota_status` can return a **stale** reading. When the quota-stats API endpoint itself gets a `429 rate_limit_error`, the daemon can't refresh, so `utilization` stays frozen at its last value (check the `fetchedAt` field — it stops advancing) and `lastError` shows the 429. A frozen `utilization:100` is NOT proof you're at the 5h cap.

The per-session `[RATE LIMITED]` flag in `mcx claude ls` is **soft backpressure** (the SDK surfacing Claude's rate-limit signal and backing off), not a hard block — flagged sessions keep making progress (token counts advance, reviews complete).

**Why:** In sprint 68 I read a stale `utilization:100` (26 min old, frozen by the stats-endpoint 429) plus the `[RATE LIMITED]` flag and wrongly declared a "full pause until reset," nearly idling the sprint. GitHub had full headroom; sessions were progressing the whole time. The user caught it.

**How to apply:** Before treating quota as a gate, (1) check `fetchedAt` is recent and `lastError` is null, and (2) confirm whether sessions are actually stalled — look for token-delta progress in `mcx claude ls`, not just the flag. `[RATE LIMITED]` + advancing tokens = throttled-but-working; keep driving. Only a fresh, high `utilization` with genuinely frozen sessions justifies the [[feedback_quota_end_of_block]] impl-freeze.
