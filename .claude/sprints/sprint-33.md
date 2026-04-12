# Sprint 33

> Planned 2026-04-12 14:51. Started 2026-04-12 14:56 local. Completed 2026-04-12 18:32 local. Target: 14 PRs (#1299 deferred mid-sprint). Result: 14/14 planned + #1308 hot-filled = 15 merged (target exceeded). Duration: 3h36m.

## Goal

Land the #1286 declarative-manifest epic end-to-end and **dogfood-migrate this repo's sprint pipeline onto `.mcx.yaml`**. Turn 4000+ lines of orchestration prose (skills + MEMORY.md + QA rules) into an executable, reviewed, versioned artifact — and prove the design works by running sprint 34 through it.

## Issues

| # | Title | Scrutiny | Batch | Model | Category |
|---|-------|----------|-------|-------|----------|
| **1283** | **fix: t5801-32/33 failing on main (CI blocker)** | **medium** | **1** | **opus** | **CI unblock (pre-req for every other PR)** |
| **1287** | **feat(manifest): .mcx.{json,yaml} schema + loader** | **high** | **1** | **opus** | **epic foundation — sole root of graph** |
| 1289 | feat(aliases): add scope column with three-valued dispatch | low | 1 | opus | epic foundation (DB migration) |
| 1290 | feat(aliases): shared state table + ctx.state accessor | medium | 1 | opus | epic foundation (DB migration + API) |
| 1297 | feat(phases): source URI parser (file:// + future shape) | low | 1 | opus | epic foundation (pure function) |
| 1288 | feat(manifest): migrate .mcx-worktree.json into .mcx.yaml worktree | medium | 2 | opus | epic foundation (needs #1287) |
| **1291** | **feat(phases): mcx phase install — resolve + hash + register + lockfile** | **high** | **2** | **opus** | **epic install bottleneck** |
| 1293 | feat(phases): transition graph enforcement + --force | high | 2 | opus | epic runtime (needs #1287) |
| 1294 | feat(phases): runsOn branch guard | low | 2 | opus | epic runtime (needs #1287) |
| 1298 | feat(phases): integrate with work_items — manifest phases → enum | medium | 2 | opus | epic integration (needs #1287 + #1290) |
| 1285 | mcx claude log --tail N treats N as session ID | low | 3 | sonnet | filler — orchestrator DX papercut |
| 1292 | feat(phases): lockfile drift detection + security warning | medium | 3 | opus | epic install (needs #1291) |
| 1295 | feat(phases): mcx phase show / list / why | low | 3 | opus | epic inspection (needs #1287 + #1293) |
| 1296 | feat(phases): dry-run via logging Proxy on ctx.mcp | low | 3 | opus | epic runtime (independent — could start earlier but cheap) |
| **1299** | **docs(phases): migrate this repo's sprint pipeline into .mcx.yaml** | **high** | **3** | **opus** | **epic dogfood — depends on everything** |

## Batch Plan

### Batch 1 (immediate — 5 slots: CI unblock + epic foundation)
#1283, #1287, #1289, #1290, #1297

Everything in batch 1 starts **concurrently** because nothing here depends on anything else here. #1287 is the sole root of the epic graph — every batch-2 issue waits on it. #1289/#1290 are SQLite migrations (no dep on manifest loader). #1297 is a pure function. #1283 is a CI fix that unblocks the rest of the sprint. All 5 can ship in parallel.

Why #1283 is in batch 1: every subsequent PR's CI will fail the same way on main. Per the new `qa:fail` rule, no PR merges with red CI. This one has to land first.

### Batch 2 (backfill — 5 slots: install bottleneck + direct-#1287 dependents)
#1288, #1291, #1293, #1294, #1298

These launch as batch 1 slots free up (primarily once #1287 merges). #1291 is the install-ceremony bottleneck and high-scrutiny — ship it as early in batch 2 as possible so batch 3 dependents aren't blocked. #1293/#1294 only need #1287 (loader), not #1291 — they can start the moment the schema PR merges. #1298 also needs #1290 but that's in batch 1 so timing is fine.

### Batch 3 (backfill — 5 slots: dogfood + fillers)
#1285, #1292, #1295, #1296, #1299

#1292 waits on #1291 (its lockfile doesn't exist until install does). #1295 waits on #1287 + #1293. #1296 is technically foundation-independent and could have been in any batch — placing it here as a breather. #1285 is the orchestrator-DX filler (sonnet — low-cost, small diff). #1299 is **the finale**: migrates this repo's sprint files into `.mcx.yaml` + example phase scripts, proves the system works end-to-end. Will be spawned last and likely the longest-running single session of the sprint.

## Dependency graph

Second-opinion on the epic's parallelism section: the epic groups by **Foundation → Install + runtime → Inspection → Integration**, but several "Install + runtime" issues don't actually depend on `mcx phase install` (#1291) — they only need the manifest loader (#1287). Surfacing that opens up batch 2 considerably:

```
       #1287 (loader)       #1289 (scope)    #1290 (state)    #1297 (URI parser)    #1283 (CI fix)
         │                    │                │                │
         ├─ #1288 (migration) │                │                │
         ├─ #1293 (transitions) ──── #1295 (show/list/why)
         ├─ #1294 (runsOn)    │                │
         └─ #1298 (work_items) ─────────── needs #1290
                              │                │
                              └── #1291 (install) ──── #1292 (drift)
                                                       │
                              #1296 (dry-run) ─ independent of entire manifest
                              │
                              └─── everything above ──── #1299 (dogfood)
```

Critical path: #1287 → #1291 → #1299. Everything else hangs off #1287 directly.

## Context

Sprint 32 shipped 15/15 PRs and surfaced the structural problem that #1286 addresses: 4000+ lines of orchestration logic live as prose in markdown files, workers accidentally mutate that prose in parallel during a sprint, and every project that adopts mcx has to re-derive the entire pipeline. The retro added band-aid rules (`qa:pass`/`qa:fail` labels, `meta` issue workflow, orchestrator-owns-merge) that are genuinely useful *right now* but become unnecessary once phases are declarative. This sprint ships the declarative version.

**Risk — this sprint is heavier on scrutiny than sprint 32:**
- 4 high-scrutiny PRs (#1287, #1291, #1293, #1299) vs sprint 32's 4 high-scrutiny PRs but with a much tighter dependency chain here. #1287 blocking is a single point of failure — if it needs 2 rounds of adversarial review, half of batch 2 stalls.
- #1291 has 5 discrete responsibilities (resolve sources → hash → schema-subset check → register → write lockfile); expect review to find issues.
- #1299 is a pure integration PR that depends on every other issue; schedule it last and budget opus time for it.

**Dogfood implication**: if #1299 lands cleanly, sprint 34 runs through `.mcx.yaml`. If #1299 hits issues, we fall back to the sprint-32 skill-file pipeline with the new label rules. Either way, the band-aid rules stay in place until #1299 proves the manifest shape works.

**Apply from sprint 32 retro**:
- When a sweeping commit lands on main (e.g. #1287's schema types), broadcast rebase directive to active sessions before they push. Expect at least 2 sweeping commits this sprint (#1287, #1291).
- Don't `bye` QA sessions until the PR has `qa:pass` or `qa:fail`.
- Orchestrator merges from `main` — no QA branch movement.
- Pre-flight: run `mcx gc --dry-run` to inspect orphaned worktrees before spawning (new capability from sprint 32 #1219).

## Excluded

- **Pull.spec/clone.spec pollution variants** (#1256, #1264, #1265, #1266, #1267, #1224, #1248) — #1241's `cleanEnv()` fix from sprint 32 covered the primary class; these are variants or duplicate reports. Dedupe pass warranted but not sprint-worthy on their own. Candidate for a small cleanup sprint or bundled into whatever QA sprint 34 ships.
- **#1262, #1263, #1277, #1279, #1280, #1281** — fast-import follow-ups from the sprint-32 epic reviews. Real but not critical; fold into a git-remote-mcx polish sprint.
- **#1283** — INCLUDED in this sprint (CI blocker, not excluded).
- **#1250, #1251** — unchanged from sprint 32 exclusion (design work / arch decision pending).
- **#1255** — cosmetic, would be a nice filler but holding at 15 PRs. Can land any sprint.
- **Older backlog (#1049, #1177, #935, #699, #698, #328, #100)** — not ready; need spec/design/clarification.

## Results

- **Released**: v1.5.0-rc.1 (release candidate — stable v1.5.0 deferred until #1299 dogfoods the manifest)
- **PRs merged**: 15 (14 planned + #1308 hot-fill + #1358 post-sprint CI fix pending)
- **Issues closed**: 15 (via `fixes #N` on merged PRs)
- **Issues dropped**: 1 (#1299 — finicky dogfood work, user-flagged for standalone sprint)
- **New issues filed**: 11+ from orchestration observations:
  - #1300 `mcx gc` daemon-unreachable inconsistency
  - #1308 `mcx claude wait` cross-repo event leak (fixed in-sprint)
  - #1309 pre-existing t5801 failures (superseded by #1283 fix)
  - #1311, #1312 (filed by implementer during #1283 root-cause)
  - #1327, #1328 (filed by reviewer during #1293 review)
  - #1329 usage-tracker rate-limiting
  - #1330 `core.bare=true` regression (third recurrence, needs sticky fix)
  - #1341 `--timeout` should refuse >4:59 values (prompt cache TTL)
  - #1345 flaky CodexServer tests in CI
  - #1357 coverage job red — test output noise regression
  - #1359 `mcx claude wait` should surface mail events + clearer help text

### Process notes for retro
- **Merging through red CI** was the biggest miss — branch protection now enabled on `main` (check/coverage/build required, admin bypass allowed). Auto-merge also enabled.
- **Micro-repair pattern** (reviewer fixes one-liners instead of fresh opus respawn) saved ~$10–15 across repair cycles — worth formalizing.
- **Cross-repo `wait` leak** was grinding throughout concurrent phoenix sprint — #1308 fixed mid-sprint.
- **core.bare flipping** kept breaking git operations; hot-patched each time but needs a real fix.
- **Parallel PRs added duplicate `case "phase":`** in main.ts — git-clean merge, semantic-break; caught by post-merge lint (via QA on #1285). Argues for pre-merge trial-merge lint.
- **Mail notifications missed** for 30+ min because `mcx claude wait` doesn't surface mail events (#1359).
