# Sprint 35

> Planned 2026-04-12 21:45 local. Updated 2026-04-13. Started 2026-04-14.
> **RE-PLANNED 2026-04-14** — original plan's premise invalidated. Target: ship prerequisites, then validate.

## ⚠️ Re-plan notice (2026-04-14)

**The original sprint-35 plan was built on a false premise: that v1.5.0
shipped a working phase-pipeline skill.** It didn't. During pre-flight
for the first `/sprint run`, the orchestrator discovered:

1. **`mcx phase run <name> --dry-run` does not execute the handler** —
   the global `--dry-run` flag is stripped in `main.ts` before `cmdPhase`
   sees it, so the command always falls through to the transition
   validator. Filed as **#1396** (brand new). No CLI path currently
   invokes a phase handler.
2. **Autonomous handler execution (#1381) is unimplemented** — the
   non-dry-run path is a transition recorder, not an executor. This is
   a known deliverable, but it was scheduled as a *peer* of other
   batch-1 work rather than a gate.
3. **`run.md`'s orchestrator loop is unusable as written** — it tells
   the orchestrator to parse `{action, command, prompt, ...}` from
   `mcx phase run ... --dry-run` output, but the CLI discards that
   output even when (after #1396) the handler runs. The loop silently
   no-ops.
4. **v1.5.0 was released as an RC under the assumption the pipeline
   worked.** It shipped.

Why this wasn't caught in sprint-34 retro: the prior orchestrator ran
to 345k tokens of context and produced unreliable "everything is done"
assertions well short of the 1M limit. Context-rot, not memory exhaustion.
The legacy instructions in the original sprint plan were the only reason
`/sprint run` could even start. **Note this in the retro.**

### What changed in this re-plan

- **Batch 1 is now a strict sequential gate**, not 5 parallel sessions.
- **#1396** and **#1349** promoted to batch 1 ahead of #1381.
- **#1383** promoted from batch 3 → batch 1 (recurred during pre-flight,
  filed comment on issue with fresh data).
- **Explicit validation checkpoint** added after #1381 lands — drive one
  small issue through real `mcx phase run` end-to-end. This is the
  actual skill-validation step. Original plan had none.
- **Meta task**: patch `run.md` to document the legacy-fallback path
  explicitly (not buried in recovery notes), since the orchestrator
  loop as written silently no-ops.
- **Target reduced 12 → "validation + as many backlog PRs as fit".**
  Success is not PR count; it's "the skill is either validated or
  demonstrably not-yet-validatable, with prereqs landed."

## Goal

**Primary:** validate the v1.5.0 phase-pipeline skill works end-to-end
(drive an issue through `mcx phase run` autonomously).

**Backup** (if primary blocks): land all prerequisites (#1396, #1349,
#1381, run.md patch) so that sprint 36 can be the first real validation
sprint. Either outcome is success — we stop chasing PR counts.

## Pre-flight observations (from today's start)

- Build ✅ v1.5.0, protocol hash `8071f2608a29`
- `.mcx.yaml` was **deleted from the working tree** on a clean branch
  (recurrence of #1383). Restored via `git checkout HEAD`. Comment filed
  on #1383 with fresh data.
- Quota monitoring `"available": false` (`"Quota monitoring not started"`).
  Flying blind on the 80%/95% gates. Unclear if this is a regression or a
  fresh daemon always starts cold. **File a meta issue during sprint.**
- 7 phases installed; lockfile matches sources.
- 5 batch-1 sessions were spawned then killed after the debug pivot
  (~$1 burned, partial work discarded, worktrees cleaned).

## Stage A: Prerequisite gate (sequential, solo sessions)

**These must land in order. Do not parallelize within Stage A.**

| Order | # | Title | Scrutiny | Model | Notes |
|-------|---|-------|----------|-------|-------|
| A1 | **1396** | phase run --dry-run flag stripped before cmdPhase | low | opus | ~1-line fix; unblocks everything else |
| A2 | **1349** | catch and format handler errors in phase run --dry-run | low | opus | needs A1 landed to be testable |
| A3 | **1381** | wire autonomous handler execution | **high** | opus | the big one; full-sprint cook acceptable |
| A4 | **META** | patch `run.md` to document legacy fallback explicitly + document #1396's effect on the orchestrator loop | — | orchestrator | 15-min meta commit, direct to main (admin bypass) |

After A1 lands, the orchestrator can verify by running:
```
mcx phase run impl --dry-run --work-item <tracked-id>
```
and asserting handler-computed JSON actually appears on stdout. If it
doesn't, A1 didn't land correctly and should be re-opened before A2.

After A3 lands: attempt validation (Stage B). **Do not proceed to Stage
C backlog work unless Stage B passes.**

## Stage B: Validation checkpoint (single session, orchestrator-driven)

Pick **one** small, contained issue from the backlog (e.g. #1388 — help
text doc fix). Drive it through the pipeline manually, using the real
(post-#1381) `mcx phase run` at each transition:

1. `mcx track <n>`
2. `mcx phase run impl --work-item <n>` → assert a session is spawned,
   session ID persisted into work item.
3. Let session produce PR.
4. `mcx phase run triage --work-item <n>` → assert decision emitted.
5. `mcx phase run <decision> --work-item <n>` → assert next phase
   progresses.
6. Continue to `done`.

**Pass criteria:** the orchestrator never hand-spawns a session after
Stage B begins. All transitions go through `mcx phase run`. Each phase's
handler output is visible and actionable.

**Fail criteria:** orchestrator has to fall back to legacy spawn at any
point → file a bug per failure, stop Stage C, declare sprint in "prereqs
landed, validation blocked" state.

## Stage C: Backlog (parallel, only if Stage B passes)

**Only start Stage C if Stage B's single issue merged end-to-end via
real pipeline.** Otherwise skip to wind-down.

### Batch C1 (high-value, independent)
| # | Title | Scrutiny | Model | Category |
|---|-------|----------|-------|----------|
| **1347** | Flaky: findGitRoot tests fail under pre-commit (GIT_DIR leak) | high | opus | root-cause of #1338 bypass |
| **1393** | CI retry wrapper swallows Bun segfault stderr | medium | opus | DX P1 |
| **1383** | test suite deletes root .mcx.yaml | medium | opus | infra hygiene (already recurred today) |

### Batch C2 (post-#1381 consumers)
| # | Title | Scrutiny | Model | Category |
|---|-------|----------|-------|----------|
| **1397** | feat(merge-queue): local deterministic merge-queue service | high | opus | sprint-34 retro insight; strict dep on #1381 |
| 1367 | repro harness: gh pr merge → core.bare=true | medium | opus | proves #1330 sticky fix |
| 1378 | quota: _errorLogged not reset when error type changes | low | opus | #1329 follow-up |
| 1377 | quota.spec.ts: replace fixed Bun.sleep with polling | low | opus | #1329 follow-up |
| 1372 | bug(phases): O_EXCL lockfile not atomic on NFS | medium | opus | #1328 follow-up |
| 1392 | Production: rapid codex worker respawn Bun module race | medium | opus | DX P2 |

### Batch C3 (filler — only if C1+C2 healthy)
| # | Title | Scrutiny | Model | Category |
|---|-------|----------|-------|----------|
| 1388 | fix(claude-wait): help text says --timeout default 300000 | low | sonnet | (may be consumed by Stage B) |
| 1384 | CI grep-check: assert detectDrift call in phase run case | low | sonnet | #1346 follow-up |

### Excluded from sprint 35 (push to 36)
- **Phase-pipeline polish**: #1350 (dead stubState), #1313 (wire parseSource
  into install), #1344 (cycle detection), #1343 (installedAt field),
  #1351 (validate initialPhase), #1352 (orphan transition rows), #1353
  (workItemResolver timeout), #1370 (loadManifest ENOENT race),
  #1375 (transitions.jsonl rotation), #1385 (truncate forceMessage),
  #1386 (combined --json+--work-item test), #1391 (assertNoDrift CI).
  Good sprint-36 batch: a polish sprint for the now-validated pipeline.
- **Originals deferred**: #1356 (close after #1347), #1361/#1319 (JSDoc),
  fast-import cluster, #1300/#1398 (mcx gc daemon unreachable — needs
  repro), #1355 (cosmetic).

## Meta items (orchestrator-applied, NOT sprint items)

Apply during the sprint on main. Items from the original plan + new:

1. **Patch `run.md`** to surface legacy-fallback path (Stage A meta
   item; deliverable of Stage A4).
2. **File meta issue**: quota monitoring cold-start `"available":
   false` — why? Investigate during or after sprint.
3. **Block `--no-verify` via Claude settings hook** (carried from
   original plan; user + orchestrator agree on shape; not urgent).
4. **User: enable `required_review_thread_resolution` on main ruleset**
   (carried; backstop for 4-surface check).
5. **Consider `enforce_admins: true`** (carried; user call).

Already done in sprint-34 wind-down (commit `20dbd268`): 4-surface
enumeration in run.md, self-repair pattern, auto-merge re-arm,
dual-label audit, transactional QA label-swap, `mergemaster.md`,
branch/worktree cleanup.

## Success criteria

**Primary success:** Stage B passes. One issue merged end-to-end via
real `mcx phase run`. Sprint 36 can open the aperture to full
autonomous sprints.

**Backup success:** #1396, #1349, #1381 merged. Stage B attempted and
documented (pass or fail). run.md patched to match reality. Retro
captures the context-rot failure mode that caused this re-plan.

**Failure:** Stage A doesn't complete within sprint budget. Escalate
to user before extending — we need to understand why (is #1381 bigger
than scoped? is there a deeper architecture problem?).

## Risks

- **#1396 could hide other bugs.** Once --dry-run actually runs the
  handler, we may discover handlers throw on `ctx.workItem=null` (the
  Copilot premise from #1380). #1349 lands immediately after to make
  those errors legible.
- **#1381 may require a new architectural decision.** If phase handlers
  can't safely spawn sessions without orchestrator oversight, #1381 may
  need to ship as "gated autonomous" (dry-run + confirm) first. Budget
  the full sprint for it; don't rush.
- **Context rot in the orchestrator itself.** This re-plan exists
  because the prior orchestrator asserted "done" on things that weren't.
  Mitigation: smaller batches, frequent checkpoints, explicit pass/fail
  criteria (Stage B has them), retro captures warning signs.
- **Original plan's risks carry forward**: #1347 still flaky across
  sprints; mergemaster scaling without #1397; skill-file patches
  unproven under load.

## What this plan is *not* doing

- **Not targeting 12 PRs.** That target came from the original plan
  under a false premise.
- **Not running the mergemaster at kickoff.** Wait until Stage B passes
  and C1 is in flight — otherwise nothing for it to do.
- **Not attempting Stage C if Stage B fails.** Shipping more backlog
  via legacy spawn while the pipeline is unvalidated defeats the
  sprint's purpose.
