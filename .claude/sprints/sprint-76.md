# Sprint 76

> Planned 2026-07-12 09:55 EDT. Target: 17 PRs.
> Amended 2026-07-12 12:54 EDT — added #2887 (git-level squash-merge gc signal) to Batch 3 as filler.
> Started 2026-07-12 12:55 EDT.

## Goal

Close the stdio/daemon session-result reliability class opened by sprint 75, and kill the CI/coverage-gate false-fail bugs that block the sprint pipeline itself.

## Issues

| # | Title | Scrutiny | Batch | Model | Provider | Category |
|---|-------|----------|-------|-------|----------|----------|
| 2858 | waitForResult rejects disconnected before workCompleted fast-path → spawn --wait misses buffered result | medium | 1 | opus | claude | goal |
| 2780 | double-panic pass-by-policy has no positive-pass evidence gate; SIGTERM exclusion unpinned | medium | 1 | opus | claude | goal |
| 2884 | mcx memory audit --json hangs indefinitely (P1 — blocks retro memory-prune) | medium | 1 | opus | claude | goal |
| 2834 | _work_items server isError:true for queryable not-found hard-exits mcx call after #2821 | medium | 1 | opus | claude | goal |
| 2759 | check-coverage per-file floor misleads when a parallel worker is silently killed (spec-count drop) | medium | 1 | opus | claude | goal |
| 2879 | proc.exited handler hangs on crash-without-frame + grandchild holding stdout fd | high | 2 | opus | claude | goal |
| 2859 | idempotency guard in handleResult() suppresses silently — add debug log + metric | low | 2 | opus | claude | goal |
| 2862 | findWorktreeRoot/findGitRoot conflate not-a-repo / missing-git / timeout into one null | medium | 2 | opus | claude | filler |
| 2555 | doing-it-wrong rule: flag `as ReturnType<typeof import(...)>` casts in *.spec.ts | low | 2 | opus | claude | filler |
| 2850 | test-partition allSpecFiles() picks up gitignored scratch specs under build/ | low | 2 | opus | claude | filler |
| 2883 | dedup RAN_FILES_RE regex (ci-steps.ts imports from coverage-report.ts) | low | 3 | opus | claude | filler |
| 2829 | artifact_check / merge_block_labels state keys leak on non-done-success terminal paths | low | 3 | opus | claude | filler |
| 2478 | sites auto-mode fallback should also trigger on 403, not just 401 | low | 3 | opus | claude | filler |
| 2603 | doing-it-wrong rule: PROVIDER_NAMES drift vs *-session-worker.ts files | low | 3 | opus | claude | filler |
| 2877 | cli-orchestration.spec.ts:554 pollUntil(5000) has zero headroom against Bun's 5s timeout | low | 3 | opus | claude | filler |
| 2553 | agent-protocol conformance rules — items 6-7 ONLY (Appendix A type-set + mirror-replay checks) | medium | 3 | opus | claude | filler |
| 2887 | git-level squash-merge detection (patch-equivalence) as a 3rd worktree-reclaim signal | high | 3 | opus | claude | filler |

## Batch Plan

### Batch 1 (immediate)
#2858, #2780, #2884, #2834, #2759

### Batch 2 (backfill)
#2879, #2859, #2862, #2555, #2850

### Batch 3 (backfill)
#2883, #2829, #2478, #2603, #2877, #2553, #2887

### Dependency edges (translate to `addBlockedBy` at run time)
- #2879 blockedBy #2858 (both edit `packages/daemon/src/claude-session/ws-server.ts` — 2858 at waitForResult ~1710, 2879 at proc.exited ~1030; serialize to avoid a shared-file rebase)
- #2883 blockedBy #2780 (both edit `scripts/_runner/ci-steps.ts` — 2780 gates the panic branch, 2883 removes the dup RAN_FILES_RE; 2883 rebases onto 2780)

### Hot-shared file watch
- `packages/daemon/src/claude-session/ws-server.ts` — #2858, #2879 (serialized via edge above). No other picks touch it (#2860/#2868 deferred).
- `scripts/_runner/ci-steps.ts` — #2780, #2883 (serialized). #2883 also reads the already-exported `RAN_FILES_RE` from `coverage-report.ts` — no edit there, no collision.
- `packages/daemon/src/claude-session/session-state.ts` — only #2859 now (#2860/#2868 deferred), no collision.
- New `scripts/rules/*.rule.ts` files (#2555, #2603) are distinct filenames — no collision with each other or #2553's conformance rules.
- `packages/core/src/worktree-shim.ts` + `packages/command/src/commands/gc.ts` — only #2887. No other pick touches either. **#2887 must keep its git primitive in `worktree-shim.ts`, NOT `packages/core/src/git.ts`** — #2862 edits git.ts (findGitRoot/findWorktreeRoot) this sprint; an additive export there is a same-file collision risk. Constraint pinned in the #2887 body.
- No dispatch-table (main.ts / router / registry) collisions among these picks.

### Pre-session clarifications required
- **#2879**: design-sensitive. The bounded `reader.cancel()` guard for the abnormal-exit sub-case must NOT reintroduce a wall-clock delay — #2825 banned that pattern (the ws-server-stdio-load drain-timeout regression). Gate the cancel on "no result expected", not on a timer. High scrutiny → adversarial + QA.
- **#2860 rescope note (deferred, not picked)**: its Option B docstring already landed; only Option A (actual lastEmittedNumTurns persistence) remained, and that needs design — deferred.
- **#2553**: scope is **items 6-7 only** (the two conformance lint rules: Appendix A event/message inventory validated against `BASE_WORKER_EVENT_TYPES` + per-provider `CONTROL_MESSAGE_TYPES`; and `forwardSessionEvent` symmetry across providers). Doc-polish items 1-5 are a stretch goal, not required for QA pass.
- **#2887** (high scrutiny — data-loss risk): the new git-level squash signal deletes non-ancestor branch tips with `git branch -D`. A false-positive patch-equivalence match that force-deletes committed-but-unpushed work is the worst-case regression. MUST preserve the #2662 skip buckets (dirty / active-session / `isAheadOfForge`-unpushed → `skippedUnpushed`) and ship a spec for the ahead-of-forge and genuinely-unmerged-lookalike cases. Port theshadow27's existing validated script (source pending in the #2887 comment) rather than re-deriving. Keep git plumbing in `worktree-shim.ts` (see hot-shared note).

## Context

Sprint 75 shipped "orchestrator reliability — stdio drop/hang class, monitor blind spots, phase-lock". This sprint drains the residual session-result reliability follow-ons it spawned (#2858, #2859, #2879) plus the CI/coverage-gate false-fail bugs that directly cost every worker diagnostic time (#2780, #2759, #2883, #2850, #2877). Recon closed #2881 (fix already on main) and deferred #2860/#2868 (partial/unreachable), which dissolved the ws-server/session-state serialization pinch — the session cluster is now cleanly parallelizable except the two documented edges. #2884 is P1: the memory-audit hang blocks the retro's memory-prune step, so it lands in Batch 1.
