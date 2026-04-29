# Sprint 48

> Planned 2026-04-29 14:30 EDT. Started 2026-04-29 02:08 EDT. Target: 15 PRs.

## Goal

**Close P1 daemon usability bugs + revive `mcx agent` UX.** Two threads:

1. **P1 daemon usability.** The `mcx claude` parallel-spawn ghosts (#1836) and the bye-destroys-live-worktree (#1837) bit sprint 47 for ~$0.33 + 13 lost turns — highest-value daemon P1s on the board. Pair with two data-correctness fixes flagged by adversarial code-first introspection ahead of sprint 48: transactional `updateWorkItem` (#1864 — TOCTOU on concurrent phase handlers) and StateDb `schema_versions` migration pattern (#1859 — 15+ bare `try { ALTER TABLE } catch` blocks silently swallow disk-full / permission errors).
2. **`mcx agent` UX revival** (carried from sprint-47 tentative). Five interactive-orchestration commands the user has been asking for since sprint 44: `--if-idle` send, `--reason` interrupt, `@path` notation, `status` one-shot, and the `ls` cwd-filter hint. All touch `packages/command/src/commands/claude.ts` so they serialize on the same file.

The remaining 4 picks are filler (BudgetWatcher persistence, triage `findPr` exitCode, liveBuffer flaky dedup, `hasActiveToolCall` coverage gap) and 2 one-character/one-line cleanups (replacement-char fix, bye `Error:` prefix). All target areas the orchestrator runs through every cycle.

**Note:** #1602 (slim-build standalone binaries) was the high-scrutiny anchor in sprint-47's tentative outline. Pulled out — high-effort build refactor with no current blocker, design needs finalization, would consume ~60 min of orchestration alone. Move to sprint 49 with a design doc first.

**Note 2:** #1870 (post-#1835 coverage CI red) was originally listed here as the P1 anchor. Verified at plan-finalize that PR #1869 (commit `84ecff18`) already shipped the fix — `test/mock-claude.ts` `--version` handler + `scripts/check-coverage.ts` `process.exitCode` switch — last 3 CI runs on main green. Issue closed at plan time; #1818 swapped in as filler.

## Issues

| # | Title | Scrutiny | Batch | Model | Category |
|---|-------|----------|-------|-------|----------|
| **1836** | parallel `mcx claude spawn` produces dead sessions | high | 1 | opus | P1 — daemon usability |
| **1837** | bye on ghost session destroys unrelated active worktree | high | 2 | opus | P1, blockedBy #1836 |
| 1864 | fix(daemon): make `updateWorkItem` read-modify-write transactional | high | 1 | opus | data-loss risk (TOCTOU) |
| 1859 | fix(daemon): apply schema_versions pattern to StateDb | high | 2 | opus | silent-error risk (15+ bare ALTER TABLE) |
| 1853 | fix(daemon): BudgetWatcher loses armed/fired state on restart | medium | 3 | sonnet | sprint-47 followup, post-#1587 |
| 1849 | fix(phase): triage findPr should check gh exitCode | low | 1 | sonnet | phase reliability |
| **1603** | mcx claude ls cwd-filter hint when other scopes have sessions | low | 1 | sonnet | agent UX (first claude.ts toehold) |
| **1606** | mcx claude send --if-idle | medium | 2 | sonnet | agent UX, blockedBy #1603 (claude.ts) |
| **1607** | mcx claude interrupt --reason | medium | 2 | sonnet | agent UX, blockedBy #1606 (claude.ts) |
| **1608** | mcx claude universal @path notation | medium | 3 | sonnet | agent UX, blockedBy #1607 (claude.ts) |
| **1609** | mcx claude status one-shot | medium | 3 | sonnet | agent UX, blockedBy #1608 (claude.ts) |
| 1820 | fix(ipc-server): liveBuffer overflow gap tests flaky in isolation | low | 1 | sonnet | flaky cleanup; close #1810 as dup |
| 1818 | test(daemon): hasActiveToolCall direct assertions in session-state.spec.ts | low | 1 | sonnet | sprint-47 coverage gap (post-#1815) |
| 1850 | fix(test): replacement character in triage-phase.spec.ts | low | 1 | sonnet | trivial cleanup (~1 char) |
| 1798 | mcx claude bye prefixes success messages with 'Error:' | low | 3 | sonnet | UX polish (sprint 45/47 observed) |

**Model mix:** 4 opus + 11 sonnet.
**Scrutiny mix:** 4 high (P1 daemon + data-loss reliability), 5 medium (agent UX), 6 low.
**Provider:** all `claude` (default — column omitted).

## Batch Plan (launch order only — NOT the orchestrator's Task structure)

Per `run.md` Input → "Task list setup": one TaskCreate per issue, with `addBlockedBy` edges from the dependency edges below. Idle slots auto-pull the next unblocked issue.

### Batch 1 — 7 unblocked picks (start immediately)

#1836, #1864, #1849, #1820, #1818, #1850, #1603

2 opus (#1836, #1864) + 5 sonnet. #1836 anchors the daemon-session P1 chain (#1837 waits). #1864 is isolated to `packages/daemon/src/db/work-items.ts`. #1820 + #1818 are independent test files. #1850 is a 1-char fix. #1603 is the first toe in `packages/command/src/commands/claude.ts` (the agent-UX serialization chain). #1849 is a small phase-script reliability fix.

### Batch 2 — 4 picks (start as Batch 1 unblocks)

#1837, #1859, #1606, #1607

#1837 starts when #1836 merges (same `claude-session/` files). #1859 is isolated to `packages/daemon/src/db/state.ts` — independent of every other pick. #1606 starts when #1603 merges (same `claude.ts`). #1607 starts when #1606 merges (same file).

### Batch 3 — 4 picks (start last)

#1608, #1609, #1853, #1798

#1608 → #1609 continue the `claude.ts` chain. #1853 is isolated to `packages/daemon/src/budget-watcher.ts`. #1798 is cleanup, can run anytime — kept here as ballast.

## Dependency edges (translated to `addBlockedBy` at run time)

- **#1837 blockedBy #1836** — both touch `packages/daemon/src/claude-session/` spawn/registration. Defensive layer waits on the parallel-spawn fix.
- **#1606 blockedBy #1603** — same file: `packages/command/src/commands/claude.ts`.
- **#1607 blockedBy #1606** — same file.
- **#1608 blockedBy #1607** — same file.
- **#1609 blockedBy #1608** — same file.

*(#1864, #1859, #1849, #1820, #1818, #1850, #1853, #1798 are independent of each other.)*

## Hot-shared file watch

- **`packages/command/src/commands/claude.ts`** — #1603, #1606, #1607, #1608, #1609 all add new flags/sub-handlers. Serialized via the chain above. Each merge will cause the next PR to need a rebase; orchestrator should broadcast a targeted rebase directive (and grep for duplicate dispatch entries — sprint-33 #1291/#1293 lesson).
- **`packages/daemon/src/claude-session/`** — #1836 + #1837 only. Serialized.
- **`packages/daemon/src/db/state.ts`** — #1859 only.
- **`packages/daemon/src/db/work-items.ts`** — #1864 only.
- **`packages/daemon/src/budget-watcher.ts`** — #1853 only.
- **`packages/daemon/src/ipc-server.spec.ts`** — #1820 only (close #1810 as dup at impl-time).
- **`packages/daemon/src/claude-session/session-state.spec.ts`** — #1818 only.
- **`.claude/phases/triage.ts`** — #1849 only.

## Pre-session clarifications required

Visible to workers via Step 1a in `.claude/commands/implement.md`.

- **#1836 (parallel-spawn ghosts)**: repro is documented in the issue. Hypothesis points to a TOCTOU on worktree-name pick or registration handshake in `packages/daemon/src/claude-session/`. Tests must cover the parallel-spawn case (≥3 concurrent `mcx claude spawn` returning all-connected sessions). Don't paper over with a serial mutex unless you can prove the race is fundamental.
- **#1837 (bye worktree protection)**: defensive scan — before destroying a worktree on `bye`, query the session table for any other session with the same `cwd`. If found, refuse the destroy and return a clear error. Independent of #1836's root-cause fix.
- **#1864 (updateWorkItem transactional)**: wrap `getWorkItem` → mutate → `run` in `db.transaction()`. Add a stress test that spawns concurrent `updateWorkItem` calls on the same id and asserts no lost updates. Use `bun:sqlite`'s native transaction API; do not introduce an external lib.
- **#1859 (StateDb schema_versions)**: replicate the pattern already used in `packages/daemon/src/db/work-items.ts` — single `schema_versions` table, ordered migration list, fail-closed on unknown errors. Do not just add try/catch with a warning. Test: a migration that throws with EACCES should surface the error, not silently downgrade.
- **#1853 (BudgetWatcher persistence)**: persist `quotaArmed` + `sprintFired` on every state change (or via `reconcile()` event-log replay — pick one). Test: arm → restart daemon → verify `quotaArmed` is still true and we don't refire the alert.
- **#1849 (triage findPr exitCode)**: `gh pr list` returning empty stdout is "no PR" (legitimate); non-zero exit is operational failure (auth, network, rate-limit). Surface the latter as an error, don't silently fall through to waitForEvent.
- **#1603 (ls cwd hint)**: when `mcx claude ls` returns 0 results in the current cwd, query the daemon for total session count across all repos. If non-zero, print a one-liner hint to stderr: `Hint: N sessions in other repos. Use --all to see them.` Don't change the JSON output on stdout.
- **#1606 (send --if-idle)**: client-side check is insufficient (race). Daemon must re-check session state under its own lock and return a structured error (`SESSION_BUSY`) when not idle. Tests: send-while-idle succeeds; send-while-mid-turn errors immediately without queueing.
- **#1607 (interrupt --reason)**: inject the reason as a user message into the session transcript (NOT a system message — we want it visible in the next turn's context). Pick the convention that requires the smallest daemon change. Tests: interrupt → reason appears in transcript before next turn.
- **#1608 (@path notation)**: prefer **explicit `@` prefix** over path-sniff heuristic (issue body discusses; explicit is clearer). Apply uniformly to `spawn --task`, `send`, `interrupt --reason`. Tests: `@/abs/path`, `@./relative`, `@~/home` all work; bare paths are treated as literal text.
- **#1609 (status one-shot)**: combine `ls` + most recent log tail (~50 lines) + derived metrics (footprint, turn count, last activity ts) into one command. Output format: human-friendly by default, `--json` opt-in. No new daemon infra — read existing tables.
- **#1820 (liveBuffer flaky)**: close #1810 as dup of #1820 at impl time. Investigate the timing race (likely an `await` missing somewhere or an assertion happening before the buffer settles). Don't paper over with `Bun.sleep` — that's banned by `scripts/check-test-timeouts.ts`.
- **#1818 (hasActiveToolCall tests)**: add a `describe` block to `session-state.spec.ts` asserting the *value* of `hasActiveToolCall` (not just the path through `extractLastToolCall`). Cover: initial state false, set true on first `tool_use` block, cleared on next assistant message without `tool_use`, cleared on result. Don't expand scope — purely test additions.
- **#1850 (replacement char)**: 1-character fix in section header. Trivial.
- **#1798 (bye Error: prefix)**: success-path messages in `mcx claude bye` are routed through the same printer as error messages. Split the path or pass a severity flag. Apply parallel fix to `mcx agent claude` per the #1819 followup if it's the same code path — file a separate PR if not.

## Excluded (with reasons)

- **#1602 (slim builds)** — sprint-47-tentative anchor. High-effort build refactor, design not yet finalized, no current blocker. Move to sprint 49 with a design doc first.
- **#1604 (spawn help text)** — doc-only filler; trim to keep agent-UX cluster focused. Will land naturally with #1606/#1607 as workers update help strings.
- **#1605 (wait stable header)** — overlaps with the Monitor Epic event-projection shape (#1486). Wait until #1486 lands its projection helper, then route both through it.
- **#1812 (handleBrowserStart validation)** — sites edge case, not on the orchestrator's hot path. Defer.
- **#1848 (startTestDaemon PATH override)** — would simplify #1870's test wiring but adds scope. Implement #1870 with whatever inline harness work is needed; file a followup if it's painful.
- **#1865 (async gh in phase ticks)** — high-complexity perf refactor; real problem but defer to a sprint that can dedicate review attention.
- **#1811, #1825** — flaky tests on cold-path code; defer to a flaky-test mini-batch.
- **#1827, #1829, #1831** — claude-patch + TLS hardening; coupled to #1808 wiring (now landed) but no orchestrator pressure to do these immediately.
- **VFS/clone arc** — stalled 8+ sprints. No change.
- **Meta issues (#1858, #1860, #1863, #1866, #1867, #1806)** — all reviewed at plan time. None trivially-applicable now: #1858 (sprint-47 wind-down didn't fire) — sprint-48 wind-down will be live-tested, defer the root-cause to retro; #1860 (core.bare flip) — epic, needs design pass; #1863 (memory audit) — meta-skill, retro pass; #1866 (mergemaster wiring) — needs decision (wire or remove); #1867 (every-10-sprints introspection) — scheduled for sprint 57; #1806 (skip CI on docs branches) — 5 sprints stale, pick up when sprint container PRs become ≥3-min CI cost.

## Risks

- **Agent-UX cluster serializes on `claude.ts`.** 5 picks in a chain = 5 rebases minimum. Each rebase costs ~30s + the risk of duplicate-dispatch-entry merges (sprint-33 lesson — broadcast targeted rebase directive). If #1606 takes >20 min to merge, consider letting #1607 draft against unmerged HEAD and rebase-on-merge (cheap since these are additive).
- **#1836 (parallel-spawn ghosts) repro is timing-sensitive.** May need careful test design to reproduce reliably in CI vs. locally. Budget for 1 round of self-repair on the test layer.
- **#1864 (updateWorkItem transactional) might surface a schema lock-ordering issue** if other handlers hold separate transactions on the same db. Watch for SQLITE_BUSY in test output.
- **Quota.** Sprint 47 hit 100% on first 5h block at ~02:00 EDT. Sprint 48 has 4 opus picks (3 high-scrutiny adversarial reviews expected: #1836, #1837, #1864, #1859 — but #1864/#1859 are isolated 1-file changes, faster reviews). Estimate ~25–35% utilization. Should fit one block.
- **Time pressure.** Sprint 47 ran ~4h 15m. Sprint 48 has the same number of opus picks (4) and one extra sonnet pick. Estimate ~3–4h orchestrator-active.
- **Coverage-CI guard.** The #1870 fix is in main. If sprint-48 work re-introduces a code path that calls `<binary> --version` on something other than the resolver probe, the truncation chain could resurface. Watch coverage CI on each sprint PR; if it goes red, check for new spawn paths first.

## Retro rules applied (carried forward from sprint 47)

1. **Verify merge with `state == MERGED && mergedAt != null`** before marking work item done. (Sprint 47 lesson — saved as `feedback_verify_merge_actually_fired.md`.)
2. **Admin-merge is legitimate when CI is provably broken on a passing change.** Conditions: green check, green build, reviewer-approved or qa:pass, local tests passing. Sprint 47 used this 4 times correctly. **Sprint 48 should reduce admin-merge count to ≤1 once #1870 lands** — that's the leading indicator that the fix worked.
3. **One TaskCreate per issue** with `addBlockedBy` edges (sprint 41 lesson, permanent rule).
4. **Override triage to adversarial review when plan calls high scrutiny.** #1836, #1837, #1864, #1859 = 4 adversarial expected.
5. **Reviewer self-repair when findings are 1-3 contained edits.** Sprint 47 saved ~$10 with this pattern; expect similar this sprint.
6. **Long-lived sprint-48 branch + worktree.** Same pattern as sprint 47.
7. **Daemon restart in pre-flight.** Done at plan time (binary was 8.2h stale). Run.md will repeat at run time — idempotent.
8. **Out-of-band P1 PR ingestion is documented pattern.** If user asks for QA on a parallel-session PR, use the 4-command flow.
9. **Apply meta-fixes between sprints on `meta/<descriptor>` branches** — none applied this plan, all deferred.

## Tentative sprint 49 outline

> Sprint 49 — "slim builds + flaky-test mini-sprint + meta cleanup." Target: 12-15 PRs.

| # | Title | Scrutiny | Notes |
|---|-------|----------|-------|
| 1602 | slim builds: standalone mcx agent / mcx call binaries | high | anchor, with design doc |
| 1865 | replace blocking gh spawnSync in phase ticks (perf) | high | dedicated review attention |
| 1812 | fix(sites): handleBrowserStart edge cases | low | sprint-48 deferred |
| 1848 | startTestDaemon PATH override | low | test infra |
| 1811 | flaky: server-pool SIGTERM | low | flaky mini-batch |
| 1825 | flaky: offline git-remote-mcx | low | flaky mini-batch |
| 1841 | flaky: liveBuffer overflow gap control message | low | flaky mini-batch |
| 1838 | flaky: liveBuffer backfill async timing | low | flaky mini-batch |
| 1605 | mcx claude wait stable header | low | depends on #1486 projection |
| 1604 | mcx claude spawn help text | doc | trivial |
| 1819 | agent.ts/claude.ts success messages 'Error:' prefix | low | followup to #1798 |
| 1850 (if missed) | replacement char | low | only if sprint 48 doesn't land it |

Plus a meta retro pass on #1858/#1860/#1863/#1866/#1867/#1806.

## Context

Sprint 47 shipped v1.8.1 — 11 PRs (10 sprint + 1 out-of-band P1 #1835). The Phase 6 trio + first waitForEvent consumer + orchestrator-DX fillers all landed. The coverage CI deterministic-red since #1835 (#1870) was fixed in PR #1869 between sprints (mock-claude `--version` handler + `process.exitCode` switch); main is currently green. Two daemon usability P1s (#1836 + #1837) bit sprint 47 and remain open — sprint 48 fixes those head-on, then revives the `mcx agent` UX cluster the user has been waiting on since sprint 44.

Three meta cleanup PRs landed between sprint-47 retro and sprint-48 plan: #1862 (run.md prune), #1868 (sprint-48 plan-time meta cleanup, applied #1845 doc drift), and the diary postmortem amendment. The orchestrator's reading material is in better shape going into sprint 48 than it was for sprint 47.

The Monitor Epic dropped to ~5 issues post-sprint-47 — effectively closed. Phase 6 was the original charter; remaining issues are followups (#1486, #1572, #1565, #1791, #1792). No urgency to push them.
