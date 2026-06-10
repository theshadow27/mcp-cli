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
  Filed via issue-author.
- **impl.ts can't see "done"**: session.idle + pushed PR still yields
  `action: in-flight`. Orchestrator bridges via resultPreview judgment → attach
  PR → invoke triage. Least-mechanized edge in the graph. Judgement call, fine
  for now; would be a 1-line check (`gh pr list --head <branch>`) in impl.ts.
- **pre-push hook misclassification**: normal commit push on sprint-71 printed
  "nothing to validate (deletion or tag push)". Filed via issue-author.
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

## Open questions to answer by retro

- Did the batch-1→backfill slot model actually beat "spawn everything
  unblocked at once"? run.md's launch policy says spawn-all; the plan's batch
  column says stage. I followed the plan (5+1 concurrent, backfill on free
  slot). Note the wall-clock cost/benefit.
- Does the #2463 nerd-snipe add value when the issue body already documents
  mechanism + 3 fix options? (Plan mandated it; the marginal value is fix-option
  adjudication. If the comment just restates the issue, the gate over-fired —
  calibration note for plan.md.)
