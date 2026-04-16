# Sprint 37

> Planned 2026-04-16 12:30 ET. Target: 15 PRs.

## Goal

**Harden the phase pipeline and stop flaky tests from blocking commits.**
Sprint 36 proved the pipeline works end-to-end for real customer bugs;
sprint 37 makes it reliable — polish the phase scripts, fix the CI
flakes that blocked commits during sprint 36, and land the merge-queue
service that removes the orchestrator's manual rebase/merge loop.

## Issues

| # | Title | Scrutiny | Batch | Model | Category |
|---|-------|----------|-------|-------|----------|
| **1424** | DX: triage error should say which field is missing, auto-populate branch from prNumber | medium | 1 | opus | rollover, DX |
| **1433** | flaky: server-pool.spec.ts SIGTERM timeout causes CI failures | low | 1 | sonnet | CI stability |
| **1422** | fix(tests): check-shell-injection.spec.ts false positive on comment line | low | 1 | sonnet | CI stability |
| **1419** | coverage CI: Bun exit-1 crash not handled same as exit-132 in check-coverage.ts | low | 1 | sonnet | CI stability |
| **1404** | flaky: cmdTrack tests fail intermittently (.mcx-worktree.json parse error) | low | 1 | sonnet | CI stability |
| **1350** | fix(phases): remove dead stubState from runPhase baseCtx | low | 2 | sonnet | phase polish |
| **1409** | fix(phases): unbound executePhase uses stable stateNamespace — state leaks between runs | medium | 2 | opus | phase polish |
| **1408** | fix(phases): defaultExecuteDeps.exec should return exitCode=1 on null (killed process) | low | 2 | sonnet | phase polish |
| **1430** | refactor(core): compareVersions convention is inverted — rename or add lint guard | low | 2 | sonnet | sprint-36 follow-up |
| **1400** | cmdImport spec: 4 failing tests on main (file source + --claude subprocess) | low | 2 | sonnet | CI stability |
| **1367** | repro harness: gh pr merge --delete-branch → core.bare=true | medium | 3 | opus | rollover |
| **1397** | feat(merge-queue): local deterministic merge-queue service (replaces mergemaster LLM) | high | 3 | opus | rollover, stretch |
| **1344** | feat(phases): detect and report cycles in manifest phase graph | low | 3 | sonnet | phase polish |
| **1385** | fix(phases): truncate long forceMessage in phase log table output | low | 3 | sonnet | phase polish |
| **1416** | refactor(timeout): extract DEFAULT_TIMEOUT_MS constant to prevent magic-number drift | low | 3 | sonnet | filler |

## Batch Plan

### Batch 1 — Rollovers + CI blockers (immediate)
#1424, #1433, #1422, #1419, #1404

- **#1424** is the sprint-36 rollover DX fix — the orchestrator hit this
  papercut 3–4 times during sprint 35 and once more during sprint 36.
  Auto-populate `branch` from `prNumber` on `work_items_update`, and
  make the triage error say which field is missing.
- **#1433, #1422, #1419, #1404** are all CI/test stability issues. #1433
  (`server-pool.spec.ts` SIGTERM) blocked CI during sprint 36; a related
  flaky test (`claude.spec.ts` daemon stderr leak) blocked commits during
  the retro phase. These four clean up the test suite so commits flow.

### Batch 2 — Phase polish + follow-ups (backfill)
#1350, #1409, #1408, #1430, #1400

- **#1350, #1409, #1408** are phase-pipeline internals: dead code removal,
  state namespace leaks, and null-process exit code handling. All small,
  well-scoped fixes that harden `mcx phase run`.
- **#1430** is the `compareVersions` naming issue surfaced by the #1413
  adversarial review during sprint 36.
- **#1400** is 4 failing import tests on main — should be quick now that
  #1412 (import fallback) has landed or is about to.

### Batch 3 — Heavier items + filler (backfill)
#1367, #1397, #1344, #1385, #1416

- **#1367** is the `core.bare=true` repro harness — proves the sticky fix
  from #1330 works under real `gh pr merge` conditions. Medium scrutiny.
- **#1397** is the merge-queue service — the biggest item in the sprint.
  Retires the LLM mergemaster for the common merge path. High scrutiny,
  adversarial review required. **Stretch** — don't block the sprint on it.
- **#1344, #1385, #1416** are quick phase-polish and refactoring wins that
  fill slots while heavier items cook.

## Dependency graph

```
  #1424 — independent (work_items_update + triage phase)
  #1433 — independent (server-pool.spec.ts)
  #1422 — independent (check-shell-injection.spec.ts)
  #1419 — independent (check-coverage.ts)
  #1404 — independent (cmdTrack test isolation)

  #1350 — independent (runPhase dead code)
  #1409 — independent (executePhase stateNamespace)
  #1408 — independent (executePhase exitCode)
  #1430 — independent (compareVersions rename)
  #1400 — depends on #1412 landing (import tests)

  #1367 — depends on #1330 (✅ landed)
  #1397 — depends on #1381 (✅ landed)
  #1344 — independent (manifest graph analysis)
  #1385 — independent (phase log formatting)
  #1416 — independent (constant extraction)
```

No two issues in the same batch modify the same files. #1400 depends on
#1412 landing first (auto-merge armed from sprint 36).

## Excluded (with reasons)

- **git-remote-mcx / VFS epic** (#1209 and ~15 children) — large arc,
  needs a dedicated sprint or epic-planner session
- **#1372** (NFS O_EXCL lockfile) — edge case, no reports of real corruption
- **#1392** (codex worker respawn race) — production-adjacent but no repro
- **#1426** (disconnected sessions) — daemon investigation, not sprint work
- **pull.spec.ts cluster** (#1264–1267) — all same root cause (test
  pollution), needs one dedicated investigation session
- **#1425** (worker committed to main) — mitigation in place (phantom-commit
  pre-flight check), root cause is behavioral not code
- **#1397 stretch caveat** — if merge-queue doesn't land, defer to sprint 38
  without counting it as a failure

## Risks

- **#1397 scope creep.** The merge-queue is the biggest item; if the impl
  session discovers it needs daemon-side changes beyond the current IPC
  surface, scope to the minimum viable (rebase + squash-merge for a single
  PR) and file follow-ups.
- **#1400 may expand.** The 4 failing import tests might have a deeper root
  cause than #1412's fix addresses. If so, file a new issue and move on.
- **Flaky test whack-a-mole.** Fixing 4 flaky tests may surface 2 more.
  File them but don't chase — the goal is net improvement, not zero flakes.

## Context

Sprint 36 shipped 4 customer bug fixes in ~60 minutes, proving the phase
pipeline works for real work. Two process gaps were fixed post-sprint:
repair phase now clears `qa:fail` labels, and QA now checks Copilot inline
comments before labeling. A flaky `claude.spec.ts` test was also fixed
when it blocked the retro commit. Sprint 37 builds on this by hardening
the pipeline internals and cleaning up the CI flakes that caused friction.

v1.5.2 is the current release. #1412 is auto-merge armed and should land
before sprint 37 starts.
