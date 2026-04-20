# Sprint 39

> Planned 2026-04-19. Started 2026-04-19 (after #1489 unblock). Target: 15 work PRs + 5 direct closures = 20 issues.

## Goal

**Clear the way.** Resolve sprint 38 containment-anchor follow-ups, land
the two dangling PRs from prior crashouts, close stale issues whose root
causes are already fixed, and fix the rough edges that have been accumulating.
No anchor. No big epic. The `mcx monitor` epic (#1486) is explicitly
**deferred to sprint 40** — this sprint creates the runway for it.

## Issues (work — need PRs)

| # | Title | Scrutiny | Batch | Model | Category |
|---|-------|----------|-------|-------|----------|
| **1475** | containment: Bash file writes bypass (full fix) | medium | 1 | opus | #1441 follow-up |
| **1480** | containment: resolve() uses daemon cwd, not session cwd | low | 1 | sonnet | #1441 follow-up |
| **1481** | containment: no symlink resolution (realpathSync) | low | 1 | sonnet | #1441 follow-up |
| **1482** | containment: no recovery after 3-strike escalation | medium | 1 | sonnet | #1441 follow-up |
| **1468** | feat: phase_state_get/set/list tools on _work_items | medium | 1 | opus | monitor-epic prep |
| **PR #1429** | dangling: fix(import) fallback — address 4 Copilot comments + land | low | 2 | sonnet | dangling |
| **PR #1399** | dangling: ci upload logs — rebase + QA + land | low | 2 | sonnet | dangling |
| **1484** | scripts/check-phase-drift.spec.ts excluded from test runs | low | 2 | sonnet | test gap |
| **1255** | mcx claude bye deletes local branch while remote PR still OPEN | medium | 2 | sonnet | recurring bug |
| **1267** | pull.spec.ts leaks git commits to parent repo under pre-commit | medium | 2 | opus | persistent flaky |
| **1302** | t5801-32/33 remote-helper — protocol doesn't surface handler errors | medium | 3 | opus | flaky (canonical of cluster) |
| **1314** | flaky: git-remote-helper.spec.ts 'requires GIT_DIR' test env isolation | low | 3 | sonnet | flaky |
| **1416** | refactor: extract DEFAULT_TIMEOUT_MS constant | low | 3 | sonnet | filler |
| **1356** | phase.spec.ts: biome violation not caught before merge (process fix) | low | 3 | sonnet | CI process |
| **1343** | feat(phases): add installedAt field to LockedPhase | low | 3 | sonnet | filler |

## Direct closures (completed during planning)

Closed at plan time — no sessions spawned:

| # | Title | Reason |
|---|-------|--------|
| **1488** | P0: worker #1437 escaped worktree | Fixed by #1441 anchor; pre-anchor worker repro conditions no longer exist |
| **1425** | worker committed directly to main during sprint | Same — anchor's `GIT_WRITE_SUBCOMMANDS` covers `commit` + `checkout` vectors |
| **1301** | failing: t5801-32/33 expect reject got resolve | Dup of #1302 (canonical) |
| **1306** | test(clone): t5801-32/33 error tests resolve instead | Dup of #1302 |
| **1309** | Flaky: t5801-32/33 integration tests fail on main | Dup of #1302 |
| **1315** | Flaky: t5801-32/33 provider error tests resolve | Dup of #1302 |

## Meta applied during planning

- **#1479** — added `.claude/commands/repair.md` (commit `f36c84c4`). The
  skill is now loaded; sprint 39 dangling-PR work in batch 2 can use
  `/repair` instead of re-sending prose prompts.

## Batch Plan

### Batch 1 — Containment follow-ups + monitor-epic prep (immediate)
#1475, #1480, #1481, #1482, #1468

All four containment issues touch `packages/daemon/src/claude-session/containment.ts`.
Serialize as follows to avoid merge conflicts on that file:

- **Start in parallel:** #1480, #1481 (both small, each touches a different
  narrow function: `isPathOutside` for #1480, `realpathSync` wrapper for
  #1481). Land either one first, rebase the other.
- **Start after either lands:** #1482 (needs `ContainmentGuard.reset()`
  method; clean surface area). Rebase onto the post-#1480/#1481 tip.
- **Anchor spot, opus:** #1475 (architectural — may need a Bash command
  parser; biggest risk in the sprint). Land last in batch 1.
- **Independent track, opus:** #1468 (phase_state tools, touches
  `work-items-server.ts`). Can run in parallel with all of the above
  without conflict.

### Batch 2 — Dangling PRs + rough bugs (backfill)
PR #1429, PR #1399, #1484, #1255, #1267

- **PR #1429** (#1412) and **PR #1399** (#1393) are dangling — both need
  repair-style work (address Copilot + rebase). Use the new `/repair`
  skill added during planning (#1479 meta application).
- **#1484** (phase-drift.spec not running) — narrow fix in `bunfig.toml`
  or move the spec to `packages/`.
- **#1255** (bye deletes local branch while PR open) — fix in the `bye`
  command's git-branch-cleanup logic. Verify remote PR state before
  deleting.
- **#1267** (pull.spec.ts leaks commits) — persistent flaky. Opus. Needs
  `env: cleanEnv()` passed to the `execSync` calls at lines 454 and 473.

### Batch 3 — Remaining rough edges (backfill)
#1302, #1314, #1416, #1356, #1343

- **#1302** is the canonical flaky-test root cause (protocol doesn't
  surface handler errors) — opus, deep fix.
- **#1314** is separate flaky bug (env isolation). Small.
- **#1416** (DEFAULT_TIMEOUT_MS) — mechanical refactor across 9+ files.
- **#1356** (biome violation process escape) — CI/hook gate improvement.
- **#1343** (installedAt per phase) — clean small feature.

## Dependency graph

```
#1475 — independent (containment.ts — biggest change)
#1480 — independent (containment.ts — narrow function)
#1481 — independent (containment.ts — narrow function)
#1482 — independent (containment.ts — new method)
#1468 — independent (work-items-server.ts)

PR #1429 — dangling, just needs repair + land
PR #1399 — dangling, just needs rebase + QA + land
#1484 — independent (bunfig.toml or file move)
#1255 — independent (claude-commands.ts bye handler)
#1267 — independent (pull.spec.ts)

#1302 — independent (clone/src/engine + remote-helper)
#1314 — independent (git-remote-helper.spec.ts)
#1416 — TOUCHES 9+ FILES across packages — hot-shared
#1356 — independent (CI workflow or pre-commit hook)
#1343 — independent (manifest.ts, LockedPhase type)
```

**Hot-shared file watch:**
- `containment.ts` — #1475, #1480, #1481, #1482 all touch. Serialize
  within batch 1 as described above.
- `DEFAULT_TIMEOUT_MS` rollout (#1416) touches 9+ files. Serialize as
  batch 3's final merge; all other batch 3 PRs can merge first.

## Excluded (with reasons)

- **#1486 mcx monitor epic** — next sprint's anchor. Needs its own plan
  phase and ~3-5 issues spawned from the design (streaming IPC, bus,
  seq/replay, heartbeat, per-category enrichers). Sprint 39 clears the
  runway.
- **#1479 /repair slash command** — applied directly on main during
  planning step 1a (meta), not a sprint item.
- **Sites feature set** (#1453, #1455, #1459, #1460) — no owner,
  non-critical, deferred indefinitely or until a dedicated site sprint.
- **#1392 codex respawn race** — still no reliable repro.
- **#1400 cmdImport spec failures** — blocked on #1412 (landing via
  PR #1429 this sprint may unblock; re-evaluate in sprint 40 retro).
- **#1397 merge-queue** — rollover candidate, but the post-#1486
  "merge-then-verify-main-CI" design supersedes the original
  `mcx merge-queue` scope. Re-spec after #1486 lands.
- **#1370, #1372, #1374, #1361, #1319** — low-impact manifest/NFS edge
  cases; pull into a future filler sprint.

## Risks

- **#1475 scope cliff.** Bash file-write detection is a best-effort
  regex today (sprint 38 added partial coverage: `cp`, `mv`, `tee`, `>`
  redirects). Full coverage needs a real shell parser. If the session
  discovers a shell parser is architecturally required, scope to
  "extend the existing regex for the 5-10 most common missed patterns
  and file a deeper follow-up." Don't let this become the sprint.

- **#1267 persistent flakiness.** This is the 4th-ish attempt at
  de-flaking pull.spec.ts. If a `cleanEnv()` addition doesn't do it,
  escalate to "quarantine the test into a separate runner invocation
  that sets GIT_DIR/GIT_WORK_TREE=... before `bun test`."

- **PR #1399 merge conflict resolution.** The DIRTY state means the
  18-line CI YAML change conflicts with sprint 38's #1477 (phase-drift
  guard) or #1466 (SIGSEGV retry). Conflict resolution could be trivial
  (just re-apply the artifact upload steps) or could require
  re-reasoning about the YAML structure. Budget a bit more than the
  18-line diff suggests.

## Merge strategy

We have full parallel merge authority (strict_required_status_checks_policy
= false on ruleset 13509324). Use it:

- Drop the single-pointer rebase cascade from sprint 38.
- Land PRs in batch-completion order — parallel QA + parallel merge.
- Watch main CI on the last-merge of each batch; halt + remediate if red.
- Document the "merge-then-verify-main-CI cluster" pattern in `run.md`
  once proven out for a second time this sprint. (Sprint 39 retro may
  promote it to a first-class phase handler.)

## Context

Sprint 38 shipped v1.6.1 (14 PRs, orchestrator reliability anchor
#1441). It also exposed two reusable wins worth entrenching:

1. **Dropping strict merge-up-to-date** is the #1 orchestrator
   throughput improvement this quarter. Sprint 39 runs with it on by
   default — expected per-PR land time: minutes, not the hour-plus
   of serialized rebase cascades.
2. **Anchor-first serialization** for containment-sensitive sprints —
   not applicable here since no anchor, but documented for the next
   containment-touching sprint.

#1488 and #1425 close during planning because their root cause shipped
in sprint 38. Five flaky-test duplicates consolidate to #1302. The
dangling PR tails (#1399, #1429) land in batch 2.

With 15 work PRs + 5 closures in a sprint where every PR should QA-pass
on first try (no new architectural ground), wall-time target is
**~2 hours, similar to sprint 38 but with zero rebase cascade overhead.**

## Results (2026-04-19)

**13 PRs merged** (target 15) + **9 closures** (target 5) = **22 items resolved** (target 20). Met target.

### Merged PRs
| # | PR | Notes |
|---|-----|-------|
| 1489 | — | **Pre-flight: bundler fix**. @mcp-cli/core import in impl.ts failed to bundle; externalized + strip pass rewrite; unblocked /sprint 39. |
| 1480 | #1490 | containment resolve() sessionCwd. Self-repair on 4 Copilot inline comments. |
| 1481 | #1491 | symlink realpath. 3 QA rounds — CI-trigger gap forced workflow_dispatch; Eve found 2 real bypasses beyond the original scope (multi-segment dirname walk, prefix-check realpath). |
| 1482 | #1494 | ContainmentGuard.reset(). Adversarial review caught 2 blockers; self-repair clean. |
| 1468 | #1492 | phase_state tools. Adversarial review caught namespace mismatch — tools wrote to dead bucket. Carol repaired. |
| 1484 | #1493 | scripts/*.spec.ts in CI. |
| 1343 | #1496 | installedAt field. |
| 1314 | #1497 | GIT_* env isolation. |
| 1255 | #1498 | bye branch with open PR. |
| 1416 | #1499 | DEFAULT_TIMEOUT_MS constant. Reviewer self-repair path saved a repair session. |
| 1475 | #1503 | Bash write detection (sed, dd, curl, wget). Pam kept scope bounded per risk note. |
| PR #1429 | merged | Dangling `/repair`; qa:pass retained. |
| PR #1399 | merged | Dangling; rebase + fresh QA. |

### Direct closures during sprint
- **#1302, #1267, #1356** — workers discovered already-fixed or pure-config issues; closed with evidence.

### Direct closures from planning
- **#1488, #1425, #1301, #1306, #1309, #1315** — 6 items closed at plan time.

### Outstanding issues discovered mid-sprint
- **#1491 CI trigger gap**: `pull_request` event did not fire on rapid force-pushes to existing PRs; required `workflow_dispatch` + eventual rebase to trigger required checks. Worth filing.
- **`work_items_update` setting prNumber=0 / prState="null"** when passed JSON `null` — should accept null and clear the field.
- **`mcx untrack pr:NNNN`** rejected "Invalid number" — untrack should accept the same IDs `tracked` emits.
- **QA premature qa:fail on pending CI** — already captured as `feedback_qa_ci_pending.md` memory.

### Cost / throughput
- 24 sessions spawned across impl/review/qa/repair.
- Reviewer self-repair (#1494, #1499) shipped fixes without fresh opus sessions — pattern continues paying.
- Bob's #1491 arc (4 repair rounds) was the sprint tail — finding real bugs, not noise.

### What's next (sprint 40 anchor)
`mcx monitor` epic (#1486) — the runway is clear. Phase-state tools (#1468) are now in place as a prerequisite. Batch 3 fillers drained.

