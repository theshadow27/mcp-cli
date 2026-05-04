# Sprint 52

> Planned 2026-05-04 00:00 EDT. Target: 11 PRs (15 work items; 4 bundled).

## Goal

**"Close sprint-51 follow-ups + kill the 2 recurring server-pool flakies
with proper nerd-snipe-gated repairs + take a real swing at #1860's
47-sprint `core.bare=true` epic. Plus a 4-issue claude-status cluster
bundle and a few filler quick wins."**

Sprint 51 was a "ratchet" sprint that landed 12 PRs (v1.8.5) and filed 7
follow-up issues. Sprint 52 closes those, but the headline work is
infrastructure: two server-pool flakies recurred mid-sprint 51 (one each
blocked #1936 and #1892's CI), and the `core.bare=true` flip has
defensive workarounds in two phase scripts after 47 sprints of recurrences.
Time to root-cause both classes.

## Issues

| # | Title | Scrutiny | Batch | Model | Category |
|---|-------|----------|-------|-------|----------|
| 1980 | flaky: server-pool closeAll kills stdio child processes | high | 1 | opus | sprint-51 follow-up + nerd-snipe gate |
| 1987 | flaky: disconnect SIGTERM race (server-pool.spec.ts:1708) | high | 1 | opus | sprint-51 follow-up + nerd-snipe gate |
| 1860 | core.bare=true root-cause (47 sprints of workarounds #394/#1206/#1243/#1330) | high | 1 | opus | heavy epic |
| 1973 | mcx status crashes on null extraUsage.utilization | low | 1 | sonnet | sprint-51 follow-up (DX) |
| 1974 | work-item-poller auto-binds sprint-container PRs to every issue | medium | 1 | sonnet | sprint-51 follow-up (orchestrator hygiene) |
| 1992 | done-fn.ts SIGTERM exit-code misses Go-graceful exits | low | 2 | sonnet | sprint-51 follow-up |
| 1993 | repair-fn.ts review_session_id not cleared on repair spawn | low | 2 | sonnet | sprint-51 follow-up |
| 1903+1904+1905+1906 | claude status cluster (call count + whitespace + help + subcommand) | low | 2 | sonnet | bundled, backlog |
| 1684 | agent_sessions.repo_root not canonicalized (#1526 follow-up) | low | 2 | sonnet | DB hardening |
| 1634 | Bun.sleep(0) comment accuracy in opencode-process.spec.ts | low | 3 | sonnet | filler (trivial) |
| 1769 | playwright.spec.ts test comment update | low | 3 | sonnet | filler (trivial) |
| 1647 | resolve-playwright tests hardcode /tmp paths and leak temp dirs | low | 3 | sonnet | filler |

15 work items, 11 PRs after the #1903+#1904+#1905+#1906 bundle.

## Batch Plan

### Batch 1 (immediate)
#1980, #1987, #1860, #1973, #1974

### Batch 2 (backfill)
#1992, #1993, #1903+#1904+#1905+#1906, #1684

### Batch 3 (backfill)
#1634, #1769, #1647

### Cross-issue dependencies (addBlockedBy edges)

None this sprint — every issue touches independent files. The
sprint-51 cross-bundle blockedBy edges aren't repeating because we're
not bundling on shared files.

### Flake nerd-snipe gate (mandatory, per `feedback_flaky_tests.md`)

Both #1980 and #1987 are `label:flaky`. The orchestrator's flaky-handling
rule says: spawn `nerd-snipe` (opus) BEFORE `phase=impl`, post the
timeline + bisect log + mechanism + fix plan as an **issue comment**.
The trail goes on the GitHub issue, not in the session transcript, so
the next sprint can't re-misdiagnose. If nerd-snipe cannot identify
*both* the root cause and a concrete fix, apply `needs-attention` and
do NOT advance to phase=impl — "spawn opus and hope" is the failure
mode this rule exists to prevent (sprint 47 / #1870 incident).

Sequence per flake:
1. Spawn `nerd-snipe` agent (opus) with: repro, suspected commit
   range, prior diagnoses, `gh issue view` timeline.
2. nerd-snipe posts findings as an issue comment.
3. **Hard gate**: if no root cause + concrete fix → `needs-attention`,
   surface in retro.
4. Otherwise: phase=impl on opus (NOT sonnet — adversarial review
   verifies the implementation matches the documented mechanism).
5. Adversarial review for the impl PR — verify it matches the
   mechanism, not just "tests pass now."

### Hot-shared file watch

- `.claude/phases/done.ts` — #1992 only
- `.claude/phases/repair.ts` — #1993 only
- `packages/command/src/commands/claude.ts` — #1903+#1904+#1905+#1906
  bundle only (no other picks touch this; the bundle is internally
  serialized as one PR)
- `packages/daemon/src/server-pool.ts` and `server-pool.spec.ts` —
  #1980 and #1987 may both touch this. Serialize naturally via the
  nerd-snipe gate: #1980 nerd-snipe → #1987 nerd-snipe → impls (with
  rebase between, the second PR picks up the first's fix). Orchestrator
  to broadcast a rebase directive when the first lands.
- `packages/daemon/src/db/state.ts` — #1684 only
- `packages/core/src/cli-config.ts` (or wherever quota status renders) —
  #1973 only
- `packages/daemon/src/work-item-poller.ts` — #1974 only

No two PRs share a dispatch table this sprint.

## Context

**Sprint-51 outcome**: 12 PRs merged + 3 issues closed-as-already-done,
v1.8.5 released. Anchors landed clean — patcher hardening (#1827),
session.permission_blocked event (#1948), event-stream guards (#1961+#1962),
DB v3 migration regression (#1892), AliasContext.repoRoot threading
(#1958), phase-script test extraction (#1960). Adversarial review on
#1958 and #1960 each spawned ~3 contained findings that landed cleanly.

**Plan-time triage closed 2 issues** (verified against current main):
- #1988 — `setTimeout(fn, delay, arg)` 3-arg form already handled by
  sprint 51's #1985 commit `0b16d1f` (`extractDelayArg` finds the 2nd
  positional arg).
- #1991 — `scanReviewComments` parsing bug already fixed inline by
  sprint 51's #1990 commit `39303a1` (`lastIndexOf + slice` rewrite).

**Carry-over signals**:
- **Server-pool flakies are persistent**: #1934 closed 2026-05-01, recurred
  as #1980 by 2026-05-04. #1902 closed 2026-04-30, recurred as #1987 by
  2026-05-04. Same tests, same race patterns. Memory rule says
  nerd-snipe-gate before impl — sprint 50 / 51 didn't apply it on these
  because they surfaced as collateral on unrelated PRs (CI rerun fixed
  the surface and the underlying bug was filed for "later"). Sprint 52
  is later.
- **#1860 is a 47-sprint debt**. Two phase scripts have `git config core.bare
  false` defensive pre-flights. The memory file calls it out as "until
  sticky fix lands." Worth a dedicated opus session with a deep-investigation
  prompt — the suspect is `git worktree remove` interaction with daemon-held
  worktrees, but no one has run it down.
- **Orchestrator hygiene is at stake on #1974**. Sprint 51 hit it: every
  issue tracked during setup got auto-bound to PR #1972 (the sprint container)
  because the container body lists every issue. Cosmetic at impl time but
  hazardous at retro auto-merge. A closing-keyword filter (`fixes #N` /
  `closes #N` only) plus container-PR exemption is the natural fix.

**Risks**:
- **3 opus picks** (#1980, #1987, #1860) — same opus burn profile as sprint 51
  (which peaked at 96% 5h utilization). Pacing matters: stagger the opus
  spawns, don't run all 3 in parallel. Quota memory: prefer 270s waits over
  ≥300s to keep prompt cache warm during gaps.
- **#1860 may be unboundedly hard**. The proposal is "dedicated initiative."
  If the opus session can't find a concrete root cause in 1-2 hours, downgrade
  to "document findings + improve workaround" rather than chasing forever.
  Apply needs-attention rather than wedging the sprint.
- **Two flakies, one file**. #1980 and #1987 both target `server-pool.spec.ts`.
  Nerd-snipe both before impl, then land impls in dependency order
  (whichever fix is easier first; rebase the second).
- **Spread across 8+ distinct file areas**. Same shape as sprint 51 — small
  PRs, no cross-area bleed expected.

**Releasability**: Sprint 52 picks are mostly patch (bug fixes + small
refactors + tests). #1860 *could* be major if the root cause requires a
public-API change, but more likely it's an internal daemon fix — patch.
Probable v1.8.6 at retro unless something unexpected surfaces. No
minor-bump candidates.

## Process notes (carry-forward from sprint 51)

1. **Capture phase JSON once, extract both fields** (workaround for
   #1922; codified through sprint 51 — kept until #1922's fix #1949 is
   confirmed soak-tested):
   ```bash
   OUT=$(mcx phase run <p> --work-item ...) && \
     MODEL=$(echo "$OUT" | jq -r '.model // "sonnet"') && \
     PROMPT=$(echo "$OUT" | jq -r '.prompt')
   ```
2. **Sonnet verify-only repair** when QA fail reason is "stale verdict
   on contained finding" (impl session has fixed + replied since the
   verdict). New pattern from sprint 51 — saved $1+ on #1827 vs the
   default-opus repair flow. Detect: qa:fail body cites threads that
   have reply chains AND the cited fix exists in `git diff
   origin/main...HEAD`. Spawn sonnet manually with a verify+label-swap
   prompt (~12 turns / $0.20).
3. **Read-after-write race in QA** — sprint 51 hit it 5 times. QA
   spawned within seconds of impl push read pre-reply state. **Workaround
   for sprint 52**: sleep ~30s after impl push before spawning QA when
   Copilot inline reviews are likely (i.e. anything other than docs-only).
   File a proper fix as a follow-up if it bites again.
4. **Bundle prompt template**: spawn `/implement <first-issue>` then
   immediately `mcx claude send "Bundle: implement BOTH ... in the SAME
   PR ..."`. Used 4× in sprint 51 without a single bundle splitting.
5. **8-minute wait before QA vote after PR push** still applies until
   #1907 (deferred) lands inline-dismiss.
6. **Verify auto-merge with `state == MERGED && mergedAt != null`** —
   never trust just the auto-merge queue.
7. **One TaskCreate per issue (or per bundled-PR)** with addBlockedBy
   edges from the dependency list. (None this sprint, but the rule stands.)
8. **No `Bun.sleep` in test fixes — deterministic synchronization only**
   *except* as a Promise.race deadline (sprint 51 #1979 established this
   as acceptable when the read winning is what makes the test pass; the
   sleep is the safety bailout). AbortController is preferred where
   feasible.
9. **Use the `Monitor` harness tool, not raw Bash `mcx monitor`** —
   per #1947. `references/run.md` leads with the `Monitor` form.
10. **Permission_request event filter is stale** post-#1948. The
    Monitor stream subscribes on `session.permission_request` which now
    fires for every Edit/Write/Bash. ~30+ noise events in sprint 51.
    Run.md filter should swap to `session.permission_blocked`. **This
    is a meta change; apply via `meta/run-md-permission-blocked-filter`
    branch in Step 1a or defer to retro.**
