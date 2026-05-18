# Sprint 53

> Planned 2026-05-04 10:25 EDT. Started 2026-05-17 18:22 EST. Ended 2026-05-17 19:34 EST. Target: 15 PRs. Merged: 12 + 1 already-done.

## Goal

**"Clear sprint-52 carry-over (#1996, #2003, #1980, #1987 with progressive-posting nerd-snipe), tighten orchestrator hygiene (#1944, #1933, #1948), and back-fill the test gaps the last two sprints filed."**

Sprint 52 closed the 47-sprint `core.bare` epic and held the line on
flake-gate discipline (both #1980 and #1987 routed to `needs-attention`
when nerd-snipe stalled at the 600s watchdog). Sprint 53 picks them
back up with a tightened nerd-snipe prompt — progressive-posting every
N turns + bisect plan delivered first — so the watchdog can't claim
agents that are making real progress. Plus the obvious carry-overs
(#1996 .gitkeep deletions, #2003 ensureCoreBareUnset return ambiguity)
and a deliberate cluster of test back-fills (#1759, #1754, #1565,
#1572) that the last two sprints filed but didn't get to.

## Issues

| #    | Title                                                            | Scrutiny | Batch | Model  | Category                  |
|------|------------------------------------------------------------------|----------|-------|--------|---------------------------|
| 1980 | flaky: server-pool closeAll kills stdio child processes          | high     | 1     | opus   | sprint-52 carry-over (needs-attention; nerd-snipe-gated via `mcx claude spawn`, see #2009) |
| 1987 | flaky: disconnect SIGTERM race (server-pool.spec.ts:1708)        | high     | 2     | opus   | sprint-52 carry-over (needs-attention; nerd-snipe-gated via `mcx claude spawn`, see #2009) |
| 1996 | build: bun scripts/build.ts stages npm/*/bin/.gitkeep deletions  | low      | 1     | sonnet | sprint-52 carry-over (DX) |
| 2003 | refactor(git): ensureCoreBareUnset return value ambiguity        | medium   | 1     | sonnet | sprint-52 carry-over (#1860 follow-up) |
| 1944 | feat(phase): mcx phase advance --work-item                       | medium   | 1     | sonnet | orchestrator hygiene      |
| 1933 | refactor(claude): cmdClaudeInternal status case bypasses DI      | low      | 2     | sonnet | orchestrator hygiene      |
| 1948 | session.permission_request fires for auto-approved tools         | medium   | 1     | sonnet | orchestrator noise        |
| 1645 | fix(sites): _defaultInstall uses execPath in compiled mode       | low      | 2     | sonnet | sites bug                 |
| 1661 | fix(sites): wiggle() passes raw site param to withPage()         | low      | 3     | sonnet | sites bug                 |
| 1599 | fix(sites): proxy 401-retry picks same stale credential          | low      | 3     | sonnet | sites bug                 |
| 1703 | feat(permissions): bare `mcp__server` server-wide wildcard       | low      | 3     | sonnet | permissions parity        |
| 1572 | test(monitor): GET /events?since= backfill integration test      | low      | 2     | sonnet | test back-fill            |
| 1759 | test: backfill path coverage for ring-buffer fallback gate       | low      | 3     | sonnet | test back-fill            |
| 1565 | test(monitor): cmdMonitor --timeout integration test             | low      | 2     | sonnet | test back-fill            |
| 1754 | test(alias-bundle): timeout path coverage for evalBundledJs      | low      | 3     | sonnet | test back-fill            |

15 work items. 2 high (opus), 3 medium (sonnet), 10 low (sonnet) — a
deliberate skew toward small wins after sprint 52's opus-heavy profile.

## Excluded (amended at run start)

- **#1948** — already merged at sprint-52 close (PR #1976, 2026-05-04 02:19 UTC). Plan-time triage missed this because the merge landed ~12h before plan finalization. Removed from Batch 1.
- **#1933** — already merged at sprint-52 close (PR #1989, 2026-05-04 02:55 UTC). Same root cause. Removed from Batch 2.
- **#1645** — already-done discovered at run-time (PR #1641 secondary squash addressed it 2026-04-23). Worker self-detected and closed the issue. Removed from Batch 2.

Net: 12 work items (2 opus / 10 sonnet). 4 remaining in Batch 1: #1980, #1996, #2003, #1944.

## Batch Plan

### Batch 1 (immediate)
#1980, #1996, #2003, #1944, #1948

### Batch 2 (backfill)
#1987, #1933, #1645, #1572, #1565

### Batch 3 (backfill)
#1759, #1754, #1599, #1661, #1703

### Cross-issue dependencies (addBlockedBy edges)

- #1987 blockedBy #1980 — both touch `packages/daemon/src/server-pool.{ts,spec.ts}`. Naturally serializes via the nerd-snipe gate; second PR rebases on the first's fix.
- #1759 blockedBy #1572 — both touch `packages/daemon/src/ipc-server.spec.ts`. Land the bigger backfill integration test first; the ring-buffer fallback test rebases.
- #1661 blockedBy #1645 — both touch `packages/daemon/src/site/browser/playwright.ts` (or adjacent install/wiggle helpers). Serialize.

### Flake nerd-snipe gate (corrected spawn shape — see #2009)

Both #1980 and #1987 are `label:flaky,needs-attention` with sprint-52
trail comments documenting partial findings + bisect plan. Per
`feedback_flaky_tests.md`: spawn nerd-snipe (opus) BEFORE `phase=impl`,
post timeline + mechanism + fix plan as an issue comment.

**Sprint-52 retro framed this as a 600s-watchdog problem. That framing
was wrong** — see #2009 for the investigation. Actual mechanism: the
sprint-52 orchestrator invoked the **Agent tool**
(`Agent({subagent_type: "nerd-snipe", run_in_background: true})`), which
gives the parent no progress visibility into the sub-context. Sub-agent
transcripts show 28 minutes of active reasoning, killed by a parent-side
cutoff while still 1–2 turns from a verdict. The "watchdog" was the
orchestrator's poll-and-give-up misread.

**Sprint-53 spawn shape: `mcx claude spawn`, NOT the Agent tool.**

```bash
mcx claude spawn --worktree --model opus -t \
  "You are nerd-snipe (read .claude/agents/nerd-snipe.md directly first \
to ground in the persona — do NOT invoke the Agent tool yourself). \
Your job is to investigate GitHub issue #<n>: <one-line repro>. \
Existing needs-attention trail: <link>. Verify or reject the suspected \
mechanisms in the bisect plan order. Post findings as an issue comment \
with timeline + mechanism + concrete fix plan."
```

The "do NOT invoke the Agent tool yourself" line is critical — without
it, nerd-snipe will helpfully `Agent({subagent_type: "nerd-snipe"})`
recursively and re-create the same sub-context invisibility.

Hard gate unchanged: if no root cause + concrete fix → `needs-attention`,
do NOT advance to phase=impl. "Spawn opus and hope" is the failure
mode this rule prevents (sprint 47 / #1870).

Sequence per flake:
1. `mcx claude spawn` a worker session (NOT Agent tool) with: existing
   comment trail link, suspected mechanisms from sprint-52 partial
   trail, bisect range, `gh issue view <n>` timeline.
2. Track via `mcx claude wait <session>` and `mcx claude log <session>` —
   tool_use events stream natively, so progress is observable. Nerd-snipe
   may run for an hour; that's fine.
3. nerd-snipe posts findings + bisect verification as an issue comment.
4. Hard gate: if no root cause + concrete fix → `needs-attention` again,
   surface in retro.
5. Otherwise: phase=impl on opus (NOT sonnet — adversarial review
   verifies the implementation matches the documented mechanism).
6. Adversarial review for the impl PR — match the mechanism, not
   "tests pass now."

### Hot-shared file watch

- `packages/daemon/src/server-pool.{ts,spec.ts}` — #1980 and #1987 both. **Serialized.**
- `packages/daemon/src/ipc-server.spec.ts` — #1572, #1759 both. **Serialized.**
- `packages/daemon/src/site/browser/` — #1645 (`resolve-playwright.ts`), #1661 (`playwright.ts`/`wiggle`). Serialize as belt-and-suspenders.
- `packages/daemon/src/site/browser/proxy.ts` — #1599 only.
- `scripts/prepare-npm.ts` — #1996 only.
- `packages/core/src/git.ts` — #2003 only (touches 8+ call sites across daemon-side files but git.ts is the API change).
- `packages/command/src/commands/claude.ts` — #1933 only.
- `packages/permissions/src/rule.ts` — #1703 only.
- `packages/command/src/commands/phase.ts` — #1944 only (new `advance` subcommand).
- `packages/daemon/src/codex-session.ts` (or per-provider equivalents) — #1948 only.
- `packages/core/src/alias-bundle.ts` — #1754 only.
- `packages/command/src/commands/monitor.spec.ts` — #1565 only.

No two PRs share a dispatch table this sprint. The two serialized pairs
(#1980/#1987, #1572/#1759, #1645/#1661) are explicit blockedBy edges.

## Context

**Sprint-52 outcome**: 9 PRs merged + 4 already-done closures + 2
needs-attention, v1.8.6 released. Anchors: 47-sprint #1860 epic
(structural fix, eliminated `core.bare` config key), `mcx status` null
guard, `done-fn` SIGTERM heuristic, repair `review_session_id` clear,
`agent_sessions.repo_root` canonicalization + v4 migration. Both
adversarial-reviews on opus PRs found real blockers; reviewer
self-repair held in both cases.

**Plan-time triage** (verify-still-open, per sprint-52 retro
recommendation):
- All 15 picks verified open + reproducible at plan time.
- #1996: confirmed code-level (recreate `.gitkeep` post-build), not
  process-level. The Explore agent located `unlinkSync(gitkeep)` in
  `scripts/prepare-npm.ts:77`.
- #1944: confirmed `mcx phase` has `run/install/check/list/show/why`
  but no `advance` subcommand.
- #1933: confirmed `cmdClaudeInternal status` case still bypasses DI
  at `packages/command/src/commands/claude.ts:318–322`.
- #1980, #1987: still failing on rerun, comment trails from sprint-52
  needs-attention routing remain the latest signal.
- The other 9 picks have no "already-done" risk identified in recon.

**Plan-time meta-fixes (PR #2008 merged)**:
- #2002 — `run.md` pre-flight aligned with `core.bare` key absence.
- #2007 — `scanReviewComments` verdict-line heuristic; surveyed 200
  merged PRs (49 with stickies, 38 approved): **38/38 false positives
  → 0**. Reviewer prompt nudged toward "verdict line first + same-line
  resolution markers in delta tables."

**Risks**:
- **#1980 + #1987**: previous "stalls" were Agent-tool sub-context
  visibility issues (#2009), not genuine analysis stalls. Sprint 53
  uses `mcx claude spawn` for nerd-snipe, which mcx instruments
  natively — progress is observable. Hard gate still applies (no root
  cause + fix → needs-attention, never spawn impl-on-hope), but the
  nerd-snipe itself is no longer artificially time-bounded.
- **#1996 scope ambiguity**: Explore flagged uncertainty between
  recreate-`.gitkeep` and process-only fix. Implementer has discretion;
  the diary's "every implementer hits this" framing favors a code fix.
- **#1944 is the only "feature" pick**. New CLI subcommand. Adversarial
  review can spot CLI-shape issues (flag naming, output format) that QA
  alone won't.
- **#2003 touches 8 call sites**. Even though scrutiny is medium,
  reviewer should explicitly verify all callers handle the new
  discriminated union (sprint 52's #1684 hit a similar "3 of 4 workers
  unpatched" issue when canonicalization moved).
- **No cross-batch dependency cascades expected** beyond the three
  explicit blockedBy edges.

**Releasability**: Bug fixes + small refactors + tests + one minor
feature (#1944). Probable v1.8.7 (patch). #1944 alone could justify
a minor bump if the API surface ends up being substantial — defer the
call to retro.

## Process notes (carry-forward from sprint 52)

1. **Capture phase JSON once, extract both fields** (workaround for
   #1922; #1949 fix landed in sprint 51 — keep until soak-tested):
   ```bash
   OUT=$(mcx phase run <p> --work-item ...) && \
     MODEL=$(echo "$OUT" | jq -r '.model // "sonnet"') && \
     PROMPT=$(echo "$OUT" | jq -r '.prompt')
   ```
2. **Sonnet verify-only repair** when QA fail reason is "stale verdict
   on contained finding" (impl session has fixed + replied since the
   verdict).
3. **Read-after-write race in QA** — sleep ~30s after impl push before
   spawning QA when Copilot inline reviews are likely (anything other
   than docs-only). File a proper fix as follow-up if it bites again.
4. **Bundle prompt template** for already-done clusters: `/implement
   <first>` then `mcx claude send "Bundle: implement BOTH ... in the
   SAME PR ..."`.
5. **Verify auto-merge with `state == MERGED && mergedAt != null`** —
   never trust just the auto-merge queue.
6. **One TaskCreate per issue** with addBlockedBy edges from the
   dependency list. (3 edges this sprint.)
7. **No `Bun.sleep` in test fixes — deterministic synchronization
   only**, except as a Promise.race deadline.
8. **Use the `Monitor` harness tool, not raw Bash `mcx monitor`**.
9. **Verdict-line heuristic now active in `scanReviewComments`**. The
   reviewer template was updated in PR #2008 to put the verdict line
   first and pair every prior 🔴/🟡 with a same-line resolution marker
   (✅/Fixed/Resolved/Addressed). If a review session still produces
   the old format, the heuristic should still pass for `✅ APPROVED`
   stickies; gather examples for retro if any review→qa transitions
   wedge.
10. **Plan-time triage step**: every issue verified open + reproducible
    before slotting. Caught zero already-done this sprint, but the
    discipline matters more in long sprints.

## Results

- **Released**: v1.8.7 (patch — feature add `mcx phase advance` is a
  subcommand, not new top-level)
- **PRs merged**: 12 (#2026, #2027, #2028, #2029, #2030, #2031, #2032,
  #2033, #2035, #2038, #2039, #2041)
- **Issues closed**: 13 (12 fixed + #1645 already-done detected at
  run-time)
- **Issues dropped**: 2 (#1948, #1933 — both merged in sprint-52 close
  ~12h before plan finalization; plan-time triage missed them)
- **New issues filed**: 3+ (issue #2025 — `mcx claude ls --all --short`
  hang, #2040 — test coverage gap for the #1980 null paths, plus
  several Copilot follow-ups discovered during repair)
- **Repair rounds**: 4 (round-1 each on #1703 — Copilot caught real
  bug; #1996 — Copilot caught .npmignore precedence bug; #1944 —
  reviewer self-repair (9 fixes) then sonnet round 2 for remaining
  slice() guard; #1980 — QA caught wrong root cause from nerd-snipe,
  opus added identity-based test assertion)
- **Carry-over**: PR #2037 (user-pushed mid-sprint — am-i-done MVP)
  remained with user at sprint close.
- **Wall-clock**: 72 minutes start to last merge (18:22 → 19:34 EST)
- **Flake-induced CI rounds**: Every single PR that landed before
  #2038 (the #1980 fix) hit the `#940` flake at least once and
  required a CI rerun. The flake was the dominant sprint bottleneck —
  see Retro.
