# Sprint 71 — orchestrator observations (Fable 5 first run)

Running log, committed incrementally on the sprint-71 branch. Raw material for
the retro: what feels Opus-shaped, what a more capable orchestrator would do
differently, blind spots in the machinery. Written by the orchestrator as
events happen — trust this over end-of-sprint recollection.

## Launch (2026-06-09 ~23:00 EDT)

- **Manual relay in spawn path**: `mcx phase run` emits spawn argv → orchestrator
  executes → parses sessionId → `phase_state_set session_id`. Three manual hops;
  the exact place #2463's "silent spawn failure" lives. Same shape as #1286
  (worktree_path auto-persist). The pipeline trusts the orchestrator's working
  memory where it could trust the DB. Filed: model-routing issue (see below).
- **Plan Model column not machine-consumed**: impl.ts emitted opus for #2645
  (plan says claude-fable-5). Canary override lived only in prose + my attention.
  Filed: #2665.
- **impl.ts can't see "done"**: session.idle + pushed PR still yields
  `action: in-flight`. Orchestrator bridges via resultPreview judgment → attach
  PR → invoke triage. Least-mechanized edge in the graph. Judgement call, fine
  for now; would be a 1-line check (`gh pr list --head <branch>`) in impl.ts.
- **pre-push hook misclassification**: normal commit push on sprint-71 printed
  "nothing to validate (deletion or tag push)". Filed: #2666 (root cause:
  empty stdin on up-to-date push falls through to the deletion/tag branch).
- zsh ate `====` as a separator in a compound command (`=== not found`) — my
  own footgun, use `echo SEP`.
- Fable canary (#2645, session e67edac7/Carol) spawned clean through pinned
  claude 2.1.119 — API/harness accepted claude-fable-5, tokens flowing within
  seconds. The plan's fallback path (file finding → opus) wasn't needed at
  spawn time. Watch: completion quality vs the opus fillers.
- All 5 launch sessions showed `[RATE LIMITED]` at 5% quota — tag is soft
  backpressure (known, feedback_quota_status_staleness) but at 5% utilization
  it's pure noise; if it's cosmetically sticky it trains observers to ignore a
  real signal later.

## First hour (03:00–03:20Z)

- **#2628 merged 12 min after spawn** (PR #2663). Pipeline at its best: impl →
  triage(low) → QA → 4-surface check → merge, fully event-driven.
- **CWD drift bit the orchestrator**: a `cd` into the sprint worktree in a
  compound command persisted across Bash calls; later `mcx phase run` read the
  worktree's committed (stale) .mcx.lock → false "lock out of date". Two real
  bugs shaken out: committed lock stale since #2570 (evidence added to #2656),
  and lock-lookup resolving cwd while transition log resolves git-common-root
  (#2673). Lesson: subshell `( cd ... )` always, or `git -C`. Also: pre-flight
  `mcx phase install` MASKS committed-lock staleness every sprint — the
  regenerated local lock sits uncommitted (git shows `M .mcx.lock`) and nobody
  ships it.
- **Nerd-snipe gate earned its cost** on #2463 — and not for the expected
  reason. It confirmed the documented mechanism (plus a second failure mode:
  RegressionError from stale history even with from=null), adjudicated the 3
  fix options with concrete reasons (version-counter unreliable because
  resolveAndUpdateWorkItem bumps it async), AND — the schedule-changing find —
  proved #2587/#2588 have NO stale log entries, so the plan's blocker edge was
  precautionary-only. Verified empirically ((initial)→impl approved for both)
  and launched the agent-grid lane ~1h earlier than the dependency graph would
  have allowed. Gate calibration answer: the value wasn't re-deriving the
  mechanism, it was option-adjudication + blast-radius mapping.
- **#2653's PR omitted .mcx.lock regen** for its phase-script changes — the
  exact #2570/#2656 mistake, caught at triage by checking the PR file list.
  Sent the implementer back. Pattern for a rule: PR touches .claude/phases/*
  → must touch .mcx.lock (mechanizable, belongs in doing-it-wrong).
- **Task graph can't un-block**: TaskUpdate has addBlockedBy but no remove;
  when reality invalidated the #2463→#2587/#2588 edges I had to spawn around
  the graph and leave a metadata note. Minor harness papercut.
- **Orchestrator nearly recreated #2463's trap**: spawned #2463's impl without
  ticking `mcx phase run impl` first (caught it one command later; recovered —
  notably the phase script handled the out-of-order bind gracefully,
  returning in-flight instead of clobbering the session binding with a
  pending sentinel).
- Fable canary completed #2645 end-to-end: PR #2672, 31 turns, $2.01,
  clean afterEach/rmSync fix. Cost roughly comparable to opus fillers
  (#2628 $0.48/18t, #2659 $0.92/33t, #2653 $1.78/58t). No harness friction
  observed from the worker side.

## Open questions to answer by retro

- Did the batch-1→backfill slot model actually beat "spawn everything
  unblocked at once"? run.md's launch policy says spawn-all; the plan's batch
  column says stage. I followed the plan (5+1 concurrent, backfill on free
  slot). Note the wall-clock cost/benefit.
- Does the #2463 nerd-snipe add value when the issue body already documents
  mechanism + 3 fix options? (Plan mandated it; the marginal value is fix-option
  adjudication. If the comment just restates the issue, the gate over-fired —
  calibration note for plan.md.)
