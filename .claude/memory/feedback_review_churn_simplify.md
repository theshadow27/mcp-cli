---
name: feedback_review_churn_simplify
description: "Repeated review rounds surfacing NEW findings = convergence failure → step back and /simplify, don't keep patching"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 580f15c6-a50c-4f90-8ffc-3ca94b24ad7c
---

When a PR keeps generating **new** review/QA findings round after round (e.g. sprint 62 #2271: auth regression → 7 threads → rebase → 5 more), that is a **convergence-failure signal**, not normal iteration. The implementation is too complex or fighting the grain, and each micro-repair just exposes the next sharp edge.

**Why:** patch-by-patch on a fundamentally over-complex design is a treadmill — it burns quota/rounds and never reaches "clean." The cost compounds: every push re-triggers Copilot, which finds more surface.

**How to apply:** after ~2 repair rounds that surface *new* (not re-flagged) issues, STOP dispatching micro-repairs. Take a step back and launch a simplification pass (`code-simplifier` / "step back and simplify" prompt via `mcx claude spawn`, NOT the Agent tool — observability, see [[feedback_flaky_tests]] #2009) on the whole change: rethink to the minimal correct design that preserves functionality, cut anything not load-bearing, read the open threads as *input* but don't just patch them. Contrast with [[feedback_phase_repair_to_qa]] (normal single-round repair).

Distinct from flaky-CI churn (same finding recurring = rerun/flaky-gate). This is *new findings each round* = wrong design.

**CANONICAL HOME = `.claude/skills/sprint/references/run.md`**, in the repair/round-cap section (alongside review ≤2 / repair ≤3). This memory is a stopgap pointer; the rule was added to run.md in the sprint 62 retro. If run.md already states it, this memory is redundant — trust run.md.
