---
name: model-tiers-no-fable-dev
description: "Model tiers: opus implements; sonnet reviews and runs mechanical tasks; fable never for implementation/QA and no session left idle-hot"
metadata:
  type: feedback
---

Model assignment for sprint work:

- **Implementation: opus.** A plan table may assign sonnet to a specific
  *mechanical* item (scripted rebase, gate run, issue filing) with stated
  reasons; it may not change the implementation default.
- **Review: sonnet, including the gated class.** Scrutiny raises review
  *rigor* (adversarial panel, mutation checks), not model tier. A reviewer
  outclassing the implementer is inverted spend.
- **Sonnet never for diagnostic or tricky work** (hang diagnosis, hard
  debugging, subtle races) — that is opus work.
- **Fable: never for implementation or QA** unless the operator specifically
  authorizes it; its role is long-horizon planning/orchestration.
- **No session of any tier idles hot.** Sessions that sit open re-processing
  cache burn 100ks of tokens producing nothing; end the turn or the session.

**Why:** operator ruling, sprint 79. The originating incident: fable sessions
spawned for implementation and QA and left open for 100ks of tokens.

**How to apply:** check the model on every Agent/spawn call against the list
above; challenge a plan whose table deviates at plan time, not mid-sprint.
Related: [[orchestrator-follows-sprint-skill]].
