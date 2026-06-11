# Sprint 72

> Planned 2026-06-10 09:05 local. Target: 15 PRs.

## Goal

Close the trust boundary sprint 71 exposed: enforce containment for every worker
write path, finish the verdict-pipeline fail-closed mop-up, and turn the hidden
test gates back on (fn-specs in CI, done-fn repair) — while dogfooding the stdio
transport at sprint concurrency (#2688).

## Issues

| # | Title | Scrutiny | Batch | Model | Provider | Category |
|---|-------|----------|-------|-------|----------|----------|
| 2693 (+2520) | ContainmentGuard Edit/Write path-check not enforced + fail-open for unrecognized tools | high | 1 | opus | claude | goal |
| 2683 | NaN epoch timestamp silently disables fail-closed guards in validateVerdictLabel | low | 1 | opus | claude | goal |
| 2692 (+2571) | done-fn.spec.ts: 7 failing stub-drift tests + broken mergePr mocks (same file, one PR) | low | 1 | sonnet | claude | goal |
| 2681 | claude-binary race + per-spawn binary/transport override (enables #2688 canary) | medium | 1 | opus | claude | goal |
| 2685 | pruneStaleHistory file rewrite not atomic (write-to-temp + rename) | low | 1 | fable | claude | filler |
| 2519 | ContainmentGuard not enforced for codex/acp/opencode worktree sessions | medium | 2 | opus | claude | goal |
| 2682 | phase_state_set has no ACL — any session can overwrite sentinel keys | high | 2 | opus | claude | goal |
| 2686 (+2687) | Array.isArray guard in readReviewLabels/readQaLabels + roundStartedAt typeof check (same files, one PR) | low | 2 | sonnet | claude | goal |
| 2648 | .claude/phases/*-fn.spec.ts ignored by CI; mirrors drift silently | low | 2 | sonnet | claude | goal |
| 2669 | bunTestWithCrashTolerance swallows 'unhandled error between tests' — gate passes when it should fail | medium | 2 | opus | claude | goal |
| 2654 | review-fn/qa-fn no-label-yet branch waits forever if reviewer/QA session dies | medium | 3 | opus | claude | goal |
| 2656 | phase-drift check hashes entry file only — transitive imports not covered | medium | 3 | opus | claude | goal |
| 2673 | mcx phase run: lock lookup uses worktree CWD, state paths use repo root | medium | 3 | opus | claude | goal |
| 2665 | mcx phase run ignores per-item model assignment | medium | 3 | opus | claude | goal |
| 2679 | mcx claude spawn --worktree forks from stale local HEAD, not origin/main | low | 3 | fable | claude | filler |

Paired issues (`+NNNN`) are same-file pairs: one worker, one PR, closes both.

## Batch Plan

### Batch 1 (immediate)
#2693(+#2520), #2683, #2692(+#2571), #2681, #2685

### Batch 2 (backfill)
#2519, #2682, #2686(+#2687), #2648, #2669

### Batch 3 (backfill)
#2654, #2656, #2673, #2665, #2679

### Dependency edges (translate to addBlockedBy at run time)

- #2519 blockedBy #2693 (core containment fix + fail-closed default land first; #2519 wires the guard into codex/acp/opencode workers)
- #2682 blockedBy #2683 (both in the verdict trust path — validateVerdictLabel fix merges before the ACL layer builds on it)
- #2686 blockedBy #2683 (verdict-label read path is shared)
- #2648 blockedBy #2692 (CI can't turn fn-specs on while done-fn.spec.ts is red)
- #2654 blockedBy #2686 (both edit review-fn.ts/qa-fn.ts — hot-shared)

### Hot-shared flags (no edge, broadcast rebase directive when first merges)

- #2656 / #2673 both change phase run/lock root-resolution semantics in adjacent
  files. Whichever merges second gets a "rebase AND re-check root-resolution
  assumptions" directive.
- scripts/rules/ registry: no rule-authoring picks this sprint (#2655/#2696
  deferred), so no dispatch-table collision risk there.

## Run-phase directives

- **#2688 stdio canary (arguably P1, from sprint-71 retro)** — explicit protocol,
  in order. The whole point of gating on #2681 is recoverability: per-spawn flags
  mean the blast radius is exactly the canary sessions, with no global state to
  restore. Never improvise around the gate.
  1. **Hard gate**: #2681 merged AND shipped both halves of its fix — per-spawn
     `--claude-binary <path>` / `--transport stdio|sdk-url` flags (fix a) plus
     spawn-dispatch-time config read (fix b). Verify after rebuild:
     `dist/mcx claude spawn --help | grep -E 'claude-binary|transport'`. If the
     flags aren't there, the canary is OFF this sprint — do NOT flip
     `mcx config set claude-binary` globally mid-sprint (that's the exact
     sprint-71 abort, and the config write is itself racy per #2681). File the
     gap on #2688 and move on.
  2. **When**: the batch-2 → batch-3 boundary. #2681 changes the spawn RPC, so
     the **daemon must be restarted on the new binary** first, and a mid-sprint
     daemon restart is only safe at a drained boundary: `mcx claude ls` must
     show zero in-flight sessions, then `bun run build && mcx shutdown && mcx
     status`. If batch boundaries never fully drain, skip the canary and note it
     on #2688 — never restart the daemon under live sessions.
  3. **Scope**: exactly 2 batch-3 sessions, on **opus + stdio** — use #2654 and
     #2665. Never combine canaries: #2679/#2685 are the fable slots and stay on
     the default transport (two experimental variables in one session means an
     anomaly can't be attributed). All other sessions stay on the default
     transport. The orchestrator's own daemon connection is unaffected — this
     only changes worker transport.
  4. **Watch** (monitor stream, per canary session ID): spawn→first-event
     latency, sessions stuck in `starting`, permission round-trip behavior,
     interrupt/resume handling, missing heartbeats, worker exit codes — compared
     against sibling ws sessions in the same batch.
  5. **Rollback (single failure)**: interrupt, `bye --keep` (preserve the
     worktree as evidence), respawn the same issue with no transport flag
     (default ws), file session IDs + `mcx claude log` + daemon log excerpts on
     #2688. Nothing else to undo — no config was touched.
  6. **Abort (both canaries fail the same way)**: stop, do not spawn a third,
     finish the sprint on ws, write the pattern up on #2688. Widening stdio to
     the full grid is a **next-sprint decision** even if both canaries pass —
     success this sprint means two issues shipped end-to-end (impl → review/QA →
     merge) with zero transport-attributable anomalies, noted on #2688.
  - **Worker brief for #2681** must state the acceptance criteria explicitly:
    both per-spawn flags AND the spawn-time config read, with a spec test
    proving a spawned session uses the caller-supplied binary/transport even if
    global config changes immediately after spawn returns.
- **Fable worker expansion**: sprint 71's fable canary (#2645) passed end-to-end;
  this sprint routes two low-scrutiny slots (#2685, #2679) to fable. If either
  misbehaves, fall back to opus on respawn and file a data point.
- **Codex remains broken (#2482)** — do not route any work to codex.
- **#2684** (E2E transition tests) is deferred but unblocks the moment #2685
  merges — pull it in as a bonus slot only if the board drains early.

## Closed at plan time (board hygiene)

- #2664 — already fixed on main (afterEach imported, 20 tests pass); dup of closed #2667.
- #2091 — reopened as regression by issue-author: 21 stale work_items rows
  (sprint-62 era) still pollute `mcx tracked`; GC must key off prState=merged.

## Excluded / deferred

- #2696, #2655 (rules authoring) — deferred one sprint to keep the rules registry
  quiet while the verdict/containment chains land; next sprint's rules pass.
- #2622 (as-casts rule) — recon says it needs upfront scope design before it's
  implementable; route through /rule-author or a design comment first.
- #2666, #2660, #2662 (pre-push message, promptedDirs GC, worktree gc) — quick DX,
  lost the slot tiebreak; #2660/#2662 now pair naturally with reopened #2091 as a
  future "GC sweep" mini-arc.
- #2684 — blockedBy #2685; conditional bonus slot (see run-phase directives).
- #2697, #2680 (agent-grid follow-ups), #2670, #2690 (CI/host-load), #2658, #2657,
  #2650, #2647, #2501/#2502/#2503/#2504, #2562, #2471 — deferred recon batch,
  unchanged from sprint 71's Excluded section.

## Context

Sprint 71 landed the verdict-gate security chain (#2653→#2652→#2651) at 15/15 and
v1.14.1; its run filed the June tail this plan draws from. The two open trust gaps
it exposed are this sprint's core: a worker escaped its worktree via absolute-path
writes (#2693, with #2520/#2519 closing the rest of the containment surface) and
phase_state_set lets any session overwrite sentinel keys (#2682, with #2683/#2686/
#2687 finishing the fail-closed sweep). The test-gate cluster (#2692/#2571/#2648/
#2669) exists because broken phase-fn specs sat invisible to CI for weeks. Risk:
many picks touch the phase-script/verdict surface the orchestrator itself runs on —
the blockedBy chains above serialize the hot files, and `mcx phase install` must
run after each phase-source merge.
