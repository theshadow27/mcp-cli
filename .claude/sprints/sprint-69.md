# Sprint 69

> Planned 2026-05-28. Target: 15 PRs.

## Goal

Stand up the **manual agent grid (Epic 2, #2538)** — versioned `(provider, version)` matrix, deterministic install/isolation, and the capability battery — so we can answer "does claude@X.Y.Z still work?" on demand.

## Issues

| # | Title | Scrutiny | Batch | Model | Category |
|---|-------|----------|-------|-------|----------|
| 2578 | versions.yaml schema + Zod validator + CI check | medium | 1 | opus | goal |
| 2579 | LFS enablement + archive claude 2.1.119 | medium | 1 | opus | goal |
| 2580 | PII/secret sanitizer + pre-commit hook | **high** | 1 | opus | goal |
| 2581 | agent-grid package scaffold + capability gating | medium | 1 | opus | goal |
| 2582 | AgentFeatures expansion + declaration verification | medium | 1 | opus | goal |
| 2583 | install-agent.ts (registry-first, LFS-fallback, sha256) | medium | 2 | opus | goal |
| 2584 | agent-grid-detect.ts (registry latest-version detect) | low | 2 | opus | goal |
| 2585 | runner skeleton — `mcx agent-grid run` | medium | 2 | opus | goal |
| 2586 | isolation framework (tmpdir, git seed, cleanup) | medium | 2 | opus | goal |
| 2587 | replay — `mcx agent-grid replay <recording>` | medium | 3 | opus | goal |
| 2588 | capability tests, batch 1 | medium | 3 | opus | goal |
| 2589 | capability tests, batch 2 | **high** | 3 | opus | goal |
| 2563 | compareSemver pre-release NaN (breaks stdio gate) | low | 1 | opus | filler |
| 2569 | mock/site version-negotiation handshake test gap | low | 2 | opus | filler |
| 2565 | restored-session defaultTransport stdio args test gap | low | 3 | opus | filler |

## Batch Plan

### Batch 1 (immediate — 5 roots + independent filler)
#2578, #2579, #2580, #2581, #2582, #2563

### Batch 2 (backfill)
#2583, #2584, #2585, #2586, #2569

### Batch 3 (backfill)
#2587, #2588, #2589, #2565

### Dependency edges (→ addBlockedBy at run time)
- #2583 blockedBy #2578 (schema) + #2579 (archived tgz + sha256)
- #2584 blockedBy #2578 (emits versions.yaml rows)
- #2585 blockedBy #2581 (package scaffold)
- #2586 blockedBy #2581 (package scaffold)
- #2587 blockedBy #2578 (schema) + #2585 (shared `agent-grid` command surface in `main.ts`)
- #2588 blockedBy #2581, #2582, #2585, #2586 (convergence point)
- #2589 blockedBy #2588 (batch 1 establishes the test harness)
- Filler #2563, #2569, #2565 have no blockers — independent quick wins.

### Hot-shared notes
- #2578, #2579, #2581 all write under `agent-grid/` — different files; broadcast a rebase-and-check directive when the first lands.
- #2585 → #2587 share the `agent-grid` dispatch entry in `packages/command/src/main.ts` (covered by the blockedBy edge above).

## Pre-landed (exclude from run)

- **#2579** (LFS archive claude 2.1.119) — landed ahead of the run via **PR #2591** (auto-merge armed, CI-gated). The artifact needs the user's local 2.1.119 binary, so it was done directly rather than spawned. The run phase should treat #2579 as done and not spawn against it. Follow-up #2592 (per-platform archives + CI git-lfs verification) tracked separately.

## Context

Epic 2 builds directly on the Epic 1 foundation that landed across sprints 66–68: NDJSON recording (#2542/#2567), mock-script DSL parity (#2543), version negotiation (#2541/#2566), and the stdio MVP (#2545). The stdio transport dep #2234 is closed, so the `claude-latest` matrix leg is exercisable. Filler is deliberately on-theme (transport/protocol test coverage + the compareSemver pre-release bug that silently breaks the stdio version gate) so it reinforces the grid rather than scattering focus.

**Risk — dependency depth.** The leaves (#2588 → #2589) sit behind a 3-deep chain; if roots merge late they may roll to sprint 70. That's expected — blockedBy + idle-slot pull keep the grid filled with the 5 roots + 3 filler from minute one. Scrutiny mix skews medium (epic-build sprint, not a quick-win sweep); only #2580 (security sanitizer) and #2589 (flaky provider surfaces) are adversarial.
