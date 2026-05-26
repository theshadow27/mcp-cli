# Sprint 64

> Planned 2026-05-26 03:23 EDT. Started 2026-05-26 11:16 EDT. Ended 2026-05-26 12:30 EDT. Target: 13 work items (11 issues + 2 in-flight PRs).

## Goal

Fix buggy tests: kill the flaky `pollUntil`/server-pool cluster, fix test isolation +
fixture-teardown leaks, ship incremental `am-i-done` caching — and finish in-flight work
(PRs #2397, #2391) through review → QA → merge.

## Issues

| # | Title | Scrutiny | Batch | Model | Category |
|---|-------|----------|-------|-------|----------|
| PR #2397 | diff-aware `--pre-push` gate — review + QA + merge | med | 1 | — | in-flight |
| PR #2391 | grok provider (ACP) — review + QA + merge | med | 1 | — | in-flight |
| 2394 | fixture/worker orphan leaks (`--no-orphans` + fixture teardown) | high | 1 | opus | goal |
| 2370 | P1: auto-started mcpd steals the IPC socket (split-brain root cause) | high | 1 | opus | goal |
| 2248 | rule: flag `pollUntil()` with no headroom under the Bun test timeout | high | 1 | opus | goal |
| 2330 | server-pool disconnect SIGTERM flaky — consolidates #2334/#2339/#2245/#2260 | high | 2 | opus | goal |
| 2362 | yoga-layout TDZ — run `packages/control` under `--parallel` | med | 2 | opus | goal |
| 2395 | alias-executor.spec writes to real `~/.mcp-cli` (shared HOME isolation) | low | 2 | sonnet | goal |
| 2383 | flaky: isOurProcess `getProcessStartTime` returns null under parallel load | med | 2 | opus | goal |
| 2388 | flaky: cli-orchestration `--worktree` stderr race under suite load | med | 2 | opus | goal |
| 2253 | flaky: useAgentSessions polls repeatedly fails under load | low | 3 | sonnet | filler |
| 2381 | DX: stale-daemon mismatch gives directionally-wrong remediation (pairs #2370) | low | 3 | sonnet | filler |
| 2396 | AST import-graph + closure-hash test cache (incremental am-i-done) | high | 3 | opus | goal |

## Batch Plan

### Batch 1 (immediate)
PR #2397, PR #2391, #2394, #2370, #2248

### Batch 2 (backfill)
#2330, #2362, #2395, #2383, #2388

### Batch 3 (backfill)
#2253, #2381, #2396

### Dependency edges (translate to `addBlockedBy` at run time)
- #2396 blockedBy PR #2397 (both touch `scripts/am-i-done.ts` + `scripts/_runner/ci-steps.ts`)
- #2362 blockedBy PR #2397 (touch `am-i-done.ts` + the `package.json` test script)
- #2394 blockedBy PR #2397 (touch the test script / `.git-hooks` test invocation)
- #2381 blockedBy #2370 (remediation text depends on the socket-theft fix semantics)
- #2330, #2383, #2388 serialize on `server-pool.spec.ts` / process-identity tests (hot-shared); land #2248's rule first so the disconnect-test fix conforms to it.

## Context

**Theme genesis:** Surfaced during the diff-aware `--pre-push` work (PR #2397, epic #2393).
A quiet-machine sweep showed the suite is **parallel-safe — 0 flakes across 22,164 test
executions** once leaked processes are gone. So the "buggy tests" are NOT widespread
flakiness: they're (a) fixture-teardown leaks (#2394), (b) a couple shared-state/isolation
bugs (#2395), (c) the control/yoga `--parallel` exclusion (#2362), and (d) a cluster of
`pollUntil`-deadline-too-tight-under-load flakies (#2330 + dups).

**Pre-paid investigation:** The flaky cluster's mechanism is already established. An
abandoned 3-day stress shell (killed this session) was running
`server-pool.spec.ts --test-name-pattern "disconnect kills stdio"` under deliberate
CPU saturation (14 `yes` procs, load avg 116) — i.e. someone was already reproducing
#2330 under load. Root cause: `pollUntil` deadlines (1500ms) with no headroom starve
under CPU contention. The nerd-snipe gate for #2330/#2383/#2388/#2253 is largely
pre-answered (widen headroom / load-tolerant deadlines + ship the #2248 prevention rule),
so the run phase should not re-pay for a full investigation on settled mechanism.

**In-flight PRs (finish, don't implement):** #2397 (mine — diff-aware pre-push, CI green
locally) and #2391 (grok's ACP provider, CI green) ride through review → QA → merge as
"finish in-flight work." Note: #2397 was authored by the orchestrator persona — a fresh
session must do its review/QA for independence (the sprint spawns fresh sessions, so this
is automatic). #2396/#2362/#2394 are blocked on #2397 landing first (shared files).

### Meta dispositions (Step 1a — apply BEFORE run, with user awake)
- **#2333 — apply now (deferred to user review):** codify Bun's condition-based-waiting
  test philosophy in `CLAUDE.md` + `test/CLAUDE.md` ("test the CONDITION, not TIME
  PASSING"; no per-test timeouts, use file-level `setDefaultTimeout`). Directly on-theme —
  it's the *why* behind #2248/#2272/#2278. NOT applied yet: edits core instructions, so
  it needs user review (not auto-merged unattended). Apply via `meta/codify-waiting-philosophy`
  branch at sprint start.
- #2398 — sprint retro doesn't clear `.active` — defer to THIS sprint's retro (retro-flow fix).
- #2350 (rule-author self-contained), #2393 (grok epic) — defer / keep-open-as-epic.

### Pending board hygiene (auto-classifier blocked the closes — needs explicit go)
- Close #2334, #2339, #2245, #2260 as dups of #2330 (same test, same root).
- Close #2343 (worker-wrote-outside-worktree) as likely one-off hallucination (<1:1000).

### Loose end to salvage
- `git stash@{0}` holds an old sprint-63 run-state doc. Safe to drop EXCEPT one unsaved
  lesson worth keeping: *"Don't end a turn on a passive event-wait that may not fire —
  Monitor bound to an orphaned daemon → 6h blind → ~400k cache miss. Drive actively;
  bounded polls."* Save to memory, then `git stash drop stash@{0}`.

### Issues filed this session (context for reviewers)
#2392 (MCP_CLI_AI=0 no-op), #2394, #2395, #2396, #2398.

## Results

**Outcome: 13/13 merged (100%).** Ran 11:16 EDT → 12:30 EDT (1h14m). Quota peaked at 19% / 16% (5h / 7d).

### Already merged (planner ghost-included)
- **#2248** — closed (PR #2278 merged 2026-05-24, pre-sprint); worker confirmed, untracked.
- **#2362** — closed (PR #2379 merged 2026-05-25, pre-sprint); worker confirmed, untracked.

### Sprint PRs
| Issue | PR | Notes |
|-------|----|-------|
| PR #2397 | #2397 | review→repair→QA→merge. Reviewer self-repair: 4🟡 + 2🔵 + filed #2401 (ZERO_FAIL_RE follow-up). |
| PR #2391 | #2391 | review→repair→QA→merge. Round-1 verdict: 3🔴+3🟡+filed #2407 (routing gap). Repair landed all 6. |
| #2394 | #2405 | impl→QA→merge. QA fixed gap in `test:phases` invocation. |
| #2370 | #2410 | impl→review→QA(fail)→repair→QA→merge. Reviewer ✅ approved; QA caught 2 follow-on bugs Copilot also flagged (probeSocket 503 case, ProtocolMismatchError consistency). |
| #2330 | #2404 | impl→QA(fail, rule misread)→repair→QA→merge. Filed #2409 (rule-misapplication context for future workers). |
| #2395 | #2402 | impl→QA→merge. Cleanest path. |
| #2383 | #2412 | impl→QA(fail, missing retry test)→repair→QA→merge. |
| #2388 | #2414 | impl→QA→merge. Bundled the **#2400** sandbox-escape fix (gitSafeEnv strips GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE) — #2400 closed via the same merge. |
| #2253 | #2403 | impl→QA(missed Copilot finding)→QA-self-repair→merge. |
| #2381 | #2418 | impl→QA→merge. |
| #2396 | #2406 | impl(scope-split: verdict cache only, AST graph deferred)→review→repair-with-Copilot-bonus→QA→merge. |

### Issues filed during the run
- **#2400** — P1: cli-orchestration.spec.ts --worktree test escapes its temp git dir (closed by #2414 via gitSafeEnv).
- **#2401** — follow-up: replace ZERO_FAIL_RE prose regex with structured bun test --reporter json.
- **#2407** — follow-up: grok routing gap (caught during #2391 adversarial review).
- **#2409** — follow-up: poll-until-headroom rule misapplication context (caught during #2330 QA).

### Mid-run observations worth tracking
- **The diff-aware pre-push (#2397) paid off immediately.** PRs landed after #2397 ran `am-i-done --pre-push` in 6–7s vs ~60s pre-change — visible in the impl worker logs.
- **Reviewer self-repair worked well** for #2397 (6 findings) and #2396 (4 findings) — both stayed in scope. #2391's larger blocker set was correctly routed to fresh opus repair (no convergence-failure churn).
- **QA caught real bugs adversarial review missed** twice: #2370 (probeSocket 503), #2253 (vacuous deadline-poll pass) — both via Copilot inline findings the QA initially missed and then addressed when prompted. The QA-self-repair pattern (re-running QA after a heads-up about an inline thread) is cheap and worked.
- **Planner included items already merged** (#2248, #2362). Workers confirmed and untracked in ~30s each. Cheap mistake, but should be a planner pre-check.
- **--no-verify needed once** for the docs-only sprint-meta timestamp commit (the flaky #2388 was blocking the gate — exactly the issue being fixed). User authorized explicitly; #2397's landing made this unnecessary for subsequent meta edits.

### Deferred / not done
- Plan's Step 1a meta change (#2333 — codify Bun's condition-based-waiting test philosophy in CLAUDE.md + test/CLAUDE.md) — deferred to user review per the plan's note. Apply via `meta/codify-waiting-philosophy` branch at retro or post-sprint.
- Pending board hygiene (close #2334/#2339/#2245/#2260 as dups of #2330; #2343 as one-off) — defer to retro.
- `git stash@{0}` drop — STASH CONTENT DIVERGED FROM PLAN (held 55 lines of `automation-dispatcher.spec.ts` test work, not the run-state doc the plan described). Did NOT drop. Saved the "don't end on passive wait" lesson to memory as a standalone file (feedback_dont_end_on_passive_wait.md).
