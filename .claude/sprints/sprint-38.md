# Sprint 38

> Planned 2026-04-18. Started 2026-04-18 22:12 local. Ended 2026-04-19 00:38 local. Target: 15 PRs. Shipped: 15 (14 merged PRs + #1457 closed-as-implemented).

## Goal

**Make the orchestrator itself reliable.** Sprint 37 proved the pipeline can
ship 13 PRs + a 4k-line contrib in ~2 days, but exposed three pain points
that forced manual workarounds: worker worktree-containment breaches
(#1425 recurred 3×), phase-namespace state the orchestrator can't
inspect/write (#1445), and the sprint plan's model column being ignored
(#1437). Sprint 38 anchors on the full containment design (#1441) and
closes the phase-framework gaps. Also lands the CI/DX follow-ups that
kept ambushing sprint 37.

## Issues

| # | Title | Scrutiny | Batch | Model | Category |
|---|-------|----------|-------|-------|----------|
| **1441** | feat: worktree-containment enforcement — monitor worker tool calls for escape attempts | high | 1 | opus | **anchor**, #1425 |
| **1445** | bug(phases): phase-namespace state (qa_session_id, etc.) is opaque — work_items_update can't write it | medium | 1 | opus | orchestrator-DX |
| **1446** | ci: coverage job doesn't handle Bun SIGSEGV (exit 139) — falls through to exit $code | low | 1 | sonnet | CI stability |
| **1465** | bug(gc): 'Cannot reach daemon to query acp_session_list' — gc refuses to prune | low | 1 | sonnet | DX |
| **1344** | feat(phases): detect and report cycles in manifest phase graph | low | 1 | sonnet | phase polish |
| **1437** | fix(phases): impl.ts doesn't read model from sprint plan — all spawns default to opus | low | 2 | sonnet | orchestrator-DX |
| **1426** | bug: mcx claude bye reports 'disconnected' state; some sessions balloon to 100k+ tokens before ending | medium | 2 | opus | containment, cost |
| **1385** | fix(phases): truncate long forceMessage in phase log table output | low | 2 | sonnet | phase polish |
| **1386** | test(phases): add combined --json + --work-item flag test for mcx phase log | low | 2 | sonnet | test coverage |
| **1352** | work_item_transitions: orphan rows accumulate when work item is deleted | low | 2 | sonnet | phase polish |
| **1391** | chore(phases): add CI grep check asserting run case calls assertNoDrift | low | 3 | sonnet | CI stability |
| **1351** | work_items_update: validate initialPhase server-side against manifest | low | 3 | sonnet | phase polish |
| **1458** | sites: mergeHeaders keeps duplicate content-type keys when cred + call disagree on case | low | 3 | sonnet | sites follow-up |
| **1457** | sites: NamedCall.fetchFilter declared but not applied (owa-urlpostdata missing) | low | 3 | sonnet | sites follow-up |
| **1367** | repro harness: gh pr merge --delete-branch → core.bare=true | medium | 3 | opus | rollover |

## Batch Plan

### Batch 1 — Anchor + CI blockers (immediate)
#1441, #1445, #1446, #1465, #1344

- **#1441 (anchor)** is the full worktree-containment enforcement design.
  Design-heavy; builds on #1442 (GIT_DIR pin) and #1443 (pre-commit hook)
  that landed in sprint 37. Tiered policy: hard-deny git writes outside
  worktree, strike-counted Edit/Write with 3-strike cap, warn-only on
  reads. Expect multiple rounds. Opus, high scrutiny.
- **#1445** unblocks orchestrator recovery paths. Today `work_items_update`
  silently no-ops on phase-namespace keys. Minimum viable fix: validate
  unknown keys as errors (option 3 in the issue); stretch: extend to
  accept phase state. Opus, medium scrutiny.
- **#1446** closes the segfault gap left by #1419 — coverage job should
  handle exit 139 (SIGSEGV) the same as exit 132, retry-with-warn. Small.
- **#1465** is the gc IPC bail. Likely fallback to `_claude`/`_codex`
  session lists when `acp_session_list` unreachable. Small.
- **#1344** ships a cycle-detection pass over the phase graph at install
  time. Prevents silent infinite loops if someone adds a bad transition.

### Batch 2 — Orchestrator DX + phase polish (backfill)
#1437, #1426, #1385, #1386, #1352

- **#1437** must start after #1445 lands — both touch the work_items
  update path. `impl.ts` should read model from the sprint plan, or
  `mcx track` should populate state.model at track time.
- **#1426** is the "disconnected session balloons to 100k+ tokens" bug.
  Cost risk — one instance in sprint 35 hit $2+ of runaway output. Fix
  should stop generation when the daemon detects disconnect. Opus,
  medium scrutiny.
- **#1385, #1386, #1352** are phase-pipeline polish. All independent.

### Batch 3 — Filler + rollover (backfill)
#1391, #1351, #1458, #1457, #1367

- **#1391** is a CI guard that asserts `run.ts` dispatches call
  `assertNoDrift`. Prevents regression of the drift-guard pattern.
- **#1351** server-side validates `initialPhase` against the manifest.
  Small.
- **#1458 + #1457** are the two most contained sites follow-ups from the
  #1454 contrib. Both independent, both small. The rest of the sites
  arc (#1453 Bun.WebView adapter, #1455 jq transforms, #1459 staleness
  detection, #1460 wiggle.js) is deferred — those are feature expansion
  work that deserves its own sprint or a dedicated owner.
- **#1367** is the core.bare repro harness (3rd-time rollover from
  sprints 36 + 37). Proves the sticky fix from #1330 holds under real
  `gh pr merge` conditions. Medium, opus.

## Dependency graph

```
  #1441 — independent (daemon worker spawn + tool-dispatch hook)
  #1445 — independent (work_items_update validation)
  #1446 — independent (scripts/check-coverage.ts)
  #1465 — independent (gc command / session-list fallback)
  #1344 — independent (manifest graph analysis)

  #1437 — depends on #1445 landing (shared file: work_items_update)
  #1426 — independent (daemon session lifecycle)
  #1385 — independent (phase log formatting)
  #1386 — independent (phase log CLI tests)
  #1352 — independent (work_item_transitions cleanup)

  #1391 — independent (CI grep script)
  #1351 — independent (work_items_update server validation — serialize with #1437)
  #1458 — independent (sites mergeHeaders)
  #1457 — independent (sites fetchFilter)
  #1367 — depends on #1330 (✅ landed long ago)
```

Hot-shared file watch:
- **work_items_update** — touched by #1445, #1437, #1351. Serialize across
  batches (batch 1 lands #1445 first, batch 2 #1437 after, batch 3
  #1351 after that) to avoid merge collisions on the dispatch table.
- **scripts/check-coverage.ts** — only #1446 touches it; no conflict.
- **`.claude/phases/impl.ts`** — #1437 touches it if the fix lives there;
  no other batch item touches phase sources.

## Excluded (with reasons)

- **Sites feature expansion** (#1453 Bun.WebView, #1455 jq transforms,
  #1459 staleness detect, #1460 wiggle.js) — deferred. All came in with
  the #1454 contrib and represent feature breadth rather than bug-fix
  depth. Needs a dedicated sprint or an owner.
- **#1397 merge-queue** (3rd-time rollover) — still stretch. Deferred
  again; revisit in sprint 39 if batch 3 finishes with capacity.
- **#1400** (import test failures) — still blocked by #1412, which
  remains an open issue with no PR.
- **#1416** (DEFAULT_TIMEOUT_MS constant) — pure cleanup, low priority.
- **#1392** (codex respawn race) — production-adjacent but still no
  reliable repro.
- **#1370, #1372, #1374** (manifest/NFS edge cases) — low-impact, no
  real-world reports.
- **#1353, #1354, #1355, #1356, #1361, #1365, #1366** — smaller phase/
  manifest polish; pulled into future sprints as filler.

## Risks

- **#1441 scope.** Full containment enforcement is the largest item on
  the board. If the impl session discovers the tool-dispatch interception
  requires daemon architectural changes beyond the current Bash wrapper,
  scope to minimum viable (just git-write deny on first attempt; defer
  the strike-counted Edit/Write layer to sprint 39) and file follow-ups.
- **#1445 surface area.** "Extend work_items_update to write phase state"
  is the right fix but might expand scope. Acceptable minimum: validate
  unknown keys as errors (option 3 in the issue body), so orchestrators
  at least get an error instead of a silent no-op.
- **Sites follow-ups may pull in owner.** If #1458/#1457 surface deeper
  issues with the `_site` worker lifecycle, file + defer. Don't let the
  sprint get pulled into site-feature work.

## Context

Sprint 37 shipped v1.6.0 (14 PRs, new `mcx site` command group from
contrib) and hardened worker containment partway (#1442 GIT_DIR pin,
#1443 sprint-active hook). #1425 still recurred 3× during the same
sprint — each from worker cwd drift combined with absolute-path Edit
tool calls, not covered by either landed fix. #1441 is the real answer.

Orchestrator-DX findings during sprint 37 drove #1437, #1445, #1465.
Fixing these makes sprint 38 (and every subsequent sprint) cheaper to
drive, regardless of the containment work.
