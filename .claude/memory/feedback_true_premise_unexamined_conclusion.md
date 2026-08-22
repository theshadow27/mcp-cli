---
name: feedback_true_premise_unexamined_conclusion
description: a true premise carrying an unexamined one — three instances in one night, every check was one command away
metadata:
  type: feedback
---

Three instances on 2026-08-22, all from different sessions, all cheaply checkable:

- **"One daemon per box"** (true) → *"therefore the co-tenant project's sessions are in it"*
  (false — they never registered; they run plain `claude`, not `mcx claude spawn`). I
  asserted it to another project's orchestrator **twice** and they built a coordination
  plan on it. One `mcx claude ls --all` disproved it.
- **"No command writes the `domains` table"** (true) → *"therefore the table is always
  empty"* (false — `importScopesAsDomains` is a non-CLI writer). That single substitution
  was the whole of #3200's RED 1, which would have broken the boss mailbox on the next
  daemon restart.
- **A case-sensitive grep returned "zero occurrences"** (correct answer) that would not have
  matched `claudeByeAll` — right by luck, not by method. Re-run case-insensitively: same
  answer, now supported.

**Why:** this is *not* the [[feedback_coverage_blind_to_vacuous_tests]] class and must not
be folded into it. That one is about artefacts in the codebase reporting health they cannot
know, and is mechanizable by a rule. This is a reasoning error in a human-readable claim,
fixable only by checking. Bundling them blunts an issue sharp enough to act on.

**How to apply:** before asserting a fact about **shared infrastructure** — what is in a
table, what a daemon manages, what another project's processes are — **run the one command
that decides it.** In all three cases the check was a single command and the wrong answer
would have propagated. Corrections also travel further than the claim: the peer had already
relayed mine to their human, so the fix propagated one hop beyond the message that caused it.

Verify with the command, not the name: cf. [[feedback_verify_investigation_hypothesis]].
