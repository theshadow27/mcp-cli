# Sprint 69

> Planned 2026-05-28. Started 2026-05-29. Target: 15 PRs.

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

## Run notes (carryover — for retro + sprint 70)

### P1: bun test-worker CPU wedge (#2597) — MUST be sprint 70's first item
During the run, parallel sprint sessions saturated the machine (load avg **117**). Root cause (nerd-snipe-confirmed, on #2597): a zero-backoff `madvise` EAGAIN busy-spin in bun's bmalloc — `bun test --test-worker` children peg a core forever, ignore `--timeout` (spin is post-test-body) and SIGTERM (only `kill -9` works). Upstream (bun#27490 dup of open #17723, bun#27766) unfixed/unreleased — **our fix to make**, not theirs.
- **Band-aid used this sprint:** an in-session `Monitor` reaper killing test-workers with **>90s ELAPSED** (CPU-time threshold fails — starved spinners accrue CPU-time too slowly under contention). Dies with the orchestrator session — **NOT persistent**.
- **Real fix (unlanded, sprint 70 P1 #1):** (1) cap `--max-concurrency` in `scripts/am-i-done.ts`, scaling down when sibling am-i-done runs exist (global lock/sentinel) — this is the PRIMARY fix (trigger is N×20 oversubscription → RAM floor → EAGAIN); (2) watchdog that `SIGKILL`s the worker process GROUP past ~2× timeout; (3) productize the reaper into `orphan-reaper.ts` on an interval. NOT landed mid-sprint: it changes the shared test runner every in-flight session + CI depends on. Land it isolated, first, before spawning sprint 70's fleet.
- Also seen: leaked `bun test/echo-server.ts` fixtures (12-15min old) — separate orphan-cleanup gap; watch for recurrence.

### #2580 sanitizer — convergence → simplify/redesign
The security sanitizer hit the convergence trigger: review (3 blockers) → QA r1 (4 blockers) → Copilot (5 more), all *new* gaps (missed ASIA/STS + github_pat_ secret classes, a pre-commit hook that silently SKIPPED binary files = false security guarantee). Reactive regex-listing wasn't converging, so per run.md I **stopped patching and ordered a simplify/redesign pass** (principled gitleaks-style pattern taxonomy + fail-closed hook). Retro: validate that "coverage-type" findings (vs the classic type-laundering case) are a legitimate simplify trigger, and consider a rule/guidance that a secret sanitizer must anchor on an established taxonomy rather than hand-grown patterns from the start.

### PROCESS BUG: quota AskUserQuestion suspended the sprint overnight
At 100% 5h-quota the orchestrator raised an **AskUserQuestion** ("wind down vs pause-resume vs finish-2"). Sprints run **unattended**, so this blocked the entire context until the user returned hours later — the sprint did **nothing overnight**. Quota exhaustion is predictable with a known `resetsAt`; it must be a **self-executing policy, never a human gate**. Fix (see memory `feedback_quota_autonomous_policy`): at ≥95%, finish all no-LLM actions (flaky reruns, label flips, merges, bye stuck sessions) then `ScheduleWakeup` to `resetsAt` and auto-resume — do not ask. run.md's Quota-gating section says "full pause — wait for reset" but doesn't mechanize the wait; it should mandate ScheduleWakeup-and-resume and explicitly forbid AskUserQuestion for quota.

### CI bug: non-required flaky check cancels a required check
The bun-wedge flake (#2597/#2612/#2615) hangs/fails `check-no-claude` (non-required), and the CI workflow's **fail-fast cancels the dependent `coverage` job (which IS required)** → blocks merge on an otherwise-green PR. So a non-required flaky check effectively gates merges. Fix options: make check-no-claude not trigger sibling-cancel, set `fail-fast: false`, or de-couple coverage from check-no-claude. Worked around this sprint by cancel+rerun, and (for non-coverage cases) merging since check-no-claude isn't required.

### Reaper collateral
The elapsed-time (>90s) wedged-worker reaper occasionally SIGKILLs *legit* slow `am-i-done` test-workers under load (#2588 saw this and worked around it). Reinforces that #2597's concurrency cap — not the reaper band-aid — is the real fix; a productized reaper should gate on load or only fire when a worker is provably wedged.
