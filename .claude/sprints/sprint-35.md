# Sprint 35

> Planned 2026-04-12 21:45 local. Updated 2026-04-13. Target: 12 PRs (reduced from 15 — see "Velocity" below).

## ⚠️ Read this first: be a test pilot, not a zombie NPC

**Sprint 35 runs on freshly-landed tooling.** Sprint 34 shipped `.mcx.yaml` +
the phase script pipeline (#1299/#1380) plus several adjacent PRs that
together rewrote how sprints are *supposed* to execute. None of it has been
load-tested under real sprint conditions yet. **You are the first person
flying this airframe.** Expect:

- **Phase scripts that work in `--dry-run` may behave differently under real
  execution** (#1381 is what wires real execution; until it lands you're
  running the old way for transitions and the new way for inspection).
- **Skill files (`run.md`, `qa.md`, `adversarial-review.md`) just got nudge
  patches** for sprint-34 lessons. Some of those nudges may be wrong or
  incomplete. If a worker does something stupid because of a skill
  instruction, the skill is wrong, not the worker.
- **Comment-surface enumeration** (the 4 PR-comment-surfaces orchestrator
  check) is **brand-new orchestrator discipline** for this sprint. Sprint 34
  got burned because nobody checked. Sprint 35 you have to actually do it.
- **The release-train (`agents/mergemaster.md`) is one sprint old.** It has
  known bugs (auto-merge re-arm after force-push). Doc'd in `run.md` →
  "Orchestrator-only nudges". Watch the train's queue depth.
- **GitHub branch protection now requires PRs** for main. The orchestrator
  has admin bypass for meta commits, but workers cannot push direct.

### Be alert for these failure modes

| Symptom | Likely cause | Action |
|--|--|--|
| Worker says "command not found: mcx phase X" | Worker's binary is stale (didn't pick up new build) | `mcx shutdown && mcx status`, then verify the worker spawned after restart |
| Phase script throws on `ctx.workItem` | You ran `mcx phase run X --dry-run` for a phase that requires work-item context. Use real run via #1381 once it lands, or skip dry-run preview for those phases | Check `docs/phases.md` for which phases support dry-run |
| QA approves PR but Copilot has 17 unaddressed inline comments | The 4-surface check wasn't done at orchestrator level | Stop, enumerate (run.md → "Before approving qa:pass"), repair |
| Mergemaster session "polls forever" on a clean PR | Auto-merge invalidated by a prior force-push | `gh pr view N --json autoMergeRequest`; if null, re-arm with `gh pr merge N --squash --delete-branch --auto` |
| qa:pass and qa:fail both on PR | Old QA didn't swap labels transactionally; new QA did but didn't see the pre-existing label | Strip both, re-run QA, file a follow-up bug |
| `core.bare=true` recurrence | Sticky fix from #1330 — should be rare now, but check `git config core.bare` if any git op fails strangely | Hot-patch with `git config core.bare false` |
| #1373/#1387-style merge conflicts mid-sprint | Branches landed in a different order than impl | Spawn a one-shot rebase worker per `run.md` "Sweeping main commits" |

### When to STOP the sprint

Pause and report to the user **immediately** if any of:

- Two or more workers fail in the same way (could be skill-file bug).
- The orchestrator skill produces a directive the orchestrator can't follow
  (means the skill is internally inconsistent — likely from sprint-34
  patches).
- A phase script behaves differently in `--dry-run` vs real run AND that
  divergence affects sprint correctness (not just preview accuracy).
- Mergemaster sends `ESCALATE: <anything>` (per its prompt, this means it
  hit something it can't handle).
- More than 2 PRs need rebase-workers for merge conflicts in a single
  batch (suggests bigger coordination problem).
- Any PR that *should* qa:pass keeps failing repeatedly with no clear
  cause — could be a regression in QA itself.

The goal of sprint 35 is **prove the new tooling works under load**, not
"hit 15 PRs." If you have to stop early to fix tooling, that is the
correct outcome.

## Quick guide: old way vs new way

For each phase, here's what the prose pipeline used to do, what the phase
script does now, and what to do if the new way breaks.

### `impl`

- **Old:** orchestrator chose model + provider + flags; spawned via prose.
- **New:** `mcx phase run impl --dry-run --work-item #N` returns
  `{action:"spawn", model, command, prompt, allowTools}`; orchestrator
  executes the command verbatim. Phase script picks model (opus default,
  sonnet for docs, opus for flaky).
- **Recovery:** if `mcx phase run impl` errors, fall back to the old
  pattern: `mcx claude spawn --worktree -t "/implement N" --allow Read
  Glob Grep Write Edit Bash ExitPlanMode EnterPlanMode` and track via
  `mcx track N`.

### `triage`

- **Old:** orchestrator ran `bun .claude/skills/estimate/triage.ts --pr N
  --json` after impl finished; manually read `scrutiny`, decided next phase.
- **New:** `mcx phase run triage --work-item #N` does the same but emits a
  decision (`{decision: "review" | "qa", scrutiny, reasons, prNumber}`).
- **Recovery:** if the new path errors, fall back to running
  `triage.ts --pr N --json` directly and inspecting yourself.

### `review`

- **Old:** orchestrator spawned an adversarial-review session, read its
  posted sticky comment, decided next phase based on 🔴/🟡 count.
- **New:** `mcx phase run review --work-item #N` spawns on first entry,
  re-enters to read the sticky on subsequent ticks, routes to repair/qa
  based on found markers. Caps at 2 rounds → `needs-attention`.
- **Recovery:** if the phase script gets confused about whether a session
  is in flight (state read of `review_session_id`), check
  `mcx call _work_items work_items_get '{"id":"#N"}'` and either clear
  the stale session ID or wait for the active one to complete.

### `repair`

- **Old:** orchestrator manually decided micro-repair vs fresh opus, spawned
  accordingly.
- **New:** `mcx phase run repair --work-item #N` spawns opus on a fresh
  worktree with context-aware prompt (reads `previous_phase` to differentiate
  review vs QA paths). Caps at 3 rounds → `needs-attention`.
- **Recovery:** the **micro-repair pattern (orchestrator nudge)** isn't
  inside the phase script — orchestrator still does it manually via
  `send`. See `run.md` → "Reviewer self-repair".

### `qa`

- **Old:** orchestrator spawned QA, waited for `qa:pass`/`qa:fail` label.
- **New:** `mcx phase run qa --work-item #N` spawns sonnet QA on first
  entry; re-entry reads PR labels for `qa:pass`/`qa:fail`, routes to
  `done` or `repair`. Caps `qa_fail` at 2 → `needs-attention`.
- **Recovery:** if QA emits `qa:pass` but the orchestrator's 4-surface check
  finds open Copilot threads, transition back to `repair` with explicit
  guidance, not via the phase script (since the phase script can't see the
  surfaces). Manual `mcx call _work_items work_items_update '{"id":"#N",
  "phase":"repair", "force": true, "forceReason": "open inline comments"}'`.

### `done`

- **Old:** orchestrator did `gh pr merge --squash --delete-branch`.
- **New:** `done.ts` checks `qa:pass` + green CI, calls merge, clears
  scratchpad. **Auto-merge re-arm is NOT yet inside `done.ts`** — that's
  the mergemaster's job today, will move into the merge-queue service in
  #1397.
- **Recovery:** if `done` returns `{merged: false, error: {...}}`, read the
  error.reason. Common: "behind" (rebase needed — let mergemaster handle),
  "qa:pass missing" (re-run QA), "ci:red" (real failure, repair).

### `needs-attention`

- **Old:** didn't exist as a formal state — orchestrator just stopped and
  asked the user.
- **New:** posts an escalation comment on the PR, strips stale QA labels,
  marks the work item. Orchestrator surfaces these to user at end-of-tick.
- **Recovery:** if a work item ends up here, read the comment for the
  reason and decide manually whether to (a) drop the issue from the
  sprint, (b) hand-craft a repair, or (c) close as won't-fix.

## Velocity

**Reduced target from 15 → 12 PRs** to budget for tooling debugging. The
extra 3-PR slack lets you stop and fix without missing the goal. If by
batch 2 the new tooling is behaving, increase batch 3 size to recover.

## Goal

**Prove the v1.5.0 tooling under load + close the dogfood aftermath.**
Sprint 34 shipped `.mcx.yaml` + the phase pipeline + the mergemaster
discovery; sprint 35 stress-tests all of it on a realistic workload while
clearing the highest-value follow-ups. The autonomous handler execution
(#1381) and merge-queue service (#1397) are the v1.6.0 stretch goals.

## Meta (orchestrator-applied directly on main, NOT sprint items)

Apply during plan phase per `plan.md` Step 1a. Items already done during
sprint-34 wind-down are noted; remaining items are the user's call:

1. **Block `--no-verify` via Claude settings hook.** `.claude/settings.json`
   PreToolUse hook that scans Bash `command` for `--no-verify` on `git
   commit|push` and exits non-zero. Prevents recurrence of #1338's
   formatter-bypass. *Status: open — needs orchestrator + user to agree on
   shape.*
2. **User: enable `required_review_thread_resolution` on main ruleset.**
   Backstop for the 4-surface check — unresolved threads block merge at
   GitHub level. *Status: open — user-initiated.*
3. **Consider `enforce_admins: true` on main ruleset.** *Status: open —
   user call. Currently the orchestrator depends on admin bypass for meta
   commits, so flipping this to true requires a new bypass design.*
4. **DONE in sprint-34 wind-down:** orchestrator-side `run.md` updated with
   4-surface enumeration, self-repair pattern, auto-merge re-arm, dual-label
   audit (commit `20dbd268`).
5. **DONE in sprint-34 wind-down:** `qa.md` got transactional label-swap.
6. **DONE in sprint-34 wind-down:** `agents/mergemaster.md` written.
7. **DONE in sprint-34 wind-down:** branch/worktree/remote-ref cleanup
   (1181→399 branches, 25→3 worktrees, 107 dead remote refs pruned).

## Issues

| # | Title | Scrutiny | Batch | Model | Category |
|---|-------|----------|-------|-------|----------|
| **1347** | **Flaky: findGitRoot tests fail under pre-commit (GIT_DIR leak)** | **high** | **1** | **opus** | **root-cause of #1338 bypass** |
| 1393 | CI retry wrapper swallows Bun segfault stderr (bun.report URLs lost) | medium | 1 | opus | DX P1 — memory rule says always open those URLs |
| 1378 | quota: _errorLogged not reset when error type changes | low | 1 | opus | #1329 follow-up |
| 1377 | quota.spec.ts: replace fixed Bun.sleep() with polling | low | 1 | opus | #1329 follow-up; test hygiene |
| **1381** | **feat(phases): wire autonomous handler execution (phase run without --dry-run)** | **high** | **1** | **opus** | **dogfood v2 — real execution** |
| **1397** | **feat(merge-queue): local deterministic merge-queue service** | **high** | **2** | **opus** | **sprint-34 retro insight; depends on #1381** |
| 1367 | repro harness: gh pr merge --delete-branch → core.bare=true | medium | 2 | opus | #1330 follow-up — proves sticky fix |
| 1372 | bug(phases): O_EXCL lockfile not atomic on NFS | medium | 2 | opus | #1328 follow-up |
| 1392 | Production: rapid codex worker respawn may hit Bun module-resolution race | medium | 2 | opus | DX P2 |
| 1388 | fix(claude-wait): help text says --timeout default is 300000 | low | 3 | sonnet | #1341 follow-up; doc fix |
| 1383 | bug: something in the test suite deletes root .mcx.yaml | medium | 3 | opus | test hygiene |
| 1384 | CI grep-check: assert detectDrift call in phase run case | low | 3 | sonnet | #1346 follow-up |

**Excluded from active list (deferred to sprint 36):** #1375 (transitions.jsonl
rotation), #1385 (truncate forceMessage), #1386 (combined --json+--work-item
test), #1391 (assertNoDrift CI grep). All are filler-tier; bumped to make room
for tooling-debugging slack.

## Batch Plan

### Batch 1 (immediate — flaky root cause + dogfood v2 + quota cleanup)
#1347, #1393, #1378, #1377, #1381

- **#1347** is THE root cause that led to #1338's `--no-verify` bypass.
  Fixing it removes the last "legitimate" reason anyone would use
  `--no-verify`, reinforcing the settings-hook block from meta item 1.
- **#1381** is dogfood v2 — autonomous handler execution. Big, full-sprint
  cook. Without it, the phase scripts only run via `--dry-run` for preview
  and orchestrator still drives transitions manually. After it lands,
  sprint 36 can be the first fully-autonomous sprint.
- **#1393** is blocking a memory-compliance rule (always open bun.report
  URLs; if CI swallows them, can't open them).
- #1377/#1378 are quota-related #1329 follow-ups; small but non-trivial.

### Batch 2 (after Batch 1 starts settling — phase + DX hardening)
#1397, #1367, #1372, #1392

- **#1397** is the merge-queue service that retires the LLM mergemaster
  for the common case. Depends on #1381 for autonomous execution support.
- **#1367** proves #1330's sticky fix actually works under real `gh pr
  merge` conditions. If it doesn't, fourth recurrence to diagnose.
- #1372 (NFS) is non-blocking but worth flagging while code is fresh.
- #1392 (Bun module-resolution race) is production-adjacent — cheap if
  reproducible.

### Batch 3 (filler — only if batch 1+2 are healthy)
#1388, #1383, #1384

- All three are small, low-risk filler. Pull from this batch if tooling is
  cooperating; skip if you're spending cycles on pilot debugging.

## Dependency graph

```
  #1347 ── unblocks #1356 closure (GIT_DIR root cause) — standalone
  #1381 ── depends on #1299 landed (✅)
  #1397 ── depends on #1381 (autonomous execution) — batch 2 starts after #1381 PR is up
  #1367 ── depends on #1330 landed (✅)
  #1377/#1378 ── depend on #1329 landed (✅)
  #1372 ── depends on #1328 landed (✅)
  #1383 / #1384 / #1388 / #1392 ── all independent
```

Critical path: #1347 (unblocks `--no-verify` retirement), #1381→#1397 (v1.6.0
autonomous-execution gate).

## Apply from sprint 34 retro

- **Spawn release-train at sprint kickoff**, not at wind-down. Per
  `agents/mergemaster.md` spawn template. Enqueue PRs as each hits
  `qa:pass` via `mcx claude send <id> "add PR #N to your queue"`.
- **Reviewer self-select for repair vs opus.** Per `run.md` →
  "Reviewer self-repair". Saves ~$10–15 per repair when contained.
- **Rebase-before-QA when main has advanced** since impl start. Add to
  QA's spawn message: "First rebase on origin/main, then verify."
- **4-surface comment enumeration before approving any qa:pass.** Per
  `run.md` → "Before approving qa:pass for merge". Sprint 34's
  cautionary tale: PR #1380 had 17 unaddressed inline comments before
  this got caught.
- **Auto-merge re-arm after force-push.** Mergemaster handles this in
  agent prompt; if orchestrator drives merges directly, see `run.md` →
  "Auto-merge re-arm".
- **`--no-verify` blocker hook** installed at plan time per meta item 1.
- **Don't `bye` workers stuck on upstream-blocked CI.** Leave idle, send
  rebase + re-run when upstream lands.

## Risks

- **Tooling regression masquerading as worker error.** Sprint 34 ended
  with the `.mcx.yaml`/phase pipeline freshly landed. If sprint 35 sees
  workers do something stupid, your first hypothesis should be "the
  freshly-patched skill or phase script is wrong," not "the worker is
  bad." File the meta bug, hot-patch, continue.
- **#1381 (autonomous execution)** is the biggest unknown. If phase
  handlers can't safely execute without orchestrator oversight (spawn
  sessions, push PRs), this may need to land as "gated autonomous"
  (dry-run + confirm) before full autonomy. Budget the full sprint.
- **#1347 (GIT_DIR leak)** has been flaky across multiple sprints. Real
  fix requires understanding why pre-commit's `git commit` context leaks
  GIT_DIR into the test process — may need subprocess-isolation or
  env-var scrubbing.
- **Mergemaster scaling.** Without #1397 deployed yet, all 12 PRs go
  through the LLM mergemaster again. If the queue gets stuck, fall back
  to manual rebase workers per PR (sprint 34 endgame pattern).
- **Skill-file patches from sprint 34 are unproven.** `run.md` got ~150
  lines of new orchestrator nudges; they may be wrong or contradictory.
  Watch for orchestrator confusion, not just worker confusion.

## Excluded

- **#1365** — instrument shim prune paths: overlaps with #1330's own fix
  (already has shim probes). Close as done or fold into #1367 harness.
- **#1366** — core_bare_healed_total metric: low-urgency operational
  improvement.
- **#1374** — sweepCoreBare cwd fallback test: already added during
  #1330 repair; close.
- **#1356** — already investigated this sprint; close after #1347 lands.
- **#1361, #1319** — JSDoc fixes: trivial; fold into a docs polish sprint.
- **fast-import cluster** (#1277–#1281, #1311, #1312, #1323) — designated
  git-remote-mcx sprint.
- **#1300** (mcx gc: daemon unreachable) — partially covered by #1398
  (sprint-34 filing); needs repro steps.
- **#1355** (worktree nag lacks repo path) — cosmetic.
- **Older backlog** (#1049, #935, #698) — not ready.

## Stretch (only if everything is going great)

If the sprint is unexpectedly smooth (no tooling debugging needed), pull
from sprint 36 candidate list:

- **Cross-swarm mail design discussion** — file the issue first.
- **`enforce_admins: true` on ruleset** with new bypass design.
- Any of the 4 deferred fillers: #1375, #1385, #1386, #1391.

Don't take stretch work unless batches 1 + 2 are entirely landed and the
new tooling is verifiably stable.
