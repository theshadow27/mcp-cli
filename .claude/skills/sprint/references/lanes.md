# Lanes — the default execution model

**Status: default as of sprint 79** (operator decision, 2026-08-22). The
daemon-hosted session pipeline in `run.md` remains available as the
special-case path — see [When daemon sessions are still correct](#when-daemon-sessions-are-still-correct).

## Why this exists

The `mcx claude spawn` worker model was built when harness subagents were
fire-and-forget: unsteerable, unresumable, invisible. Every piece of the
hosted-session machinery — spawn/send/bye, mail nudges, the deck watch,
monitor polling — compensated for those gaps. The harness has since
absorbed all of them: subagents run in the background, notify on
completion, accept follow-up messages, and hold their context *off* the
orchestrator's budget.

Sprint 78 (2026-08-22) measured what the old model costs under the new
economics: ~80% of a weekly quota in 18 hours. The spend was not work —
each worker produced ~0.5–0.7M output tokens but re-processed **170–330M
cache-read tokens** staying alive; the orchestrator re-processed 621M over
17 hours with zero compactions, 75% of its tool calls status polls.
Merged workers idled hot for hours because ending a hosted session is a
lifecycle decision someone must remember to make. Harness subagents
structurally cannot fail this way: they return a result and cease to
exist. No standby, no `bye`, no deck watch, no re-brief by mail.

## The model

One orchestrator session (the `/sprint` invocation) runs **lanes**. A lane
is one issue moving through phases, each phase a **fresh subagent** (Agent
tool) in the issue's worktree:

    implementer → reviewer (if scrutiny requires) → repair (fresh) → QA → merge

The subagent ends when its phase output exists (PR opened, sticky + label
posted, qa label posted). Repair is a *new* subagent briefed with the PR,
the sticky findings, and the worktree path — never a held-open implementer.

### Rules

1. **2–3 lanes maximum.** Capacity comes from turnover, not headcount.
   Sprint 78 ran 8+ concurrent workers and serialized them anyway behind
   one foundation PR and a shared-file conflict cascade.
2. **One worktree per issue, threaded through phases** (`.claude/worktrees/issue-N/`),
   same as before. Subagents change; the worktree carries the branch.
3. **The ledger is `work_items` + PR labels + the plan file — never the
   orchestrator's context.** `mcx track`, `work_items_update`, and
   `review:*`/`qa:*` labels record every state transition, so the
   orchestrator can compact or be resumed at any time and reconstruct
   from the ledger. If a fact matters past the current turn, write it to
   the ledger, not to prose in context.
4. **Foundation-first.** Never start a lane whose base PR is unmerged.
   Stacking dependents on an unmerged foundation is how sprint 78 bought
   a rebase wave: the foundation absorbed 4 review rounds, then every
   stacked branch conflicted. Dependents of in-flight work are *next
   sprint's* candidates, not "batch 2".
5. **Seam serialization.** Issues that touch the same files form a serial
   chain within one lane, never parallel lanes. Concurrent lanes must be
   disjoint at the package/module level. (Sprint 78: five "independent"
   partition PRs all edited `docs/domains.md`, three edited `ipc.ts` —
   every pair conflicted.) Shared docs files get one trailing docs commit
   per merge, not five concurrent editors.
6. **Scope freeze.** The orchestrator never adds scope to a lane
   mid-review or mid-repair. New scope = new issue, next sprint. (Sprint
   78: an orchestrator-injected then-withdrawn SIGINT handler cost 2 of
   one PR's 5 review rounds — its single most expensive self-inflicted
   mistake, by its own retro.)
7. **Round caps bind the orchestrator, not just phase scripts.** Review
   ≤ 2, repair ≤ 3, qa:fail ≤ 2 — hand-orchestrated rounds count. Past a
   cap: stop, label `needs-attention`, escalate to the operator with a
   one-paragraph decision request. A PR blocked on a design decision or
   an unmerged base gets **zero** further review rounds while blocked —
   re-verifying a stale verdict is spend with no information gain.
8. **Session economics.** No session — subagent, daemon-hosted, or the
   orchestrator itself — sits idle-hot waiting. If the next action is
   "wait for X", record the resume point in the ledger and end the turn
   (or the session). The orchestrator reacts to task notifications and
   monitor events, and never polls in a loop.
9. **Model mix.** Implementers per the plan table. Reviewers default
   sonnet; opus/fable review only for the gated class (security,
   isolation/containment, auth, DB schema, spawn path) or where the plan
   marks high scrutiny. The opinion-agent panel in
   `adversarial-review.md` runs only on round 1 of gated-class reviews.

### What replaces the old machinery

| Old (run.md pipeline) | Lane model |
|---|---|
| `mcx claude spawn` + brief | `Agent(...)` with the brief as prompt, worktree isolation |
| `mcx claude send` nudges, mail escape hatch | Task notification on completion; `SendMessage` to a live subagent for a genuine mid-flight redirect |
| `mcx claude ls` / deck watch / stuck heuristics | Background-task tracking; a subagent that dies mid-task surfaces as a failed task, not a silent zombie |
| `bye` discipline, standby, worktree handoff rules | Subagent ends itself; worktree persists on disk |
| Monitor stream as orchestrator heartbeat | Still available for PR/CI events; no longer the liveness channel for workers |

`mcx` keeps the roles the harness does not fill: the work-item ledger, PR/CI
event polling, phase-transition validation, quota status, and inter-session
mail *between top-level sessions* (e.g. two orchestrators on one box).

## When daemon sessions are still correct

- **Non-Claude providers** — copilot / gemini / codex / ACP / opencode
  workers have no harness subagent equivalent.
- **Work that must outlive the orchestrator** — multi-day arcs, cross-
  machine (sprite) execution, or anything the operator may want to attach
  to interactively later (don't-bye-spikes still applies there).
- **Operator-interactive investigations** — a session the human wants to
  talk to afterward.

For these, `run.md` + `mcx-claude.md` remain the authority — including
their `bye` discipline, which exists precisely because hosted sessions
don't end themselves.

## Note on #2009 (investigations spawn shape)

The standing rule "nerd-snipe gates must use `mcx claude spawn`, NOT the
Agent tool" (`investigations.md`, locked in after sprint 52) was grounded
in the Agent tool's then-total lack of observability and steering. That
objection is resolved: background subagents notify on completion and
accept `SendMessage` mid-flight. Investigations may run as lanes. The
`mcx claude spawn` shape remains valid when the operator wants to attach
to the investigation interactively.
