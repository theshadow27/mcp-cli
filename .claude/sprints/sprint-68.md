# Sprint 68

> Planned 2026-05-28 14:30 local. Started 2026-05-28 14:58 local. Target: 14 PRs.

## Goal

Agent protocol foundation — ship the formal spec, version negotiation, recording, mock-DSL extension, and the stdio-MVP transport that unblocks claude-latest in CI.

## Issues

| # | Title | Scrutiny | Batch | Model | Provider | Category |
|---|-------|----------|-------|-------|----------|----------|
| 2540 | protocol: formal spec for daemon↔worker protocol (docs/agent-protocol.md) | medium | 1 | opus | claude | goal |
| 2544 | ci: smoke step verifying tests pass with claude pruned from PATH | low | 1 | sonnet | claude | goal |
| 2234 | Version-gated stdio stream-json transport for claude sessions | high | 1 | opus | claude | goal |
| 2535 | fix: resolve 2 production empty-catch dotw-todo suppressions | low | 1 | sonnet | claude | filler |
| 2371 | poll-until-headroom FP-guard: naive '//' detection skips live pollUntil | low | 1 | sonnet | claude | filler |
| 2541 | protocol: version negotiation in init handshake + typed mismatch error | medium | 2 | opus | claude | goal |
| 2542 | protocol: NDJSON recording of worker↔daemon protocol exchange | medium | 2 | opus | claude | goal |
| 2543 | mock: extend mock-script DSL to cover full protocol surface | medium | 2 | opus | claude | goal |
| 2527 | bug: pre-commit hook spawns junk 'init'/'second' commits in worktrees | low | 2 | sonnet | claude | filler |
| 2331 | DX: add 'mcx pr comments resolve --all-addressed' to impl/review prompts | low | 2 | sonnet | claude | filler |
| 2493 | Orphaned am-i-done / bun test processes survive worker bye | medium | 3 | opus | claude | filler |
| 2533 | rule: dotw-todo-stale-issue — flag dotw-todo comments referencing closed issue | low | 3 | sonnet | claude | filler |
| 2536 | test: ci-steps.spec.ts ImportGraph stub cast → satisfies-guarded factory | low | 3 | sonnet | claude | filler |
| 2510 | dx: mcx phase run --dry-run doesn't preview; phase install must be re-run | low | 3 | sonnet | claude | filler |

## Batch Plan

### Batch 1 (immediate)

#2540, #2544, #2234, #2535, #2371

### Batch 2 (backfill)

#2541, #2542, #2543, #2527, #2331

### Batch 3 (backfill)

#2493, #2533, #2536, #2510

## Dependency edges (blockedBy)

- #2541 blockedBy #2540 (spec must exist for version-error doc URL to point at)
- #2542 blockedBy #2540 (the `kind` field references spec-defined message types)
- #2543 blockedBy #2540 (spec is source of truth for emit types in DSL extension)
- #2493 blockedBy #2541 (worker-lifecycle conflict — #2541 touches `*-session-worker.ts:806/532/525/522/511` for ready-version echo; #2493 may rework worker teardown in the same files)
- #2533 blockedBy #2535 (rule activates against existing dotw-todos once they point at the closed #2535)

## Hot-shared file watch

- `packages/daemon/src/*-session-worker.ts` — #2541 + #2493 are serialized via blockedBy above. #2234 touches `claude-session/ws-server.ts` heavily but not the worker `.ts` files at top of the path — should not conflict, but flag for the orchestrator to re-check at PR time.
- `scripts/rules/*` — #2371 + #2533 + #2535 each touch different rule files; no overlap expected. If two of them somehow add new rule helpers to a shared `_helpers.ts`, broadcast a rebase directive on the first merge.

## Context

Sprint 67 introspection round (closed #2511) surfaced ContainmentGuard fail-open for non-Claude providers (#2519/#2520) and the structural fragility of the worker↔daemon contract that codex #2482 already exposed. Sprint 68 takes the worker-protocol fragility head-on: epic #2537 was filed mid-planning with its full sub-story decomposition (#2540–#2544) and a hard prerequisite on #2234 (stdio MVP — claude past 2.1.122 cannot use `--sdk-url` and the agent-grid Epic 2 (#2538) needs `claude-latest` to function). #2234's design is in `docs/spike-1970-analysis.md`; it's the only heavy in the sprint and the most likely to bleed into sprint 69.

## Carries to next sprints (until ready)

Epic 2 (#2538 — manual agent grid) and Epic 3 (#2539 — nightly agent grid) sub-stories are **not** in this sprint. Their bodies currently list stories 6–17 / 18–23 by description only — no `gh issue create` calls have been made for them, no surface-area mapping, no acceptance criteria.

**Condition for writing them:** wait until #2540 (formal spec) lands and its prior-art subsection (claude SDK NDJSON + ACP comparison) is reviewed. That analysis may reshape Epic 2 — some stories will collapse, split, or become unnecessary depending on what alignment we land on. Filing them now risks rework once #2540 reveals what should actually exist.

**Plan Epic 2 sub-stories at the start of sprint 69**, or earlier in the sprint if #2540 ships before the wind-down. Plan Epic 3 sub-stories after Epic 2 is at least partly underway.

If sprint 68 finishes with capacity remaining and #2540 has landed, the orchestrator may pull forward 2–3 Epic 2 sub-stories opportunistically — but only after #2540 + its prior-art subsection are merged on main.

## Excluded with reason

- **#2482** (codex broken, RPC -32600) — directly addressed by Epic 1's protocol formalization (typed `ProtocolVersionMismatchError` in #2541). Fixing now would be premature; revisit after #2540 + #2541 land
- **#2210, #2313** (Bun segfaults) — `flaky` + need a nerd-snipe gate per skill rules; not in this sprint's budget
- **#2499** (split StateDb 1923-line god-object), **#2500** (decompose ws-server.ts 2634 lines) — both touch hot daemon files that conflict with #2234's worktree; save for a dedicated refactor sprint
- **#2463, #2471, #2479, #2519, #2520** — `needs-attention` label, skip per skill rules
- **#2536** considered for batch 2 but pushed to batch 3 since its motivation (PR #2532 QA finding) is independent of the agent-protocol thesis
- **#2328** (timedOut spurious on SIGTERM) — Explore agent flagged this as deprioritized vs. #2493's process-leak fix, which is the higher-impact subprocess work this sprint
- **#2393, #2485** (epics labeled meta) — left open as tracking; not Step-1a candidates
- **#2506** (introspection cadence guard) — meta, deferred per user direction
- **#2507** (diary→rules harvest), **#2182** (/docs-sweep skill) — meta improvements; not 30-min orchestrator edits, deferred to a dedicated effort
