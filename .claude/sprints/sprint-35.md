# Sprint 35

> Planned 2026-04-12 21:45 local. Target: 15 PRs. *(Draft — pending user review)*

## Goal

**Internalize sprint-34 lessons and close the dogfood aftermath.** Sprint 34 shipped `v1.5.0-rc.2` (15 PRs), surfaced the release-train pattern (user-invented), and produced a long tail of follow-up issues from the #1299 dogfood and #1330 core.bare sticky fix. Sprint 35 picks up that fallout: the #1347 flaky-test root cause that caused #1338's `--no-verify` bypass, the quota regressions from #1329, the phase polish from #1299, and starts autonomous handler execution (#1381) — the logical next step after #1299 shipped the declarative manifest.

## Meta (orchestrator-applied, NOT sprint items)

Apply directly on main during plan phase per `plan.md` Step 1a:

1. **Block `--no-verify` via Claude settings hook.** `.claude/settings.json` PreToolUse hook that scans Bash `command` for `--no-verify` on `git commit|push` and exits non-zero. Prevents the recurrence of #1338's formatter-bypass.
2. **Document release-train pattern in post-#1299 `run.md` rewrite.** Sprint-34 retro writes `.claude/skills/sprint/agents/mergemaster.md` (agent-side prompt) today. After #1299 lands, add a "Release train" section to the rewritten `run.md` pointing at `@agents/mergemaster.md` and documenting the orchestrator-side handoff pattern (spawn at sprint start, `mcx claude send` per `qa:pass`, let it drain).
3. **Teach all phase agents (reviewer/repairer/QA) to enumerate all 4 PR-comment surfaces.** Sprint 34 shipped PR #1380 with 17 inline Copilot comments silently ignored because every phase agent only checks `gh pr view N --comments` (PR-body surface). Before any `qa:pass` label, the agent must enumerate and address/dismiss comments on **all** of: PR body (`gh pr view N --comments`), inline file:line (`gh api repos/O/R/pulls/N/comments`), review containers (`gh api .../pulls/N/reviews`), and the linked-issue thread (`gh issue view $I --comments`). Every thread is either addressed-with-code or explicitly dismissed. Applies to updates in `.claude/skills/sprint/agents/{qa,review,repair}.md` (or equivalent phase scripts — coordinate with #1299's final layout).
4. **User: enable `required_review_thread_resolution` on main ruleset.** Backstop for item #3 — unresolved threads block merge at the GitHub level even if an agent forgets to check. User-initiated; orchestrator confirms post-enable.
5. **Consider `enforce_admins: true` on main ruleset** — separate decision, requires user call.
6. **Skill-file rewrite for `.mcx.yaml` canonicalization.** After #1299 lands, rewrite `implement.md` / `qa.md` / `adversarial-review.md` / `run.md` to drive `mcx phase run <name>` instead of prose pipelines. Per Explore findings: phases are `impl → triage → {review, qa} → {repair, qa, done, needs-attention}`, scripts use `defineAlias({ name, description, input, output, fn })`, session-id contract is documented in per-phase header JSDoc. Skills reference `docs/phases.md` (new in #1299) for authoring and `.claude/phases/<name>.ts` headers for the session-id lifecycle. Net diff expected: large deletions from `run.md` (already started in #1299: -665 lines), targeted rewrites of skill-level files.

## Issues

| # | Title | Scrutiny | Batch | Model | Category |
|---|-------|----------|-------|-------|----------|
| **1347** | **Flaky: findGitRoot tests fail under pre-commit (GIT_DIR leak)** | **high** | **1** | **opus** | **root-cause of #1338 bypass** |
| 1393 | CI retry wrapper swallows Bun segfault stderr (bun.report URLs lost) | medium | 1 | opus | DX P1 — memory says always open those URLs |
| 1378 | quota: _errorLogged not reset when error type changes | low | 1 | opus | #1329 follow-up |
| 1377 | quota.spec.ts: replace fixed Bun.sleep() with polling | low | 1 | opus | #1329 follow-up; test hygiene |
| **1381** | **feat(phases): wire autonomous handler execution (phase run without --dry-run)** | **high** | **1** | **opus** | **dogfood v2 — real execution** |
| **1397** | **feat(merge-queue): local deterministic merge-queue service (replaces mergemaster LLM)** | **high** | **2** | **opus** | **sprint-34 retro insight; depends on #1381** |
| 1367 | repro harness: gh pr merge --delete-branch → core.bare=true | medium | 2 | opus | #1330 follow-up — proves sticky fix |
| 1372 | bug(phases): O_EXCL lockfile not atomic on NFS; transition log corruption risk | medium | 2 | opus | #1328 follow-up |
| 1375 | feat(phases): stream-parse transitions.jsonl; add rotation policy | medium | 2 | opus | phase polish |
| 1392 | Production: rapid codex worker respawn may hit Bun module-resolution race | medium | 2 | opus | DX P2 |
| 1388 | fix(claude-wait): help text says --timeout default is 300000 | low | 2 | sonnet | #1341 follow-up; doc fix |
| 1383 | bug: something in the test suite deletes root .mcx.yaml | medium | 3 | opus | test hygiene |
| 1385 | fix(phases): truncate long forceMessage in phase log table output | low | 3 | sonnet | #1327 follow-up |
| 1386 | test(phases): add combined --json + --work-item test for mcx phase log | low | 3 | sonnet | #1327 follow-up |
| 1384 | CI grep-check: assert detectDrift call in phase run case | low | 3 | sonnet | #1346 follow-up |
| 1391 | chore(phases): CI grep check asserting run case calls assertNoDrift | low | 3 | sonnet | #1346 follow-up |

## Batch Plan

### Batch 1 (immediate — flaky root cause + dogfood v2)
#1347, #1393, #1378, #1377, #1381

- **#1347** is THE root cause that led to #1338's `--no-verify` bypass. Fixing it removes the last "legitimate" reason anyone would use `--no-verify` in this repo, reinforcing the settings-hook block.
- **#1381** is the dogfood v2 — autonomous handler execution is the logical next step after #1299 shipped the declarative manifest. Big, needs the full sprint to cook.
- **#1393** (bun.report stderr swallow) is blocking memory-compliance (memory rule: always open bun.report URLs; if CI swallows them, can't report).
- #1377/#1378 are #1329 follow-ups; small but non-trivial.

### Batch 2 (backfill — #1330/#1328 follow-ups + DX)
#1367, #1372, #1375, #1392, #1388

- **#1367** proves the #1330 sticky fix actually works under real `gh pr merge` conditions. If it doesn't, we have a fourth recurrence to diagnose.
- #1372 (NFS) is non-blocking for most users but worth flagging in the docs while the code is fresh.
- #1392 (Bun module-resolution race on rapid respawn) is production-adjacent — cheap to fix if reproducible.

### Batch 3 (filler — phase polish)
#1383, #1385, #1386, #1384, #1391

- #1383 matters most here; the others are tiny follow-ups.
- #1384 and #1391 are static-analysis CI gates — both on the same workflow file, so coordinate (risk: merge conflict, but text-level; plan spawns them far apart or serially).

## Dependency graph

```
  #1347 ── unblocks #1356 closure (GIT_DIR root cause) — standalone
  #1381 ── depends on #1299 landed (confirmed, in train)
  #1367 ── depends on #1330 landed (confirmed, in train)
  #1377 / #1378 ── depend on #1329 landed (confirmed merged)
  #1372 ── depends on #1328 landed (confirmed, in train)
  #1375 / #1385 / #1386 / #1384 / #1391 ── all on phase surface; fine to land in parallel
  #1383 ── independent
```

Critical path: #1347 (unblocks `--no-verify` retirement), #1381 (autonomous execution = v1.6.0 gate).

## Context

Sprint 34 shipped 15 PRs (v1.5.0 pending release-train drain). The `.mcx.yaml` phase pipeline is now dogfooded end-to-end but still runs via orchestrator-spawned sessions; #1381 is the next step (autonomous execution). #1347 is the "why did --no-verify get used?" root cause — fixing it removes the last legitimate excuse for bypass.

Sprint 34 filed 8 follow-ups from reviews (#1365, #1366, #1367, #1372, #1374, #1381, #1383, #1384, #1385, #1386, #1391, #1393); sprint 35 takes 9 of them.

**Cross-swarm mail (retro deferred from sprint 34)** — still deferred. Needs a dedicated design-discussion issue filed first. Not in this sprint.

**Apply from sprint 34 retro**:
- **Release train runs from sprint start.** Spawn the sonnet engineer in Batch 1 pre-flight, enqueue PRs as each hits qa:pass. No end-of-sprint jam.
- **Reviewer self-select for repair vs opus.** Continues to work; keep prompting it.
- **Rebase-before-QA when main advances.** When main has new commits since impl start, have QA's spawn include a rebase preamble.
- **`--no-verify` blocker hook** installed at plan time (see Meta section above).

## Excluded

- **#1365** — instrument shim prune paths: overlaps with #1330's own fix (already has shim probes). Close as done or fold into #1367 harness.
- **#1366** — core_bare_healed_total metric: low-urgency operational improvement.
- **#1374** — sweepCoreBare cwd fallback test: already added during #1330 repair; close.
- **#1356** — already investigated this sprint; close after #1347 lands.
- **#1361, #1319** — JSDoc fixes: trivial; fold into a docs polish sprint.
- **fast-import cluster** (#1277–#1281, #1311, #1312, #1323) — designated git-remote-mcx sprint.
- **#1300** (mcx gc: daemon unreachable) — reproduction unclear; defer for repro steps.
- **#1355** (worktree nag lacks repo path) — cosmetic.
- **Older backlog** (#1049, #935, #698) — not ready.

## Risks

- **#1381 (autonomous execution)** is the biggest unknown. If the phase handlers can't safely execute without orchestrator oversight (e.g., spawn sessions, push PRs), this may need to land as "gated autonomous" (dry-run + confirm) before full autonomy. Budget the full sprint.
- **#1347 (GIT_DIR leak)** has been flaky across multiple sprints. Real fix requires understanding why pre-commit's `git commit` context leaks GIT_DIR into the test process — may require a subprocess-isolation approach or env-var scrubbing.
- **Release-train meta change** is a workflow shift. Without a dry-run sprint, we won't know if the train keeps up when all 15 hit qa:pass in a 20-min window. Mitigation: orchestrator watches the train's queue depth; if it exceeds 5, pause impl spawns.
