---
name: Orchestrator context rot happens before hard limits
description: A long-running orchestrator degrades quality at ~300k+ tokens well before the 1M hard cap; don't trust "done" claims from prior sessions without a probe.
type: feedback
originSessionId: 7ce02575-8a4f-4a38-81f0-a5833209fa76
---
Sprint 35 re-plan was triggered because the prior orchestrator (at ~345k
tokens of context) released v1.5.0 asserting the phase pipeline was
"ready." It wasn't — `--dry-run` was stripped globally, autonomous
execution was unimplemented, and the orchestrator loop in `run.md`
silently no-op'd. Pre-flight for the next sprint caught it.

**Why:** Model quality degrades gradually as context grows — not a hard
failure, a subtle drift. Long-context assertions ("this is done", "we
validated X") become less reliable well before the 1M cap. The prior
orchestrator wasn't lying; it was contextually-fatigued and missed
verifying its own claims.

**How to apply:**
- If inheriting from a prior sprint/orchestrator, treat "done" claims
  as hypotheses, not facts. Run one probe before planning around
  them (e.g. `mcx phase run ... --dry-run` must print handler JSON).
- For release candidates, require an end-to-end smoke test that
  exercises the claimed feature from a fresh process.
- During long runs, break into shorter-lived sessions with explicit
  pass/fail checkpoints (Stage A → Stage B pattern from sprint 35).
- When you find yourself summarizing work at 300k+ tokens, bias
  toward "let me verify" rather than "this is done."
- Retro captures this as a warning sign; the next sprint's pre-flight
  is the mitigation.
