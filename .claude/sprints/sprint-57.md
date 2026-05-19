# Sprint 57

> Planned 2026-05-19 03:50 local. Target: 15 issues.

## Goal

Land the `ctx.gh` foundation (#2023) — typed GitHub API for phase scripts and automation modules — and clear the sprint-56 deferrals: macOS support window (#2092), the resume recovery cluster (#2113/#2114), monitor command cleanup, and the flaky-server-pool investigation (#2103 nerd-snipe gate).

## Issues

| # | Title | Scrutiny | Batch | Model | Category |
|---|-------|----------|-------|-------|----------|
| 2023 | feat(alias): `ctx.gh` first-class GitHub API builtin | high | 1 | opus | goal-heavy |
| 2092 | meta(support): macOS support window + CI matrix + daemon preflight | medium | 1 | sonnet | goal |
| 2103 | flaky: server-pool.spec.ts disconnect/SIGTERM intermittent (**INVESTIGATION GATE**) | high | 1 | opus | goal (gated per investigations.md) |
| 2116 | docs/phases.md post-merge cleanup from #2088 (MonitorCategory alias + waitForEvent row) | low | 1 | sonnet | goal-quick |
| 2098 | ci: Copilot review skip docs-only — manual ruleset/user-settings docs | low | 1 | sonnet | goal-quick |
| 2113 | feat(resume): work for any worktree with live JSONL regardless of merge state | medium | 2 | sonnet | goal |
| 2069 | test: cover bye-and-untrack / emit-event / shell variants in automation-dispatcher.spec.ts | low | 2 | sonnet | goal-quick |
| 2012 | test: inject clock into StuckDetector for virtual-time tests (~2.5s wall savings) | low | 2 | sonnet | filler |
| 1725 | refactor(monitor): rename MAIL_RECEIVED / publishMailReceived to reflect send semantics | low | 2 | sonnet | filler (monitor) |
| 1561 | fix(monitor): `--until` / `--max-events` exit non-zero if stream ends before terminator | low | 2 | sonnet | filler (monitor) |
| 2114 | feat(resume): spawn --resume accept ended sessions by JSONL transcript | medium | 3 | sonnet | goal |
| 1563 | feat(monitor): `--repo` flag to scope events to a specific repo root | low | 3 | sonnet | filler (monitor) |
| 1560 | feat(monitor): `--until` supports glob patterns to match `--type` semantics | low | 3 | sonnet | filler (monitor) |
| 1945 | feat(memory): `mcx memory audit` — Haiku-driven contradiction + staleness check | medium | 3 | sonnet | filler |
| 1724 | test: end-to-end integration test for defineMonitor alias → mcx monitor | low | 3 | sonnet | filler (monitor) |

## Dependency edges (translate to `addBlockedBy` at run time)

- #2114 blockedBy #2113 (both touch `packages/command/src/commands/claude.ts` resume path — sequence to avoid logical conflict)
- #1560 blockedBy #1561 (both modify `mcx monitor --until` semantics in the same command file)
- #1563 blockedBy #1561 (touches the same `mcx monitor` command file; serialize after #1561 lands the new exit-code contract)

All other picks are independent.

## Investigation gate (mandatory per `references/investigations.md`)

**#2103** must spawn a nerd-snipe worker BEFORE any impl session. Use the `mcx claude spawn` shape (NOT the Agent tool — see #2009). Required deliverable: GitHub issue comment with timeline, mechanism (timing race vs deeper SIGTERM-not-being-sent vs other), and concrete fix plan. Hard-fail outcome → `needs-attention`. Sprint accepts the risk of paying 1 slot for nothing concrete if the gate produces partial findings only.

## Batch Plan

### Batch 1 (immediate — heavy goal + investigation + quick docs)
#2023, #2092, #2103, #2116, #2098

### Batch 2 (backfill — resume cluster + monitor rename + dispatcher tests)
#2113, #2069, #2012, #1725, #1561

### Batch 3 (backfill — remaining monitor cluster + memory audit + resume tail)
#2114, #1563, #1560, #1945, #1724

## Hot-shared file watch

- **`packages/command/src/commands/claude.ts`** — #2113 lands first, #2114 rebases. Orchestrator must broadcast targeted rebase on #2114 when #2113 merges.
- **`packages/command/src/commands/monitor.ts`** (or wherever `mcx monitor` `--until` lives) — #1561 lands first, #1560 + #1563 rebase. Watch for duplicate arg-parser entries; sprint 33 hit this with two PRs adding `case "phase":` independently.
- **`packages/core/src/alias.ts`** + **`packages/daemon/src/alias-server.ts`** — #2023 adds `ctx.gh` to AliasContext. No other pick adds AliasContext fields this sprint.
- **`docs/phases.md`** — #2116 cleanup; #2023 may also add docs for `ctx.gh` API. Different sections expected, but if both PRs touch the same h2/h3, serialize via review-time merge.

## Drive-by closures applied at plan time

These were filed during sprint 56 but already shipped before sprint 57 began. Closed now so the orchestrator doesn't spawn redundant verify sessions (sprint 56 paid 3 such slots):

- **#2106** — duplicate of #2098 (same conclusion, same evidence). Closed as dup.
- **#2107** — already-fixed in #2097 (commit a0a6118): classifier inlined in workflow, file list read from GitHub API not PR checkout.
- **#2111** — already-fixed: usage strings in both `parseResumeArgs` (claude.ts:656) and `parseAgentResumeArgs` (agent.ts:1238) already include `[--force] [--wait] [--timeout ms]`.

## Excluded (and why)

- **#1912** (mcx pr command) — heavy IPC + cache-invalidation; benefits from #2023 landing first. Defer to sprint 58. Centerpiece candidate once `ctx.gh` is callable.
- **#1964** (perf: daemon cache for ctx.gh) — explicitly blocked on #2023. Defer to sprint 58.
- **#2022** (merge module) — depends on #2023's 4-surface check sugar. Defer to sprint 58.
- **#2100** (Bun.sleep lint blocking) — 138 violations is a grinding multi-PR task, not a single issue. Recommend splitting into sub-tickets by file (ws-server.spec, stuck-detector.spec, quota.spec, etc.) and clearing in sprint 58–59.
- **#1861** (coverage for excluded files) — issue body itself says depends on #1856/#1857 for "dramatic ease"; pull when those land.
- **#1924** (monitor: unify event envelope) — ~500 LOC monitor-epic refactor; pair with #1939 in a dedicated monitor sprint.
- **#1939** (monitor: notification cadence) — depends on #1924.
- **#1611** (epic: mcx agent), **#1942** (epic: automate Tier-1/Tier-2), **#1486** (epic: mcx monitor) — true epics, need design pass before any sprint commits.
- **#2024** (evaluate Temporal/Hatchet/Restate) — exploration task; needs a spike rather than a sprint slot.
- **#1750** (mcx claude bye flip default) — `[BLOCKED on #1748 + #1749]` per title.
- **#2074** (bug(spawn): per-action permission prompts) — labeled `needs-clarification`; skip per Rule 1.
- **#1602** (slim builds) — heavy build-system refactor; defer.
- **#1602** (cookie auth #1595) — heavy sites feature; defer.

## Context

Sprint 56 cleared the orchestrator-UX polish stack (13 PRs in ~78 min). Sprint 57 anchors on **#2023 (ctx.gh)** — the foundation that unblocks the next ~6 issues (#1912 mcx pr, #1964 cache, #2022 merge module, downstream automation primitives). Two heavies (1 opus impl + 1 opus investigation gate) plus 4 medium picks plus 10 quick fillers. Sprint ends in 7 → introspection round fires at retro for sprint-58 plan input.

### Risks

- **#2023 scope**: 1.5K LOC heavy. If the worker overruns into typegen-from-OpenAPI territory, narrow to hand-written types and file the codegen as a follow-up. Hand-written is fine for v1 per the issue body.
- **#2103 investigation slot**: per investigations.md, gate's hard-fail outcome is `needs-attention`. Sprint 52 paid 2 slots on flake gates that came back partial. Confidence here is moderate — body has a plausible mechanism (CI runner timing on process-lifecycle assertions) and a concrete fix shape (poll-with-deadline). One slot of investigation risk accepted.
- **Monitor cluster (#1561 → #1560 + #1563)**: 3 PRs serialized on one file. If #1561 takes longer than median sonnet, the cluster bottlenecks Batch 3. Watch for this; consider folding #1560 into #1561 mid-sprint if needed.
