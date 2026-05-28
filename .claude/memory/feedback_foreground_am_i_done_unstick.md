---
name: feedback_foreground_am_i_done_unstick
description: rate-limited worker stuck re-launching am-i-done as a background task — tell it to run am-i-done foreground/blocking
metadata:
  type: feedback
---

When a worker is rate-limited (soft backpressure, see [[feedback_quota_status_staleness]]) AND runs `bun run am-i-done` as a **background** task it then polls via `TaskOutput`, it can wedge: each poll gets throttled before the result lands, times out, and the worker restarts am-i-done from scratch — looping for an hour+ with the cost frozen.

**Why:** Sprint 68, Eve (#2371) burned ~1.5h in exactly this loop (re-reaching am-i-done step 5 "test-parallel" over and over). #2542 hit the same backgrounding wedge.

**How to apply:** Interrupt the worker and tell it to run `am-i-done` as a **foreground blocking** Bash call with an explicit long timeout (~120s) — NOT `run_in_background` + `TaskOutput` polling. The blocking call sidesteps the poll/throttle/restart cycle; it returns once and the worker commits+pushes. This unstuck both #2371 and #2542 immediately. Also worth checking the worker rebased onto main first if pre-existing failures (e.g. a separate regression fix) are what's making its test step look stuck.
