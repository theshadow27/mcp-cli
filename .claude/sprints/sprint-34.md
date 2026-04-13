# Sprint 34

> Planned 2026-04-12 19:20 local. Started 2026-04-12 20:00 local. Completed (impl/QA) 2026-04-12 21:40 local; merge train still draining. Target: 15 PRs.

## Goal

**Prove v1.5.0-rc.1 and cut stable v1.5.0** — dogfood `.mcx.yaml` for this repo's own sprint pipeline (#1299), harden the phase surface with the ~12 follow-up issues filed during sprint 33 reviews, and fix the DX bugs that blocked orchestrator throughput (core.bare recurrence, usage-tracker rate limit, `mcx claude spawn` cwd default, `mcx claude wait` mail-wake).

## Issues

| # | Title | Scrutiny | Batch | Model | Category |
|---|-------|----------|-------|-------|----------|
| **1299** | **docs(phases): migrate sprint pipeline into .mcx.yaml** | **high** | **1** | **opus** | **goal — dogfood finale (v1.5.0 gate)** |
| 1316 | fix(manifest): findManifest bare catch{} masks EPERM/EACCES | low | 1 | opus | goal — manifest safety |
| 1317 | fix(manifest): loadManifest lstat ENOENT throws instead of returning null | low | 1 | opus | goal — manifest consistency |
| 1318 | feat(manifest): export DEFAULT_RUNS_ON constant | low | 1 | opus | goal — api surface |
| **1330** | **bug: core.bare=true flipped AGAIN — third recurrence, needs sticky fix** | **high** | **1** | **opus** | **DX P1 — orchestrator-blocking** |
| **1328** | **transition log not concurrency-safe; replace appendFileSync with SQLite or add file lock** | **high** | **2** | **opus** | **goal — data safety** |
| 1324 | fix(aliases): ctx.state scoped to NO_REPO_ROOT when invoked via MCP directly | medium | 2 | opus | goal — alias correctness |
| 1327 | feat(phases): mcx phase log / audit command for --force usage | medium | 2 | opus | goal — observability |
| 1346 | feat(phases): wire detectDrift into mcx phase run before execution | medium | 2 | opus | goal — integration |
| **1329** | **Usage tracker hits Claude API on every mcx invocation — rate-limiting users** | **high** | **2** | **opus** | **DX P1 — user-facing** |
| 1331 | mcx claude spawn defaults to mcp-cli repo instead of caller's cwd | medium | 3 | opus | DX — multi-repo |
| 1359 | mcx claude wait should surface mail:received events | medium | 3 | opus | DX — mail-wake (scope to wait only; defer cross-swarm spawn to sprint 35) |
| 1341 | mcx claude wait --timeout should refuse values > 4:59 (prompt cache TTL) | low | 3 | opus | DX — guardrail |
| 1345 | Flaky CI: CodexServer worker-crash tests fail on CI but pass locally | medium | 3 | opus | filler — CI stability |
| 1348 | feat(phases): forward --arg key=val into dry-run ctx.args | low | 3 | sonnet | filler — phase polish |

## Batch Plan

### Batch 1 (immediate — 5 slots: dogfood kickoff + manifest polish + core.bare sticky)
#1299, #1316, #1317, #1318, #1330

- **#1299** is the heavyweight — kicks off immediately so it can cook for the full sprint. It depends on the manifest shape being stable; if #1316/#1317/#1318 introduce churn, #1299 rebases. Accept that tradeoff because #1299 has to run end-to-end to validate.
- **#1330** (core.bare sticky) goes batch 1 because every other PR is at risk from the recurrence. Fixing it early shields the sprint.
- #1316–#1318 are tiny manifest polish — low scrutiny, 1–2 files each. Quick wins that harden #1299's foundation.

### Batch 2 (backfill — 5 slots: goal hardening + DX P1)
#1328, #1324, #1327, #1346, #1329

- **#1328** (transition log concurrency) is high-scrutiny because it changes a data-durability primitive — either SQLite or flock, both require careful schema + migration thought. Ship early in batch 2 so #1327 (which reads the log) can integrate.
- **#1329** (usage tracker rate-limit) is its own beast — orchestrator-independent code path. Could have gone batch 1 but parking in batch 2 so batch 1 slots stay dogfood-focused.
- #1324, #1346 are medium integration. #1327 is a new command (`mcx phase log`) — small but needs CLI wiring.

### Batch 3 (backfill — 5 slots: DX filler + phase polish)
#1331, #1359, #1341, #1345, #1348

- **#1331** (spawn cwd default) is a multi-repo DX fix — isolated to command/spawn logic, low blast radius.
- **#1359** (wait surfaces mail) — scoped to the wait-wake change only. Cross-swarm orchestrator↔orchestrator messaging (per sprint 33 retro user contribution) is explicitly **out of scope** for this sprint; file a follow-up for sprint 35 design discussion.
- **#1341** (--timeout refuse >4:59) — tiny guardrail. Low scrutiny, ~15 LOC.
- **#1345** (flaky CodexServer) — opus because flaky fixes need root-cause. Adversarial review mandatory.
- **#1348** (--arg key=val) — smallest win, sonnet-eligible.

## Dependency graph

```
  #1299 (dogfood) ─── depends on stable manifest surface
    └── ideally #1316, #1317, #1318 land first (but not blocking — #1299 rebases)

  #1328 (transition log) ── #1327 (phase log reads it)
  #1330 (core.bare) ──── unblocks everyone (shields the sprint)
  #1329 (usage tracker) ── independent
  #1324, #1346, #1331, #1341, #1345, #1348, #1359 — all independent
```

Critical path: #1330 → #1299. If #1299 can't land cleanly by sprint end, v1.5.0 stable is deferred again — this is the sprint's stretch goal, not a guarantee.

## Context

**Sprint 33 shipped 15 PRs** as v1.5.0-rc.1 (prerelease). The entire `mcx phase` surface is wired up but **not yet dogfooded**. #1299 is the validation: migrate this repo's own sprint pipeline into `.mcx.yaml` and prove the system works end-to-end. If #1299 lands cleanly, cut stable v1.5.0 at sprint review. If #1299 hits blockers, fall back to skill-file pipeline for sprint 35 and revisit the manifest design.

**Sprint 33 filed 11+ follow-up issues**; this sprint picks the 7 most consequential (#1316, #1317, #1318, #1324, #1327, #1328, #1346). Deferred to sprint 35: #1313 (parseSource wiring — already wired de facto in #1291), #1325 (findGitRoot perf — perf optimization, not correctness), #1343 (installedAt field), #1344 (cycle detection — already done in #1287 per my reading), #1349, #1350, #1351, #1352, #1353, #1354, #1356 (assorted phase polish).

**Apply from sprint 33 retro**:
- Branch protection on main now requires `check`/`coverage`/`build` green. `gh pr merge` will be blocked on red CI. Use `--auto` for queue semantics.
- **Micro-repair pattern**: when a reviewer flags 1–3 contained fixes with exact diagnosis, `send` them back to the reviewer instead of spawning fresh opus. Saved ~$10–15 last sprint.
- **Cap `mcx claude wait --timeout` at 270000ms** (4:30). 300000 blows the 5-min prompt cache TTL.
- **Don't `bye` QA sessions when they fail on upstream-blocked CI**. Leave idle, send rebase+re-QA when the blocker lands.
- **Spawn rebase workers** for PRs that merge-conflict at the end — don't try to rebase from orchestrator.
- **Pre-flight: restart daemon** after `bun run build`. `mcx shutdown && mcx status`.

## Excluded

- **#1331 duplicates / old backlog** — #1313, #1325, #1343–#1354 (except #1346): phase polish, deferrable.
- **pull.spec/clone.spec variants** (#1224, #1248, #1256, #1264, #1265, #1266, #1267) — dupes/variants of #1241's cleanEnv fix. Candidate for a dedupe pass sprint.
- **fast-import follow-ups** (#1262, #1263, #1277, #1279, #1280, #1281, #1311, #1312, #1314, #1315, #1323) — real but not critical; fold into a git-remote-mcx polish sprint.
- **#1250, #1251** — design work / arch decision pending.
- **#1255** — `mcx claude bye` branch delete; low-priority cosmetic.
- **#1299 → stable v1.5.0** tagging — follows if dogfood succeeds, not an issue.
- **Cross-swarm mail (retro note)** — not in this sprint. File a dedicated design-discussion issue for sprint 35 before implementing.
- **Older backlog** (#1049, #1177, #935, #699, #698, #328, #100) — not ready; need spec/design.

## Risks

- **#1299 is the single point of failure**. If the manifest shape doesn't fit sprint orchestration cleanly (e.g., phase inputs/outputs don't express what workers need), we ship rc.2 instead of 1.5.0 stable. Mitigation: start #1299 immediately, let it run the full sprint, have the implementer file issues as they go rather than forcing a single monolithic PR.
- **#1330 sticky fix is the third attempt**. Prior fixes (#1206, #1243) didn't stick. Implementer needs to actually root-cause which git operation flips `core.bare` and either patch that operation or add a startup-check guard. Adversarial review mandatory regardless of diff size.
- **#1329 may touch auth/keychain code** — if the fix requires changing how the daemon polls `/api/oauth/usage`, expect scrutiny overlap with auth. Budget an extra review round.
- **#1328 SQLite migration** adds schema; if done wrong, existing transition logs become unreadable. Adversarial review must check migration path from file-based log → SQLite.

## Results

- **Released**: v1.5.0 (stable; drops -rc.1 prerelease suffix from sprint 33's tag)
- **PRs merged**: 15 / 15 planned (100%)
- **Issues closed**: 15 (the planned set: #1299, #1316, #1317, #1318, #1324, #1327, #1328, #1329, #1330, #1331, #1341, #1345, #1346, #1348, #1359)
- **Issues dropped**: 0
- **New issues filed during sprint**: 13 (#1361, #1365, #1366, #1367, #1370, #1372, #1374, #1377, #1378, #1381, #1383, #1384, #1385, #1386, #1391, #1392, #1393, #1394, #1395, #1397 (merge-queue service), #1398 (mcx gc bug))
- **Sprint duration**: ~7.5 hours end-to-end (first spawn 20:00 → last merge 03:41 next day)
- **Patterns established**: mergemaster (release-train sonnet session), 4-surface PR comment enumeration, transactional qa label-swap, auto-merge re-arm after force-push, micro-repair self-select for reviewers
- **Wind-down cleanup**: pruned 782 merged local branches (1181→399), 22 stale sprint worktrees, 107 dead remote refs
