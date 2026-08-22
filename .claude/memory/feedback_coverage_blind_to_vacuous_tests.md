---
name: feedback_coverage_blind_to_vacuous_tests
description: coverage cannot see tests/guards that report healthy about code that never runs — a rising number is camouflage, not evidence (#3201)
metadata:
  type: feedback
---

Sprint 78 measured it: **14 of 18 repair rounds** cited one defect class as a driver of a
blocker (78%), it **dominated 9 of 18**, and it caused **2 of 2 QA fails**. Both figures
are a floor. It is the dominant cost centre, not a quality-of-life concern — it comes out
of goal budget. Filed as **#3201**; four shapes:

1. **tautological test** — expectation derived from the same source as the code
   (`domain-resolver.spec.ts:99-105` loops 2000 paths then asserts a literal — *passes
   identically if the loop never ran*)
2. **guard or branch that cannot execute** (a cross-domain guard deletable with 216 tests
   green; its only coverage was a `fakeDb` state a real `StateDb` cannot produce)
3. **vacuously-satisfied success signal** (`ran:true` / `totalCopied:0`, marker written)
4. **assertion with no assertion power** ("tests nothing", "asserts nothing about the bound")

**Why:** **coverage measures that a line ran, not that anything would have noticed if it
hadn't.** All four shapes execute the line. `domain-server.ts` reported **98.29% line
coverage** with three guards freely deletable on a green suite. **A rising coverage number
is not evidence against this class — on #3181 it was camouflage**, and tests written to
move the number are the ones most likely to assert nothing.

**How to apply:**
- Never accept "coverage went up" as an answer to a finding of this class.
- Verify a guard by **deleting it and running the CONCRETE-class specs**. Nothing red ⇒
  the guard is unreachable, or the fake is wrong. A mutation run against a fake-based spec
  only proves the fake is wired to the guard.
- Reviewers cause half of it: **"verify by driving it, not by reading it, and state in the
  PR body that you verified it."** Dave introduced this mid-sprint 78 at ~08:10 after a QA
  fail where a reviewer declared a path unreachable *by reading it*; verdict language
  visibly changed by ~13:30. Standing clause, not a per-brief re-authoring.
- **The objective is not "fewer defects" — it is "defects that do not survive round 2."**
  Shapes 1-3 recur *within one PR across rounds*; that recurrence, not the initial defect,
  is what makes four-round PRs and eats the wall-clock.

Related: [[feedback_sprint78_audit_lessons]], [[feedback_verify_investigation_hypothesis]].
