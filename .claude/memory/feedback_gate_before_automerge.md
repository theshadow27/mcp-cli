---
name: feedback-gate-before-automerge
description: Decide whether a dispatched fix needs a review gate BEFORE briefing the author, because arming auto-merge forfeits the gate
metadata:
  type: feedback
---

**Do not tell a worker to arm auto-merge on a change that needs a review gate.** Decide at
dispatch time whether CI is a sufficient arbiter; if it is not, say so in the brief and hold
the merge.

**Why:** on 2026-08-22 I dispatched the #3063 P1 fix with *"open a PR against main with
`fixes #3063`, and let auto-merge and CI be the arbiter"* — correct default for a routine
fix. But the change moved the **isolation boundary** (`ContainmentGuard` on the stdio
transport). I later commissioned an adversarial review as though I still had a decision to
make. CI went green, auto-merge fired, and #3116 landed while the reviewer was still
reading. The review became post-hoc commentary instead of a gate — recoverable only because
the change was a net security improvement over the outage it replaced.

The pressure that produced it is worth naming: the fix ended a total outage, so every
instinct said *land it*. That is exactly when a gate matters most, and exactly when it is
easiest to give away by accident in a sentence of boilerplate.

**How to apply:** at dispatch, classify the change.

- *Routine* — arm auto-merge, CI is the arbiter. The default.
- *Gated* — anything touching security, isolation/containment, auth, the DB schema, or the
  spawn path. Brief says: **open the PR, do NOT arm auto-merge, report back and wait.** The
  dispatcher merges after review.

A merged fix is also **not live** until `bun run build && mcx daemon reload`, and reload
refuses to orphan live sessions (#2509) — so on a busy box a merge changes nothing until the
next drain window. Tell the orchestrators explicitly, or one of them will read the merge and
switch back to the broken incantation. See [[project-domain-scoped-mcx-3019]].
