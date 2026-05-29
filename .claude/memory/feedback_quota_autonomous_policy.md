---
name: feedback_quota_autonomous_policy
description: Never raise an AskUserQuestion on quota during a sprint — sprints run unattended; quota needs a self-executing policy
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 17e9dca3-6aa4-46d0-82f2-89bea91bfcc8
---

When the 5h quota hit 100% mid-sprint (sprint 69), the orchestrator raised an `AskUserQuestion` ("wind down vs pause-and-resume vs finish-2"). That **suspended the whole context until the user happened to return — hours later, overnight — during which the sprint did nothing.**

**Why this is wrong:** sprints are frequently executed UNATTENDED. Any orchestrator decision that blocks on a human reply can stall the entire run indefinitely. Quota exhaustion is a *predictable, recurring* condition with a known reset time — it must be handled by a **defined autonomous policy**, never a human prompt.

**How to apply — quota policy is self-executing, no AskUserQuestion:**
- **≥95% / 100% (5h window):** do NOT ask the user. Either (a) `ScheduleWakeup` for the quota `resetsAt` timestamp and auto-resume the pipeline then, or (b) if the remaining work is small and extra-usage credits are enabled, finish on credits — but pick by rule, autonomously. Default to schedule-and-resume at `resetsAt` (it's in the `quota_status` payload).
- **Before pausing:** finish every no-LLM action first (flaky-CI reruns, label flips, merges of already-green PRs, byeing stuck sessions to stop credit burn), so the pause loses nothing.
- **Only escalate to the user** for genuinely irreducible choices (e.g. "abandon the sprint entirely?"), and even then prefer a safe default + a notification over a blocking question.

The general rule (from [[feedback_dont_end_on_passive_wait]] and the cache-TTL constraint): an unattended orchestrator must never convert a mechanical, policy-decidable condition into a human gate. Related: [[cpu-wedge-test-workers]] (the other sprint-69 infra fire).
