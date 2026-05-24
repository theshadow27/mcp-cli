---
name: feedback_guidance_names_cause
description: "Rule/remediation guidance must name the underlying cause, not just prescribe the move (\"do X\")"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: dbb5c82e-1515-4d5f-a989-0c11c9732fbf
---

When writing rule guidance (`scripts/rules/*.rule.ts`), fix instructions, or any "how to do it right" text: **name the cause and the failure mode, then give non-exhaustive examples.** Do not just prescribe a move.

**Why:** A `test-filtered-assertion` fix-agent burned nine paragraphs deliberating between two prescribed options because the guidance said "do A or B" without saying *why*. My first correction made it MORE prescriptive ("don't deliberate, do A") — which missed the point: a recipe leaves the implementer pattern-matching instead of understanding, so they can't generalize or recognize the exception. The user's framing: explain the principle (e.g. "filtering is subtractive — anything you filtered out can never fail the test, so it proves absence-of-the-bad-thing, never correctness") and the reader derives the right move themselves.

**How to apply:** Lead guidance with the mechanism of harm. For helper-adoption rules (e.g. no-raw-spawn), explain what the helper handles so the cost of reimplementing is visible ("re-owning every corner case, for everyone") and make "extend the helper" obviously right vs. suppressing. Then: "examples of doing it right (not exhaustive): ...". See [[feedback_review_churn_simplify]] for the related "explain why, don't patch" theme.
