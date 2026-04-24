# Sprint 45

> Planned 2026-04-24 13:30 EDT. Target: 15 PRs (9 monitor-focused + 3 orchestrator follow-ups + 3 DX/test fillers).

## Goal

**Finish Phase 5 (`ctx.waitForEvent` feature-complete) and Phase 3 (CopilotPoller hardened) — plus unbreak MonitorRuntime itself so `defineMonitor` aliases actually run.** Sprint 43's analysis called out: "Sprint 45: Phase 5 finish + remaining Phase 3 hardening → `ctx.waitForEvent` is feature-complete." Sprint 44 landed the foundational pieces (AbortSignal wiring, responseTail gating, heartbeat normalization, `session.stuck` opener). This sprint closes the Phase 5 perf + docs gaps (#1727, #1719, #1589), builds the integration tests (#1720 consolidates #1715 + #1726) that make it *trusted*, finishes Phase 3 CopilotPoller hardening (#1735, #1738, #1742), and fixes the MonitorRuntime discovery bug (#1728) that currently makes `defineMonitor` a dead feature regardless of how good `ctx.waitForEvent` gets.

After this sprint: `ctx.waitForEvent` should be ready for sprint 46 to validate by migrating the first orchestrator flow (or a phase script) onto it. Sprint 47 would then migrate `run.md`'s main `mcx claude wait` loop.

## Issues

| # | Title | Scrutiny | Batch | Model | Category |
|---|-------|----------|-------|-------|----------|
| **1728** | saveAlias never writes aliasType='defineMonitor' — MonitorRuntime spawns zero monitors | medium | 1 | opus | **critical** MonitorRuntime |
| **1727** | matchFilter: memoize createEventMatcher to avoid per-event recompile | medium | 1 | opus | Phase 5 perf |
| **1589** | monitor: backfill memory safety and async scheduling (#1513 follow-up) | high | 1 | opus | Phase 5 finish — **needs design clarification** |
| **1735** | CopilotPoller: _lastError cleared unconditionally on partial poll failure | medium | 1 | opus | Phase 3 hardening — **needs design clarification** |
| **1738** | perf: CopilotPoller per-repo GET /pulls/comments?since= (10x API cost reduction) | high | 2 | opus | Phase 3 perf — **deps: #1735 (copilot-poller.ts)** |
| 1720 | test(event-filter): integration test for waitForEvent with real daemon + synthetic event | medium | 2 | opus | Phase 5 trust — **consolidates #1715 + #1726; deps: #1727** |
| 1742 | test: integration tests for CopilotPoller review/sticky surfaces | low | 2 | sonnet | Phase 3 trust — **deps: #1738 (copilot-poller.ts)** |
| 1719 | docs(event-filter): warn about since-less startup race in waitForEvent JSDoc | low | 1 | sonnet | Phase 5 docs |
| 1729 | fix(monitor-runtime): doRestartMonitor logs success when spawnMonitor fails silently | low | 2 | sonnet | MonitorRuntime — **deps: #1728 (logical)** |
| 1693 | test(monitor): add onCiEvent integration tests to work-item-poller.spec.ts | low | 1 | sonnet | CI-event regression guard for #1692 |
| 1660 | test(monitor): integration test for session.idle/result cost+preview enrichment | low | 2 | sonnet | monitor Phase 2 trust — **deps: #1589 (ipc-server.ts)** |
| 1635 | phase: --no-execute path ignores work_items.phase fallback for empty transition log | low | 1 | sonnet | orchestrator papercut |
| 1767 | fix(phase): phase-missing row reads circularly — "phase X in lockfile but missing from lockfile" | low | 2 | sonnet | orchestrator — **deps: #1635 (phase.ts)** |
| 1771 | help(dispatcher): alias subcommands don't resolve help (list→ls, quit→bye, wt→worktrees) | low | 1 | sonnet | DX follow-up to #1518 |
| 1775 | feature: allow overriding `runsOn` for local POC/testing of phase-graph changes | low | 1 | sonnet | external-user unblock — bootstrap-sprint POC |

**Model mix:** 6 opus + 9 sonnet (same shape as sprint 44, which landed 15/15).
**Scrutiny mix:** 2 high (review+QA), 6 medium (QA), 7 low (QA) — matches template.

## Batch Plan (launch order only — NOT the orchestrator's Task structure)

Per `run.md` Input → "Task list setup": create **one TaskCreate per issue** with the `addBlockedBy` edges listed below.

### Batch 1 — 9 unblocked picks (start immediately, stagger opus anchors)
#1728, #1727, #1589, #1735, #1719, #1693, #1635, #1771, #1775

4 opus + 5 sonnet. #1728 is the critical-path anchor — it makes `defineMonitor` actually run. #1727 and #1589 are Phase 5 correctness/perf; launch early so #1720 (integration test behind #1727) and #1660 (test behind #1589) can start as soon as they merge. #1735 is the first `copilot-poller.ts` touch — #1738 and #1742 serialize behind it.

### Batch 2 — 6 picks waiting on shared-file rebase or logical deps
#1738, #1720, #1660, #1742, #1767, #1729

Each has one explicit `blockedBy` edge to a Batch 1 pick. They start as soon as the blocker merges, not when "Batch 1 is done."

## Dependency edges (translated to `addBlockedBy` at run time)

- **#1738 blockedBy #1735** — both touch `packages/daemon/src/github/copilot-poller.ts`. #1735 is the small error-handling fix; #1738 is the ~100–150 LOC rewrite of `poll()` + `fetchPRComments`. Serialize to avoid rebase churn.
- **#1742 blockedBy #1738** — tests should cover the new per-repo `/pulls/comments?since=` API shape landed by #1738; landing tests first against the old API is wasted work.
- **#1720 blockedBy #1727** — both touch `packages/core/src/event-filter.ts` (plus `alias-runner.ts`). #1727 changes the `matchFilter` call graph (memoization wrapper); the integration test should exercise the final signature.
- **#1767 blockedBy #1635** — both touch `packages/command/src/commands/phase.ts` (detectDrift + fallback logic). Serialize.
- **#1660 blockedBy #1589** — both touch `packages/daemon/src/ipc-server.ts` in the `/events` SSE + ring-buffer region. #1589 adds buffer cap + yield; #1660 tests enrichment path through the same endpoint.
- **#1729 blockedBy #1728** — logical dep: `#1729`'s repair on `doRestartMonitor`'s false success is only observable end-to-end once `MonitorRuntime` actually has monitors to restart (`#1728`'s fix). They touch different files (`monitor-runtime.ts` vs. `ipc-server.ts` saveAlias handler), but landing #1729 first produces a repair whose integration test is ineffective.

## Hot-shared file watch

- `packages/daemon/src/github/copilot-poller.ts` — #1735, #1738, #1742. Serialized via the edges above. **#1737 (rename copilot.inline_posted) deferred to sprint 46** pending a rename-vs-filter design call.
- `packages/core/src/event-filter.ts` — #1727, #1720, #1719. Serialized; #1719 is docs-only so it won't conflict, but broadcast a rebase directive if #1727 lands first.
- `packages/command/src/commands/phase.ts` — #1635, #1767, and #1775's runtime branch-override consumer all touch this file. #1635 / #1767 serialized via dependency edge; #1775's call site is a separate region (runsOn check inside `executePhase`/`phaseRun` early gate) and rebases cleanly. Bulk of #1775 lands in `cli-config.ts`. **#1746 (auto-detect --from) deferred** pending user-supplied repro of the exact error; workaround (`--from` flag) is fine today.
- `packages/daemon/src/ipc-server.ts` — #1589, #1660, and #1728's `saveAlias` edit all touch this file. #1589 and #1660 serialized by the edge above. #1728's edit is in a different region (saveAlias handler) — should rebase cleanly, but the orchestrator should broadcast a rebase directive after each `ipc-server.ts` merge.
- `packages/command/src/help.ts` — #1771 solo this sprint. **#1772 (column alignment for long flags) deferred** as cosmetic.

## Pre-session clarifications required

Flag the following in the impl prompt notes before spawning — the worker should either (a) produce a design proposal first and request approval, or (b) use the specified default:

- **#1589 (backfill memory safety)**: buffer cap size not specified; yield strategy (`setImmediate` vs `setTimeout(0)`) not specified. Default ask: cap at **10,000 events / 10 MB whichever hits first**; yield via **`setImmediate`** between 100-event batches. Worker can propose alternatives but must justify.
- **#1735 (CopilotPoller _lastError)**: accumulate all per-PR errors into `_lastError` vs. preserve whatever was most recently set. Default ask: **preserve most-recent, log the others**. Worker may propose `errors[]` array if the schema supports it.
- **#1738 (per-repo /pulls/comments?since=)**: GitHub API contract — verify that `?since=<iso8601>` on `/repos/{owner}/{repo}/pulls/comments` returns comments strictly after the timestamp (exclusive) vs. inclusive. Worker should confirm against the API before cutover. Also: verify `pull_request_url` is the stable grouping key.
- **#1775 (runsOn override)**: scope is **NOT** the full 4-option menu in the issue body. Per [issue comment](https://github.com/theshadow27/mcp-cli/issues/1775#issuecomment-4316688818), implement only **option 2-variant**: read `~/.mcp-cli/config.json` (or `.mcx.json` in repo) for `phase.allowBranchOverride: string[]`; if current branch matches an entry, `runsOn` check passes with a one-line `WARNING: phases running from branch "<X>", not "main" — install-security boundary not enforced` to stderr. Refuse to enable on `main` itself (anti-foot-gun: must be a non-main branch). No CLI flag, no env var, no `.mcx.yaml` schema change. The `runsOn: string[]` list-form (#1773 prerequisite) is **explicitly out of scope** and waits for the orchestrator-worktree design.

## Excluded (with reasons)

- **#1715, #1726 (waitForEvent integration tests)** — consolidated into #1720 per Explore's finding that all three issues ask for nearly identical tests at different layers. Will close both with pointers to #1720 once it merges.
- **#1698 (updatedAt epoch fallback)** — already CLOSED 2026-04-24 (noticed during reconnaissance; was still in open-issue list at plan start).
- **#1700, #1696, #1636** — already fixed on main (closed during plan reconnaissance sweep). `#1700` → PR #1711; `#1696` → work-item-poller.ts:291-300 has the `isActionable` gate; `#1636` → phase.ts:1068-1069 has the `workItem.phase in manifest.phases` guard.
- **#1737 (rename copilot.inline_posted)** — design decision needed (rename vs. filter to Copilot-authored only). Defer to sprint 46 opener.
- **#1746 (mcx phase run auto-detect --from)** — needs user repro of the exact error; workaround exists. Defer.
- **#1772 (help formatter column alignment)** — cosmetic; pulled to filler slot for #1771 only.
- **#1759 (test: backfill path coverage for session.response/responseTail)** — overlaps scope with #1660 on `ipc-server.spec.ts`; pull in sprint 46 once #1660 lands.
- **#1754 (test(alias-bundle): timeout coverage)** — swapped out for #1775 to unblock external bootstrap-sprint user. Both are filler-tier; #1775 has a real consumer waiting on it. Pull #1754 in sprint 46.
- **#1773 (orchestrator-worktree restructuring)** — needs design spike + meta-file changes that don't fit a worker pick. Sprint 46 retro candidate. #1775's `.mcx.json` primitive does NOT prejudge #1773's eventual `runsOn: string[]` list-form — they're complementary primitives for different consumers (per-dev vs. orchestrator).
- **#1770, #1689, #1743, #1687 (flaky containment symlink tests)** — the same test has been filed 4 times across 3 sprints. Batch with a future "test infra stabilization" mini-sprint; any one-off fix now just produces another dup.
- **#1610 (rich session metrics on by default)** — Phase 6 follow-up; same `monitor-event.ts` contention as the Phase 6 deferred trio (#1586, #1587). Sprint 46 or 47 as a dedicated Phase 6 wave.
- **#1586, #1587 (Phase 6 events — daemon lifecycle + budget)** — deferred since sprint 44; pull in a dedicated Phase 6 sprint once this sprint's `session.stuck` plumbing validates in production.
- **VFS/clone arc (#1209, #1262, #1263, #1277, #1279, #1280, #1281, #1311, #1312, #1323)** — stalled 6+ sprints; needs a dedicated sprint or arc-level rethink.
- **Sites medium cluster (#1459, #1540, #1595, #1599)** — save for a sites-focused sprint.

## Risks

- **#1728 is more subtle than it looks.** The fix is a one-line change in `saveAlias` (detect `isDefineMonitor` before falling through), but the integration story is deeper: the DB column needs a migration for existing rows mislabeled as `freeform`, and `listMonitors`'s filter cannot flip until all historical rows are reclassified. Implementer must: (a) migrate existing `defineMonitor`-shaped scripts at startup (idempotent), (b) add the `saveAlias` classification, (c) add an integration test that writes a `defineMonitor` alias via `saveAlias` → daemon restart → `MonitorRuntime.startAll()` picks it up. If (a) is skipped, existing monitors stay invisible after the fix lands.
- **#1738 is the highest-stakes pick.** ~100–150 LOC rewrite of the CopilotPoller core loop. GitHub API contract must be verified (inclusive/exclusive `since=` behavior). Risk of subtle dedup regression if `pull_request_url` grouping ever drifts. If API verification reveals the `/pulls/comments?since=` endpoint doesn't behave as hoped, **split into #1738a (minimum per-PR backoff + cap)** and file #1738b (rewrite) as sprint 46 follow-up.
- **#1589's design choices shape the rest of the /events contract.** Buffer cap + yield strategy affect every `/events` consumer. Implementer must send the design proposal before coding if they want to deviate from the plan's defaults. Adversarial review (high scrutiny) will catch any hidden memory unsafety.
- **Phase 5 integration tests (#1720) may expose architectural gaps.** Sprint 43's analysis flagged this as a +1-sprint risk if `waitForEvent` integration reveals re-plumbing needed. Budget 2 repair rounds minimum on #1720 and let the cap route it to `needs-attention` rather than churning indefinitely.
- **Hot-shared `ipc-server.ts` contention between #1589, #1660, and #1728.** Three picks touch the same file at different regions. Rebase cleanly in principle, but the orchestrator must broadcast "rebase onto latest main before pushing" to in-flight impl sessions after each merge.
- **Quota.** Sprint 44 fit in one 5h block (peak 84%) with 15 picks + 22 QA rounds across the sprint. Sprint 45 has 15 picks with 6 opus anchors (same as 44) — similar shape. Apply the `feedback_quota_end_of_block.md` rule: fire for effect near reset.

## Retro rules applied (carried forward + new)

Carried forward from sprint 44 retro:

1. **One TaskCreate per issue** with `addBlockedBy` edges — **not** Batch 1/2 grouping tasks.
2. **Near quota reset, fire for effect.** See `.claude/memory/feedback_quota_end_of_block.md`.
3. **Auto-chain run → review → retro by default.** Sprint 45 runs in auto-chain mode unless invoked as `/sprint run 45`.
4. **Use Explore for candidate reconnaissance** — done during this plan (Explore digest informed the swap-#1698→#1728 decision and the #1715/#1726/#1720 consolidation).
5. **Reviewer self-repair when findings are 1–3 contained edits** with file:line + concrete fixes.
6. **QA gate on unreplied Copilot threads is arithmetic** (meta fix `45a314d9`). Budget for round-2 repair on any PR that triggers new Copilot inline review on the repair commit itself — self-repair is round-scoped, not incident-scoped (sprint 44 learning on #1585).
7. **Planner's hot-shared file watch should read PR diffs, not issue titles** (sprint 44 retro learning: #1714 touched `phase.ts` not noted in plan; #1748 hit `gc.ts` not `worktree-shim.ts`). This sprint: file list above was derived from Explore reading each issue body + likely file names, not just title keywords. Explore should also read sibling PR diffs if a PR already exists — do that next sprint for any candidate that references an open PR.

New rules observed at sprint 44 end:

8. **Release-commit-via-PR** is the likely fix for the autoapprover block on `git push origin main` for `release: vX.Y.Z`. **Proposed sprint-45 meta change**: cut v1.7.5 release via a `release/v1.7.5` branch → auto-merge PR instead of direct push. The autoapprover cost per sprint is ~1 round-trip to the user; a ~2-min CI wait on the release PR is cheaper. Open question: does the tag push need to happen after the PR merges, or can it happen from the branch? Will resolve at review time.
9. **Close-as-done flow is cheap** (<$0.50 per issue vs. ~$2 to reimplement). Applied this plan: closed #1636 in-sprint, noted #1700 / #1696 / #1698 already-closed. Board hygiene pays off.
10. **Planner must re-verify candidate state immediately before writing the plan** — `#1698` was open at `gh issue list` fetch time but closed 3 hours later. Add a `gh issue view <n> --json state` sweep over the final pick list before writing the file.

## Context

Sprint 44 shipped v1.7.4 — 13 PRs merged + 2 closed as already-done. Phase 5 foundations (AbortSignal, heartbeat normalization, responseTail gating) are in production; Phase 6 opens with `session.stuck`. Phase 3 CopilotPoller had its P0 papercuts fixed (403 vs rate-limit split, seen_comment_ids cleanup). The monitor epic is now at ~20% of open issues (down from ~25% pre-sprint).

This sprint finishes the Phase 5 trust story (perf + docs + the integration test that proves it works end-to-end), finishes Phase 3 hardening (error accounting + 10x API cost reduction + integration test), and fixes the one bug that's kept MonitorRuntime dormant since #1713 landed (#1728). **After sprint 45: `ctx.waitForEvent` should be feature-complete; sprint 46 validates by migrating one real flow; sprint 47 migrates `run.md`.**
