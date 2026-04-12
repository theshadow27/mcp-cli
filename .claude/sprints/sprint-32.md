# Sprint 32

> Planned 2026-04-12 02:15. Started 2026-04-12 11:00 local. Completed 2026-04-12 12:19 local. Result: 15/15 merged.

## Goal

Complete the git-remote-mcx epic (#1209) and clear the critical orchestrator DX follow-ups from sprint 31 — the P1 stale-daemon spawn bug and the good-neighbor session-isolation bugs are now blocking concurrent cross-repo sprints.

## Issues

| # | Title | Scrutiny | Batch | Model | Category |
|---|-------|----------|-------|-------|----------|
| **1218** | **mcx claude spawn silently creates dead sessions on stale daemon (P1)** | **medium** | **1** | **opus** | **P1 goal** |
| **1242** | **mcx claude ls leaks null-repoRoot sessions across repos** | **medium** | **1** | **opus** | **good-neighbor goal** |
| **1243** | **repoRoot not recorded on spawn when repo has core.bare=true** | **medium** | **1** | **opus** | **good-neighbor goal** |
| **1241** | **clone test runs git commit in worktree root, clobbering .gitignore** | **low** | **1** | **opus** | **root cause goal** |
| **1211** | **git-remote-mcx: import handler (provider → fast-import stream)** | **high** | **1** | **opus** | **epic goal** |
| **1212** | **git-remote-mcx: export handler (fast-import stream → provider mutations)** | **high** | **2** | **opus** | **epic goal** |
| **1213** | **git-remote-mcx: argv[0] dispatch in mcx + symlink via mcx install** | **medium** | **2** | **opus** | **epic goal** |
| **1221** | **coverage: clone/src/engine/clone.ts at 4.3% blocks all pre-commit hooks** | **medium** | **2** | **opus** | **unblocker goal** |
| **1252** | **CI doesn't enforce per-file coverage threshold** | **low** | **2** | **opus** | **orchestrator DX goal** |
| **1233** | **bye --keep still triggers worktree teardown hook** | **low** | **2** | **opus** | **orchestrator DX goal** |
| **1214** | **git-remote-mcx: integration tests — port git t5801 test suite** | **medium** | **3** | **opus** | **epic goal** |
| **1215** | **git-remote-mcx: update mcx vfs clone to set remote + deprecate push/pull** | **low** | **3** | **opus** | **epic goal** |
| **1227** | **work_items phase machine doesn't allow impl→qa skip** | **low** | **3** | **opus** | **filler** |
| **1240** | **Document session scoping for multi-repo sprints** | **low** | **3** | **sonnet** | **filler** |
| **1219** | **mcx gc: garbage-collect merged branches and stale worktrees** | **medium** | **3** | **opus** | **filler** |

## Batch Plan

### Batch 1 (immediate — 5 issues, critical fixes + epic foundation)
#1218, #1242, #1243, #1241, #1211

Ship the P1 and good-neighbor bugs first — every day they linger, cross-repo sprints risk collisions. #1241 is the suspected root cause of the recurring `.gitignore` and `core.bare=true` regressions we papered over with #1206 and rebase fixes all sprint; if it fixes that class of problem, every later branch in this sprint avoids the 3-repair-cycles-per-branch tax we paid in sprint 31. #1211 kicks off the git-remote-mcx epic; its import handler is the foundation #1212 and #1213 depend on.

### Batch 2 (backfill — 5 issues, epic core + DX)
#1212, #1213, #1221, #1252, #1233

#1212 and #1213 finish the git-remote-mcx core pieces. #1221 is an urgent coverage fix — at 4.3%, clone.ts has been silently under-tested for a while; the sprint 31 retro flagged cumulative coverage drift as the pattern, this is the worst-case example. Landing #1252 (CI enforcement) alongside #1221 closes the loop so the next drift event is caught by CI, not a release cut. #1233 (bye --keep) is the DX finale for sprint 31's worker-as-conversation arc.

### Batch 3 (backfill — 5 issues, epic finish + fillers)
#1214, #1215, #1227, #1240, #1219

#1214 and #1215 complete the git-remote-mcx epic — tests and VFS integration. #1227 removes a paper-cut (phase transition workaround). #1240 is pure docs (sonnet model) — critical for sprint skill adoption in other repos but cheap to ship. #1219 (`mcx gc`) arrives just as we cross 1400 local branches.

## Context

Sprint 31 shipped 15/15 PRs (v1.4.0). It also filed 10 issues as follow-ups, 3 of which are critical: #1218 (P1 stale-daemon spawn), #1242 + #1243 (session scoping leaks between concurrent sprints in different repos). Sprint 32 clears the critical trio, finishes the git-remote-mcx epic (#1209 was the entire reason #1210 landed in sprint 31), and restores coverage discipline via #1221 + #1252.

**Risk**: #1211 and #1212 are the highest-scrutiny issues in the sprint (new code, protocol handlers, fast-import stream parsing). Expect both to need adversarial review + at least one repair cycle. Plan for 2x review cost on the epic batch.

**Apply from sprint 31 retro**:
- When a sweeping commit lands on main mid-sprint, broadcast rebase directive to all active sessions before they push (patterns section of run.md)
- When two or more PRs touch the same file, re-check per-file coverage on main after the second merge
- Wind-down: check for active cross-repo sessions before rebuild + daemon restart (#1250 partial fix landed; enumeration remains)

## Results

15/15 merged in ~1h19m (11:00 → 12:19 local). PR → issue map:

| # | PR | Notes |
|---|----|-------|
| 1218 | 1254 | P1 — stale-daemon spawn guard (low, 1 round) |
| 1241 | 1253 | root cause — `cleanEnv()` in pull.spec.ts (low, 1 round). Unblocked later batches. |
| 1242 | 1259 | good-neighbor — null-repoRoot cwd-prefix fallback (low, 1 round) |
| 1243 | 1258 | good-neighbor — repoRoot set on native worktree spawn (low, 1 round) |
| 1211 | 1257 | epic — fast-import writer (high, 2 review rounds, 1 repair) |
| 1212 | 1273 | epic — fast-import parser (high, 2 review rounds, 1 repair) |
| 1213 | 1271 | epic — argv[0] dispatch + install symlink (high, 2 review rounds, 1 repair) |
| 1214 | 1276 | epic — t5801 integration tests (low after port scope, 1 round) |
| 1215 | 1270 | epic — vfs clone sets mcx:// remote (low, 1 round) |
| 1221 | 1261 | already-fixed-upstream — removed stale coverage exclusions (low, 1 round) |
| 1252 | 1260 | CI per-file coverage enforcement (low, 1 round) |
| 1227 | 1274 | phase machine allows impl→qa (low, 1 round, workaround still needed this sprint) |
| 1233 | 1268 | bye --keep honored (low, 1 round; rebase-on-main unblock) |
| 1240 | 1275 | docs — session scoping for multi-repo sprints (low, 1 round) |
| 1219 | 1278 | `mcx gc` — garbage collector (high, **3 review rounds, 2 repairs**) |

Sprint filed 7 new issues during execution:
- #1255 — `bye` misleading "merged" label while PR is OPEN
- #1256, #1264, #1272 — additional pull.spec/test-pollution variants found during impl/QA (class-of-bug rooted in #1241)
- #1262, #1263, #1277 — review findings from epic PRs (tracked for follow-up, not blocking)
- #1269 — DX: unify spawn + track + name into `--track <issue>[:<phase>]` and `--name` flags

## Excluded

- **#1250** (wind-down cross-repo check) — partial docs fix landed in sprint 31; the remaining code-level enumeration is design work (new `mcx claude ls --all` flag or daemon-side refusal), not a 15-minute fix. Defer to sprint 33.
- **#1251** (PostHog backend config) — blocked on architecture decision between PostHog and self-hosted PHP + MySQL on SiteGround. User deciding.
- **#1234** (push.spec.ts unit tests) — effectively bundled into #1221 coverage work.
- **#1224** (pull.spec.ts pre-commit hook fail) — good swap candidate if something drops.
- **#1244, #1245, #1246, #1247, #1249** — enhancements, not critical. Wait for a sprint where they can land together as an "observability + VFS polish" arc.
- **#1248** — likely duplicate of #1241; if #1241 fix resolves it, close as dup during sprint.
- **#1177** (Jira Phase 5) — pre-sprint-30 issue, unclear if still relevant. Triage separately before including.
- **#935, #698, #699, #328, #100** — older backlog, need design/clarification before they're sprint-ready.
