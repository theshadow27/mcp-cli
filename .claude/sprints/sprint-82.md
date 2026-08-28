# Sprint 82

> Planned 2026-08-28 19:10 EDT. Target: 15 PRs.

## Goal

**Close the reconciler loop**: the daemon ticks `mcx phase advance` on its own,
and every exception reaches the supervisor's mailbox — the first sprint in which
the orchestrator is a subscriber rather than the clock.

This is MVP-2 and it drives directly at north-star #2577: *every issue / review /
QA / transition is an independent session run to completion; the supervisor
context is alerted on exceptions only.* The decision layer already exists — all
seven phase handlers are pure functions and `mcx phase advance` (#1942 D1) is a
correct single reconcile tick. What is missing is a **clock** (nothing calls it)
and a **mouth** (exceptions emit into the void). Sprint 82 builds both, plus the
four defects that would make an unattended tick silently wrong.

## Issues

| # | Title | Scrutiny | Batch | Model | Category |
|---|-------|----------|-------|-------|----------|
| 3274 | feat(daemon): phase-reconciler ticker — call `mcx phase advance` on events + periodic resync | **high** | 1 | opus | goal — *the clock* |
| 3366 | phase advance swallows failed-spawn stderr/stdout, leaves pending sentinel set | medium | 1 | opus | goal — ticker prerequisite |
| 3393 | impl phase does not record `worktree_path`; review/qa spawn a fresh main checkout | low | 1 | opus | goal — ticker prerequisite |
| 3178 | mcx mail: any unknown positional is treated as a recipient — mistyped verb sends an empty message | low | 1 | opus | goal — hardens the mouth |
| 3245 | work-item-poller re-emits ci.started/ci.finished every sweep for already-merged PRs | low | 1 | opus | goal — ticker thrash source |
| 3272 | feat(daemon): exception sink — route needs-attention + automation.escalated to supervisor mail | **high** | 2 | opus | goal — *the mouth* |
| 3182 | No quota.window_reset event — daemon knows resetsAt and never says when work can resume | medium | 2 | opus | goal — loop self-resume |
| 3357 | derived events publish with no domainId — `phase.changed` lands at domain 0, dropped by every `-d` filter | low | 2 | opus | goal — ticker's own signal |
| 3387 | work-item poller: no event when a PR head has zero check-runs (dropped synchronize stalls the loop forever) | medium | 2 | opus | goal — exception producer |
| 3311 | mcx version: show client + daemon build commit so a stale daemon is visible at a glance | low | 2 | sonnet | **QoL 1/2** — mechanical: `daemonCommit` already crosses IPC, needs display only |
| 3398 | automation dispatchers are built once at daemon startup — a domain registered later gets none | **high** | 3 | opus | goal — `bind` module registration |
| 3361 | mcx phase run --no-execute prints "approved: impl → done" but does not move the phase | low | 3 | opus | filler |
| 3386 | mcx claude bye: no warning when the session's worktree has unpushed commits | low | 3 | opus | **QoL 2/2** — stranded a QA-verified commit in sprint 81 |
| 3151 | ipcCall's timeoutMs does not bound ensureDaemon() — a wedged daemon costs ~15s per call | low | 3 | opus | filler |
| 3202 | cli: mcx serve kill silently discards undeclared flags on a destructive command | low | 3 | sonnet | filler — mechanical: swap hand-rolled parsing for `parseFlags` |

**Scrutiny mix: 3 high / 3 medium / 9 low (20% / 20% / 60%).** High sits at the
cap, so per the plan.md rule each one is justified individually — operator
sign-off recorded below:

- **#3274 (ticker)** — gated class (spawn path). It is the thing that causes
  sessions to be spawned with no human in the loop. A defect here either wedges
  every sprint from now on or spawns in a loop.
- **#3272 (exception sink)** — the whole "alerted on exceptions only" premise is
  false if this silently drops. Novel design, and nothing downstream will notice
  its failure, because noticing is exactly its job.
- **#3398 (dispatcher staleness)** — gated class (isolation). Automation state
  misattributed across domains; sibling #3407 shows `forRoot()` already
  misattributes when dispatcher count < domain count.

The other twelve are mechanical or narrow, however visible: no adversarial
round, QA only.

**Operator sign-off on the mix:** approved 2026-08-28 at planning — all three
high-scrutiny picks confirmed (#3274 spawn path, #3272 novel + self-silencing
failure mode, #3398 cross-domain isolation). No mid-sprint gates.

## Batch Plan

### Batch 1 (immediate)
#3274, #3366, #3393, #3178, #3245

### Batch 2 (backfill)
#3272, #3182, #3357, #3387, #3311

### Batch 3 (backfill)
#3398, #3361, #3386, #3151, #3202

### Dependency edges

- #3272 blockedBy #3274 (both wire `packages/daemon/src/index.ts`; the ticker
  scaffold must exist before the sink subscribes alongside it)
- #3398 blockedBy #3272 (third writer to `index.ts` — strictly serial)
- #3361 blockedBy #3366 (same file, `packages/command/src/commands/phase.ts`;
  #3366 is on the automated path and goes first)
- #3387 blockedBy #3245 (same file, `packages/daemon/src/github/work-item-poller.ts`;
  #3245 is the narrow filter fix and may clarify #3387's detection branch)

**Foundation-first:** #3272 and #3398 do not launch until their base is *merged*,
not merely open. If #3274 absorbs review rounds, #3398 is next sprint's plan —
that is the correct outcome, not a capacity failure.

### Hot-shared files

| File | Issues | Handling |
|------|--------|----------|
| `packages/daemon/src/index.ts` | #3274 → #3272 → #3398 | strict serial chain (above) |
| `packages/command/src/commands/phase.ts` | #3366 → #3361 | serial |
| `packages/daemon/src/github/work-item-poller.ts` | #3245 → #3387 | serial |
| `packages/core/src/monitor-event.ts` | #3182 (new event kind), possibly #3274 | **no serialization** — different lines, but both may add an event type to the same union. On the first merge, broadcast a targeted rebase directive: "rebase AND check for a duplicate event-kind entry you added in parallel." |
| `.claude/phases/*-fn.ts` | #3393 (impl-fn), #3272 (needs-attention-fn) | different files; same review context only |

Per plan.md, **this analysis is re-run on every amendment** — a mid-sprint
addition gets its predicted files diffed against all in-flight issues before it
launches.

## Run pre-flight (carried debt, do before batch 1)

1. **13 work items sit at `phase: done`** from sprints 80–81 with merged PRs.
   Untrack them **by issue number only** (#3240: `mcx untrack <pr>` resolves
   by-PR first and deletes a different item than the number typed).
2. **`d2:#3333` is stranded at `phase: impl` with no PR** and #3333 is genuinely
   still open (PR #3346 said `refs`, not `fixes`). It is NOT in this sprint.
   Once #3274 lands, a reconciler tick would re-spawn impl on it — untrack it, or
   the ticker's first act is to start work nobody planned. This is the sprint's
   own dogfood hazard and must be closed before #3274 merges.
3. Branch `chore/3333-bun-140-pins` holds a partial attempt at #3333 — check it
   before anyone re-implements that tail.

## Context

MVP-1 shipped: v2.0.0 was cut at `184d1578` on 2026-08-28 with all four platform
artifacts, discharging the release hold that spanned sprints 66–81. The
state.db→mcx.db migration is finished and the importer ships as the upgrade path.

That clears the way for MVP-2, which is what this sprint is. The framing to hold
onto: **we are not building a reconciler, we are connecting one.** The decision
functions are correct and tested; sprint 82 gives them a clock and a mouth and
then fixes the four things that would make an unattended tick lie — a swallowed
spawn error (#3366), a review pointed at the wrong worktree (#3393), a
`phase.changed` dropped by its own domain filter (#3357), and a merged PR whose
CI events replay forever (#3245).

**Risks.** (a) #3274 is the single point of failure for the batch-2 and batch-3
chains; if it stalls, six issues stall behind it. (b) The ticker is the first
thing this project has built that acts without being asked — the pre-flight
untrack of `d2:#3333` is not bookkeeping, it is the difference between a first
tick that does nothing and a first tick that spawns an unplanned session.
(c) Sprint 81 stalled ~17h on a silent monitor filter; the tell was a 0-byte
output file. Check output size before concluding nothing is happening.

**Deliberately excluded**

| # | Why |
|---|-----|
| 3284 | Root cause still being narrowed across 6 comments through sprint 81 — not a clean ticket. Do #3245 first; re-evaluate after. |
| 3229 | Operator's own comment corrects the premise (most of the machinery exists via `mcx track`). Needs re-scoping, not a slot. |
| 3396 | `needs-attention`, no diagnosis yet. Ironically the exact class #3272 should someday catch — but unscoped today. |
| 3367 | Requirements moved twice in comments (event → metric → wrapper interception). Moving target. |
| 3385, 3377, 3331, 3334 | All four land in `work-items-server.ts` — a four-way file seam that would need its own serial chain. Off the critical path; batch them into one sprint later. |
| 3369, 3288, 3203, 3230 | Real DX gaps, but the QoL budget is 2 and #3311/#3386 are the two that have actually cost sprint time. |
| 3061 (pass 2) | Meta. The low-risk half applied at planning (PR #3412); the structural pass waits until a few sprints have run clean. |
| 3333 | Carried from sprint 80. Not loop-aligned; see pre-flight note 2 — it needs untracking, not implementing, this sprint. |
