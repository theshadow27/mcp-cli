---
name: Quota thresholds are for early/mid block
description: Near end of a 5h quota window, fire for effect — the 80% impl freeze is for protecting mid-block work, not end-of-block carryover
type: feedback
originSessionId: 965321f6-ed16-4eca-833b-fdee624f9368
---
Don't hold impl work at 80%+ utilization when the quota resets in <15 minutes.

**Why:** The 80% impl-freeze threshold in `references/run.md` exists to protect mid-block work from running out of budget mid-session. At the end of a block, there's no mid-session risk — either the work completes before reset, or it's mostly paid for. User explicit guidance sprint 42: "the threshold is for early/mid quota time block, but at the end, fire for effect so long as it's not going to overrun."

**How to apply:**
- Check `resetsAt` against current time before throttling. If <15 min to reset and the work is sonnet-sized (< $5 estimated), spawn without hesitation.
- If >30 min to reset and utilization ≥80%, respect the freeze — the original rule still applies.
- "Going to overrun" = work that would consume >20% of quota in a single session. If unlikely to overrun, don't hold.
- Overly literal quota gating cost us #1597 being deferred to sprint 43 when it would have merged cleanly with 7 min to reset.
