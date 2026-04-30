# Sprint 49

> Planned 2026-04-30 EDT. Started 2026-04-30 18:07 EDT. Target: 15 PRs.

## Goal

**Stabilize the test suite + burn down older bugs (>3 sprints stale).** First sprint to exercise the new `mcx monitor` stream playbook with diverse work types — flaky-test cluster fixes, older-bug carry-over, and sprint-48 follow-ups. Validates the run.md migration shipped in sprint 48 PR #1871 (closes #1875).

Two threads:

1. **Test stabilization.** Two flaky-test clusters dominate sprint 47/48 CI noise: containment.spec.ts /tmp cwd artifact (5 dups: #1687/#1689/#1743/#1770/#1794) and server-pool.spec.ts SIGTERM/SIGKILL race (4 dups: #1552/#1811/#1882/#1902). Both collapse to one PR each. Plus #1910 (resolve-playwright deterministic failure on clean main, surfaced during sprint-49 plan-time pre-flight) and a handful of test-cleanup follow-ups.
2. **Older-bug carry-over.** Six bugs filed sprints 41-44 that have been gathering dust: #1772 (help formatter alignment), #1683 (test fixture leaks), #1637 (OAuth structured error type), #1525 (aliasState validation), #1531 (DEFAULT_TIMEOUT_MS regression), and the security pick #1899 (@file path traversal — security/high scrutiny).

The remaining slots are sprint-48 follow-ups (test rigor, lint hardening, status-command polish).

**Note:** Eleven issues close-as-done at plan time before run starts (no code work):
- **Dups → #1687**: #1689, #1743, #1770, #1794 (all the containment.spec.ts /tmp variant)
- **Dups → #1552**: #1811, #1882, #1902 (all the server-pool.spec.ts SIGTERM variant)
- **Already fixed in main**: #1646 (resolve-playwright `{ cause: err }` is in place at line 181), #1881 (`parseSitesArg` index-based `!(i in sites)` loop is in place at site-worker.ts:320), #1838, #1841 (liveBuffer determinization shipped in sprint 48 PR #1880 + earlier #1784)
- **Untriageable**: #1708 (sprint-42 wind-down flake, no test name captured)

## Issues

| # | Title | Scrutiny | Batch | Model | Category |
|---|-------|----------|-------|-------|----------|
| **1899** | security: @file path resolution has no traversal guard | high | 1 | opus | goal — security |
| 1687 | test(containment): symlink test /tmp cwd artifact (closes 4 dups) | medium | 1 | sonnet | goal — flaky |
| 1552 | flaky: server-pool disconnect SIGTERM/SIGKILL (closes 3 dups) | medium | 1 | sonnet | goal — flaky |
| 1772 | help(formatter): column alignment >32-char pad cap | low | 1 | sonnet | goal — older |
| 1525 | ipc-server: aliasState* handlers validate repoRoot is absolute | low | 1 | sonnet | goal — older |
| 1683 | test(monitor): GET /events invalid-pr loop test leaks servers | medium | 2 | sonnet | goal — older |
| 1637 | auth: introduce OAuthCallbackTimeoutError structured type | low | 2 | sonnet | goal — older |
| 1531 | refactor(timeout): restore DEFAULT_TIMEOUT_MS regression | medium | 2 | sonnet | goal — older |
| 1910 | flake: resolve-playwright "package missing" fails on clean main | medium | 2 | sonnet | goal — flaky/main red |
| 1897 | lint: enforce sessions.delete before await (TOCTOU prevention) | medium | 2 | sonnet | filler — sprint-48 followup |
| 1888 | test(ws-server): mock spawnFn non-resolving exited promise | low | 3 | sonnet | filler — sprint-48 followup |
| 1889 | test(claude): worktree uniqueness — make deterministic with UUID mock | low | 3 | sonnet | filler — sprint-48 followup |
| **1893+1894** | test+chore(db): migrations test rigor + dead local cleanup | low | 3 | sonnet | filler — bundled |
| **1903+1904+1905+1906** | feat/fix(claude): status command followups (footprint, whitespace, help) | low | 3 | sonnet | filler — bundled |
| 1911 | test(claude): regression-prevention for claude-only-subcommand dispatch | low | 3 | sonnet | filler — sprint-48 followup |

**Model mix:** 1 opus + 14 sonnet.
**Scrutiny mix:** 1 high (security adversarial), 6 medium, 8 low.
**Provider:** all `claude` (default — column omitted).
**Bundled PRs:** 2 (mark in implementer prompt: #1893+#1894 single PR; #1903+#1904+#1905+#1906 single PR).

## Batch Plan (launch order only — NOT the orchestrator's Task structure)

Per `run.md` Input → "Task list setup": one TaskCreate per issue (or per bundled-PR), with `addBlockedBy` edges from the dependency edges below. Idle slots auto-pull the next unblocked issue.

### Batch 1 — 5 unblocked picks (start immediately)

#1899, #1687, #1552, #1772, #1525

1 opus (#1899 — security adversarial review) + 4 sonnet. All five files are independent: `@file` resolver, `containment.spec.ts`, `server-pool.spec.ts`, help formatter (`output.ts`), and `ipc-server.ts` aliasState handlers.

### Batch 2 — 5 picks (start as Batch 1 unblocks)

#1683, #1637, #1531, #1910, #1897

#1683 touches `ipc-server.spec.ts` (different test file from any Batch 1). #1637 is isolated to `packages/daemon/src/auth/`. #1531 touches `claude.ts` help text + daemon worker timeout strings (potential rebase with the bundled status PR — see Hot-shared file watch). #1910 is isolated to `resolve-playwright.spec.ts`. #1897 is a daemon-side TOCTOU audit + lint rule.

### Batch 3 — 5 picks (start last)

#1888, #1889, #1893+#1894 (bundled), #1903+#1904+#1905+#1906 (bundled), #1911

#1888 isolated to `ws-server.spec.ts`. #1889 to `claude.spec.ts` (uniqueness test). #1893+#1894 bundled in `state.ts` migration. Status bundle touches `claude.ts` status output + help text. #1911 is a new spec file or test addition to `claude.spec.ts` — light collision with #1889.

## Dependency edges (translated to `addBlockedBy` at run time)

- **#1531 blockedBy #1903+#1904+#1905+#1906** — both touch `packages/command/src/commands/claude.ts` help text. Status bundle goes first (more changes), #1531 rebases on top. (Alternative: serialize the other way; either works, but the status bundle ships earlier so let it land first.)
- **#1911 blockedBy #1889** — both add tests under `packages/command/src/commands/claude.spec.ts` (or sibling). Serialize to avoid trivial test-file conflicts.

*(All other picks are independent of each other.)*

## Hot-shared file watch

- **`packages/command/src/commands/claude.ts`** — #1531 (help text DEFAULT_TIMEOUT_MS) + #1903+04+05+06 bundle (status output + help). Serialized via the chain above. Targeted rebase directive expected after the status bundle merges; orchestrator should grep for duplicate dispatch entries (sprint-33 #1291/#1293 lesson).
- **`packages/command/src/commands/claude.spec.ts`** (or claude-spawn.spec.ts / wherever uniqueness is tested) — #1889 + #1911. Serialized via blockedBy.
- **`packages/daemon/src/ipc-server.ts`** — #1525 only (aliasState validation hardening). Different file from #1683's spec.
- **`packages/daemon/src/ipc-server.spec.ts`** — #1683 only.
- **`packages/daemon/src/server-pool.spec.ts`** — #1552 only.
- **`packages/daemon/src/claude-session/containment.spec.ts`** — #1687 only.
- **`packages/daemon/src/site/browser/resolve-playwright.spec.ts`** — #1910 only.
- **`packages/daemon/src/auth/`** — #1637 only.
- **`packages/daemon/src/db/state.ts`** — #1893+#1894 bundle only.
- **`packages/daemon/src/ws-server.spec.ts`** — #1888 only.
- **`packages/command/src/`** (#1899 @file resolution) — security-isolated, no overlap.

## Pre-session clarifications required

Visible to workers via Step 1a in `.claude/commands/implement.md`.

- **#1899 (security: @file path traversal)**: `resolveAtPath` reads arbitrary FS paths. Add a guard that rejects paths outside the user's repo root + their home directory unless explicitly allowed. Tests: traversal attempt (`@/etc/passwd`, `@../../../../etc/passwd`) is rejected with a clear error; legitimate paths under cwd / `~/` succeed. Adversarial review mandate: this is a security pick — reviewer must check the guard logic, not just exit codes. Don't paper over by hashing or sanitizing — use real-path resolution + prefix check.
- **#1687 (containment.spec.ts /tmp)**: the test creates a symlink in `/tmp` and assumes the test runner's `process.cwd()` is *outside* `/tmp`. Fails when running from a worktree under `/tmp` or `/private/tmp`. Fix shape: either pin the symlink to a temp dir outside `/tmp` (pinning to `os.tmpdir()` won't help since that often *is* `/tmp`); use a unique subdirectory under the project root; OR change the assertion to use real-path resolution. Closes #1689, #1743, #1770, #1794 as dups (write the close commands in the PR body so they auto-close on merge).
- **#1552 (server-pool SIGTERM/SIGKILL flake)**: `disconnect kills stdio child processes (#940) > disconnect sends SIGTERM` flakes on CI when SIGKILL escalation fires before SIGTERM is observed. Fix shape: either (a) increase the SIGTERM observation window with deterministic synchronization (not a sleep — use the child's exit promise or an event hook), or (b) split into two tests — one that exits on SIGTERM, one that survives to SIGKILL. Don't use Bun.sleep. Closes #1811, #1882, #1902 as dups.
- **#1772 (help formatter alignment)**: column alignment breaks when a flag string exceeds the 32-char pad cap. Fix: dynamically resize the pad to the longest flag in the current help section (or wrap to next line for outliers). Test: render help with a >32-char flag and assert columns align.
- **#1525 (aliasState repoRoot absolute)**: handlers at `ipc-server.ts:1315/1321/1328/1335` accept a `repoRoot` param but only check non-empty. Add `path.isAbsolute()` validation; reject relative paths with a 400-class error.
- **#1683 (GET /events test fixture leaks)**: the invalid-pr loop test creates ~N servers per iteration without cleanup. Fix: factor out fixture teardown into the test's `afterEach` (or wrap in a `using` block). Don't change test semantics — just fix the leak.
- **#1637 (OAuthCallbackTimeoutError)**: replace string-prefix matching ("OAuth callback timeout") with a typed error class. Update the matchers in oauth-retry.ts (and tests) to instanceof check. Don't change retry behavior.
- **#1531 (DEFAULT_TIMEOUT_MS regression)**: commit `1bdd857` regressed `DEFAULT_TIMEOUT_MS` usage in `claude.ts` help text and daemon workers (replaced with hardcoded `60000` etc.). Restore the constant import + reference. Test: grep confirms no orphan literals remain.
- **#1910 (resolve-playwright on clean main)**: the test "surfaces useful error when install succeeds but package missing" fails on this machine but passed for Explore's verification. Reproduction: `bun test packages/daemon/src/site/browser/resolve-playwright.spec.ts` from main HEAD. First step: confirm the failure on a fresh clone, isolate environmental dependencies (vendor cache, BUN_INSTALL, package.json state). Fix may be: (a) the test relies on a flaky filesystem state; (b) recent dependency drift. Don't paper over with retries.
- **#1897 (sessions.delete before await — TOCTOU)**: in session-teardown methods, `sessions.delete(id)` must happen before any `await` to prevent another caller from observing the dying session. Audit all `sessions.delete` call sites. Add a custom ESLint rule OR a test that asserts the ordering pattern. The minimum acceptable is a manual fix + test for each violation; the lint rule is a stretch goal.
- **#1888 (spawnFn non-resolving exited promise)**: the `#1836 parallel test` mock has `exited: new Promise(() => {})` which never resolves, slowing afterEach. Replace with a resolved promise (or one that resolves on the test's intended exit signal).
- **#1889 (worktree uniqueness — UUID mock)**: the test relies on real `crypto.randomUUID()` randomness. Inject a counter-based mock for determinism (and to make the test cover the *uniqueness logic*, not RNG quality).
- **#1893+#1894 (bundled — migrations test + dead code)**: strengthen the "data migrations run exactly once" test (#1893) to assert persistence of the migration mark, not just absence-of-error on re-run; AND remove the dead local in `StateDb.migrate()` (#1894). Single PR. Don't expand scope.
- **#1903+#1904+#1905+#1906 (bundled — status command followups)**: four small follow-ups to sprint-48's #1609 (status one-shot): (1903) directory footprint should show line/byte count not call count; (1904) trim whitespace in target parsing so `'Alice, Bob'` resolves Bob; (1905) status missing from --help text; (1906) status missing from error message suggestions. Single PR. The implementer should grep for status registration and ensure consistency across all surfaces.
- **#1911 (claude-only-subcommand dispatch test)**: add a regression-prevention test that exercises every `mcx claude <subcommand>` and asserts the dispatcher routes correctly. Should be table-driven so adding a new subcommand auto-extends coverage.

## Backups (swap-in if a main pick drops or capacity remains)

Order: pull from top.

| # | Title | Scrutiny | Model | Why it's a backup |
|---|-------|----------|-------|-------|
| 1604 | mcx claude spawn help text correction | low | sonnet | Trivial doc; can fold into the status bundle as a worker bonus. |
| 1819 | agent.ts/claude.ts success messages 'Error:' prefix (followup #1798) | low | sonnet | Needs grep-verification first — recommended only if a planned pick drops and the `printError` audit is cheap. |
| 1684 | agent_sessions.repo_root not canonicalized (#1526 sister) | low | sonnet | Verify against #1526's resolveRealpath fix; if uncovered call site exists, swap in. |
| 1900 | lint: flag unbounded args[++i] without bounds check | low | sonnet | Lower-priority lint follow-up; valuable but not urgent. |
| 1825 | flaky offline git-remote-mcx (1 occurrence) | low | sonnet | Single-occurrence noise; only swap in if a clear pattern emerges. |

## Excluded (with reasons)

- **#1645 (_defaultInstall execPath)** — needs-clarification: code at line 115 explicitly comments "process.execPath is intentionally NOT used". Either the issue is misframed or there's a subtle path the comment doesn't cover. Filer must clarify before it's worked.
- **#1605 (mcx claude wait stable header)** — blocked on #1486 (epic: mcx monitor) projection helper. Defer until #1486 ships its formatter.
- **#1602 (slim builds)** — sprint-48 anchor candidate, deferred again. High-effort build refactor; needs design doc; no current blocker. Move when user wants it as the anchor.
- **#1865 (async gh in phase ticks)** — high-complexity perf refactor. Defer to a sprint with dedicated review attention.
- **#1827, #1829, #1831** (claude-patch + TLS) — coupled to #1808 wiring (landed) but no orchestrator pressure now.
- **VFS/clone arc** — stalled 9+ sprints. No change.
- **Meta issues (#1908, #1907, #1867, #1863, #1860, #1806)** — all reviewed at plan time.
  - **#1907 (QA inline-dismiss out-of-scope Copilot threads)** — high-value (~$8-12/sprint per diary). Recommended apply between sprints 49→50 as a meta-fix PR, NOT in this sprint. Sprint 49 still pays the ceremony cost.
  - **#1908 (review respect plan model column)** — landed as PR #1908 in 2026-04-29 cluster (commit `c03d4a34`). Verify status; if open by mistake, close.
  - **#1867 (every-10-sprints introspection)** — scheduled for sprint 57.
  - **#1863 (memory audit automation)** — meta-skill; defer to retro pass.
  - **#1860 (core.bare flip root cause)** — epic; needs design pass.
  - **#1806 (skip CI on docs-only)** — sprint container PRs not yet >3 min CI cost; defer.

## Risks

- **First sprint on the new monitor-stream playbook.** The orchestrator now reads from `mcx monitor` instead of `mcx claude wait`. Sprint 48 shipped the migration but ran on the old playbook. Watch for: dispatch-table misses (event types the orchestrator depended on), exit-code or buffering bugs in `mcx monitor --max-events 1`, payload shape drift. **File any papercut as an issue immediately — close in-sprint if 1-line.** If the new pattern surfaces a serious bug, run.md has a fallback section preserving the old playbook (sprint-49.md tentative outline section, lines 119–248 — note: that file was the now-overwritten outline; check git history if you need the prose).
- **Two flaky-test cluster fixes are timing-sensitive.** Both #1687 and #1552 involve OS-level timing (filesystem CWD detection, signal escalation). Repair-loop budget: 1 round each. If a third round is needed, it's a deeper issue — escalate to a fresh opus session.
- **#1899 (@file traversal) is the only adversarial review.** Don't relax the security check just because it's the lone high-scrutiny pick — that's the whole point.
- **#1910 may fail to reproduce.** Worker may report "passes on my machine" — instruct them to capture the failing output to issue, then move on (don't burn time).
- **Status bundle (#1903+04+05+06) might surface UI/UX feedback.** Worker should keep the impl tight to what each issue requested; resist scope creep.
- **Quota.** Sprint 48 used ~25-35% utilization. Sprint 49 has 1 opus + 14 sonnet (vs 4+11), so should be lighter. Estimate ~20-25%. One block ample.
- **Time pressure.** Sprint 48 ran ~3h 16m. Sprint 49 has more PRs of lower individual complexity — estimate ~2h 30m to 3h 30m.

## Retro rules applied (carried forward from sprint 47/48)

1. **Verify merge with `state == MERGED && mergedAt != null`** before marking done. (Permanent rule.)
2. **One TaskCreate per issue (or per bundled-PR)** with `addBlockedBy` edges. (Permanent rule.)
3. **Reviewer self-repair on contained findings** (1-3 file:line cited edits). Promoted to skill in sprint 48; expect to use on #1899 if reviewer finds 1-2 contained issues.
4. **Long-lived sprint-49 branch + worktree.** Same pattern.
5. **Daemon restart in pre-flight at run time.** `run.md` repeats the staleness check.
6. **Reduce admin-merge to 0** (sprint 48 hit 0; maintain).
7. **Targeted rebase directive on hot-shared files.** When the status bundle merges, broadcast: "rebase + grep duplicate dispatch entries you may have added in parallel" to #1531.
8. **No Bun.sleep in test fixes** (#1687, #1552, #1888 — all timing-sensitive). Use deterministic synchronization.
9. **Plan-time issue audit caught close-as-dones**: 11 issues already done or duplicates closed at plan time (no spawn cost).
10. **Bundled PRs require explicit bundle marker in TaskCreate.** Don't spawn separate sessions for #1893+#1894 or the status bundle.

## Tentative sprint 50 outline

See `.claude/sprints/sprint-50.md` — drafted alongside this plan with
**~50% capacity reserved for sprint-49 fallout** (test stabilization
second-pass, repair-loop residue, monitor-stream playbook papercuts).
Anchor candidates: #1602 slim builds (with design doc) or #1865 async
gh in phase ticks (perf). Per-bucket detail in the sketch.

## Context

Sprint 48 shipped v1.8.2 — 16 PRs, zero admin-merges, ~3h 16m. The two highest-value daemon P1s (#1836 parallel-spawn ghosts + #1837 bye worktree destroy) and the agent-UX cluster (#1603/#1606/#1607/#1608/#1609) all landed. Reviewer self-repair pattern saved ~$10. 14 of 16 PRs needed at least one repair, dominated by Copilot inline-thread ceremony — diary calls this out as the dominant cost driver and recommends QA inline-dismiss (#1907) as a meta-fix between sprints.

Sprint 49 takes a different shape: smaller individual changes, more of them, a single high-scrutiny security pick as the anchor, and the first real test of the run.md monitor-stream playbook shipped in #1871. Eleven close-as-done freebies clear stale duplicates and verify already-fixed code before any spawn happens. The flaky-test cluster has been the dominant CI-noise source since sprint 47; resolving #1687 and #1552 should drop that to single-digits per sprint.
