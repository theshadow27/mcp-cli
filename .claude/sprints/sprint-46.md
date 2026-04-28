# Sprint 46

> Planned 2026-04-27 20:25 EDT. Target: 8 PRs (5 orchestrator-pain fixes + 3 small DX/data wins).

## Goal

**Quiet the orchestrator surface — eliminate the noise that ate attention during sprint 45.** Sprint 45 retro filed 6 fixable issues against the orchestrator pipeline; 5 of them are pure code/text fixes (the 6th, #1801, was applied as a meta-fix between sprints in PR #1804). This sprint pays the bill: every false `session.stuck` event, every `vq[$].has` line on stderr, every `Error:` prefix on `bye` success messages — gone before sprint 47 starts so Phase 6 runs in a quiet room.

After this sprint: sprint 47 cuts directly to Phase 6 (#1586 daemon lifecycle, #1587 budget events, #1610 rich session metrics) + the first `ctx.waitForEvent` migration, with the orchestrator's per-PR touchpoint count meaningfully reduced.

## Issues

| # | Title | Scrutiny | Batch | Model | Category |
|---|-------|----------|-------|-------|----------|
| **1797** | daemon: 'vq[$].has' runtime error on every work_items_update with phase change | medium | 1 | opus | retro-fallout — **upstream of #1802** |
| **1799** | session.stuck heuristic fires on every long bun-test run (signal/noise) | medium | 1 | opus | retro-fallout, monitor-epic |
| 1798 | mcx claude bye prefixes success messages with 'Error:' | low | 1 | sonnet | retro-fallout — text fix |
| 1800 | gh pr merge --delete-branch fails on local branches held by active worktrees | low | 1 | sonnet | retro-fallout — likely docs/wrapper |
| 1768 | fix(sites): reject malformed 'sites' arg in site_browser_start handler | low | 1 | sonnet | sites — independent filler |
| 1699 | fix(db): COALESCE prevents clearing merge_state_status on work items | low | 2 | sonnet | db — **deps: #1797 (work_items handler region)** |
| **1802** | phase script transition log diverges from work_items.phase after force-update | medium | 2 | opus | retro-fallout — **deps: #1797 (likely incidentally fixed by it)** |
| 1746 | mcx phase run <to> should auto-detect --from from work_items.phase | low | 2 | sonnet | DX — **deps: #1802 (phase.ts region)** |

**Model mix:** 3 opus + 5 sonnet. Lean sonnet because most are mechanical/text fixes.
**Scrutiny mix:** 0 high, 3 medium, 5 low. No adversarial reviews expected.

## Batch Plan (launch order only — NOT the orchestrator's Task structure)

Per `run.md` Input → "Task list setup": create **one TaskCreate per issue** with the `addBlockedBy` edges listed below.

### Batch 1 — 5 unblocked picks (start immediately)
#1797, #1799, #1798, #1800, #1768

2 opus + 3 sonnet. #1797 is the critical-path anchor for Batch 2 — fixing it likely closes #1802 incidentally and definitely unblocks #1699's region. #1799 is the highest QoL win for the orchestrator (false-positive stuck noise was 12+ events in sprint 45).

### Batch 2 — 3 picks waiting on Batch 1's daemon work
#1699, #1802, #1746

Each has one explicit `blockedBy` edge to a Batch 1 pick. They start as soon as the blocker merges.

## Dependency edges (translated to `addBlockedBy` at run time)

- **#1699 blockedBy #1797** — both touch the work_items DB write path. #1797 is the schema/type defect that fires on every phase change; #1699 is the COALESCE bug that prevents clearing nullable columns. Serialize to avoid rebase churn.
- **#1802 blockedBy #1797** — #1802 ("transition log diverges") may be a *consequence* of #1797 rather than an independent bug. The implementer for #1802 should verify after #1797 lands whether the divergence still reproduces. If not, close #1802 with a pointer to #1797 and free the slot for a filler.
- **#1746 blockedBy #1802** — both touch `packages/command/src/commands/phase.ts`. #1802 may add a phase-state reconciliation path; #1746 adds a `--from` auto-detect that reads the same column. Serialize.

## Hot-shared file watch

- `packages/daemon/src/<work_items handler>` — #1797, #1699. Serialized via the dependency edge.
- `packages/command/src/commands/phase.ts` — #1802, #1746. Serialized.
- `packages/daemon/src/<heartbeat or session-stuck heuristic>` — #1799 solo this sprint.
- `packages/command/src/commands/{agent,claude}.ts` — #1798 solo (text-only edit to the bye output formatting).
- No third-party / cli-config conflicts this sprint.

## Pre-session clarifications required

Now visible to workers via Step 1a in `.claude/commands/implement.md` (added in PR #1804). Workers will read this section automatically.

- **#1797 (vq[$].has)**: the error text suggests a Bun-bytecode-mangled identifier inside the work_items handler. Check whether `manifest.phases` (or a similar Set/Map) is undefined when the handler runs the phase-validity check. Add a defensive guard *and* fix the root cause (likely a missing import or a stale handler that runs before manifest is loaded). Don't suppress the error without understanding it — it may correlate with #1802's transition-log drift.
- **#1799 (session.stuck noise)**: prefer **option 1 from the issue body** — track last-tool-completion timestamp, pause the stuck timer while a tool call is in-flight. Avoid simply raising the threshold (option 3); that masks real stucks. Tool-aware thresholds (option 2) are out of scope for this sprint.
- **#1800 (gh pr merge --delete-branch)**: the cleanest fix is probably a **doc + workaround in run.md** ("expected during sprint flow, benign — `mcx claude bye` cleans the local branch when the worktree is removed"). If the implementer wants to write a wrapper command (e.g. `mcx pr merge`) that orchestrates merge + bye, file as a separate enhancement (#1397 territory) and pull in a future sprint.
- **#1802 (phase log drift)**: first task is **verify reproducibility after #1797 lands**. If the divergence is gone, close as duplicate and free the slot. If it persists, the fix is to either (a) write a transition-log entry on every `work_items_update` that includes a phase change, including `force=true`, or (b) make `mcx phase run` read `from` from the column instead of the log. Implementer chooses, but must justify.
- **#1746 (phase --from auto-detect)**: read `work_items.phase` for the issue, default `--from` to that. Don't break existing callers that pass `--from` explicitly. Tests should cover both auto-detect and explicit-pass paths.

## Excluded (with reasons)

- **#1801** (already applied as meta-fix) — landed in PR #1804 between sprints 45 and 46.
- **#1773** (meta-PR restructuring epic) — resolved by PR #1803 (sprint-{N} branch + worktree pattern). Close at plan time with a pointer.
- **#1715, #1726** (waitForEvent end-to-end + integration tests) — covered by sprint 45's #1720 (PR #1786). Close at plan time.
- **#1737** (rename copilot.inline_posted) — held for sprint 47 (Phase 6 wave) where it shares a PR-review pass with the new event names.
- **Phase 6 trio (#1586, #1587, #1610)** — sprint 47's main thesis; deferring intentionally to keep sprint 46 small + mechanical.
- **mcx agent UX cluster (#1602-#1609)** — sprint 48 candidate; skipping this round.
- **Containment flaky symlink dups (#1770, #1689, #1743, #1687, #1794)** — needs a dedicated test-infra mini-sprint to dedupe-and-fix-once. Filing as an arc-level note, not a sprint pick.
- **VFS/clone arc** — stalled 7+ sprints; no change.

## Risks

- **#1797 might be deeper than it looks.** "vq[$].has" is bytecode-mangled which means the bug is in compiled code paths. Worst case it's a Bun/runtime issue rather than our code; budget 1 round of repair if the fix doesn't stick on the first try. Adversarial review is unlikely needed (medium scrutiny is fine for a defensive guard + root-cause patch).
- **#1802 might collapse to #1797.** Implementer for #1802 should reproduce the drift *after* #1797 lands, not before. If gone, close as dup. This is the only "verify upstream first" pick.
- **#1799's stuck heuristic touches a hot path.** Heartbeat + session telemetry are critical to the orchestrator. The fix should be additive (track tool start/end) rather than replacing the existing heuristic. Tests must cover: false positive (long bun test) → no event; true positive (frozen session) → still fires.
- **Quota.** Sprint 45 used <12% of the gauge with 13 PRs. Sprint 46 has 8 picks, 3 opus. Quota is not a constraint.
- **Time pressure.** Sprint 46 is the first half of a back-to-back tonight. Budget 60 min orchestrator-active. Sprint 47 (Phase 6 + waitForEvent migration) follows immediately.

## Retro rules applied (carried forward)

Carried forward from sprint 45 retro:

1. **One TaskCreate per issue** with `addBlockedBy` edges — not Batch grouping tasks.
2. **Override triage to adversarial review when the plan calls high scrutiny.** No high-scrutiny picks this sprint, so no overrides expected.
3. **Reviewer self-repair when findings are 1-3 contained edits.** Same pattern as sprint 45.
4. **Verify candidate state immediately before writing the plan** — done: #1797-#1802, #1699, #1746, #1768 all confirmed OPEN at 2026-04-27 ~20:00 EDT.
5. **Long-lived sprint-{N} branch + worktree** — first sprint to use the new flow (per PR #1803). Worktree at `.claude/worktrees/sprint-46/`, draft PR opened at plan time, converted to ready at retro.

New rules carried out at sprint-46 plan time:

6. **Apply meta-fixes in their own `meta/<descriptor>` PR between sprints** — done: #1801 → PR #1804 before plan finalization, so workers in sprint 46 see Step 1a from the start.

## Tentative sprint 47 outline

For continuity. Will be fleshed out at the end of sprint 46.

> Sprint 47 — "Phase 6 wave + first waitForEvent migration." Target: 8-9 PRs, ~75 min, v1.7.7.

| # | Title | Scrutiny | Model | Notes |
|---|-------|----------|-------|-------|
| 1586 | Phase 6: daemon lifecycle events (worker.ratelimited, daemon.restarted, etc.) | high | opus | adversarial review |
| 1587 | Phase 6: budget events (cost + quota thresholds) | high | opus | adversarial review |
| 1610 | feat(agent): rich session metrics on by default | high | opus | adversarial review |
| 1659 | feat(coalesce): max-key cap + oldest-flush eviction | medium | opus | |
| *new* | waitForEvent first migration — target: triage.ts `mcx claude wait` → `ctx.waitForEvent` | medium | opus | new issue at plan time |
| 1737 | rename copilot.inline_posted → pr.review_comment_posted | low | sonnet | |
| 1681 | test(monitor): session.result via /events SSE end-to-end | low | sonnet | |
| 1572 | test(monitor): /events?since= backfill integration test | low | sonnet | |
| 1788 | docs: byte cap uses UTF-16 code units, not UTF-8 | low | sonnet | |

Mix: 5 opus + 4 sonnet. 3-4 high-scrutiny (Phase 6 trio + waitForEvent migration). Expected adversarial reviews on the trio.

Hot-shared file watch (preview):
- `packages/daemon/src/monitor/<event-publish path>` — #1586 + #1587 + #1610 all add new event types. Likely converge in one file or two adjacent files. Serialize.
- `packages/core/src/event-filter.ts` — waitForEvent migration touches the consumer side; new events on the producer side. Independent regions but plan to verify at run time.

## Context

Sprint 45 shipped v1.7.5 — 13 PRs merged + 2 already-closed pre-sprint = 15/15 issues. The Monitor Epic dropped from ~33% of open issues at sprint 41 start to ~12% post-sprint-45 (15 of 126). Phase 5 finish landed (`ctx.waitForEvent` feature-complete with integration tests); Phase 3 hardening landed (CopilotPoller 10× cost reduction); Phase 2 backfill safety landed.

Sprint 46 is the first half of a deliberately back-to-back pair tonight. Sprint 47 follows immediately and inherits a quieter orchestration surface thanks to this sprint's fixes. Both should fit in the same 5h quota block.
