# Sprint 51

> Planned 2026-05-03 14:31 EDT. Started 2026-05-03 19:50 EDT. Target: 15 PRs.

## Goal

**"Sprint-50 ratchet — burn down the immediate follow-up cluster
(args-bounds lint #1900, daemon-split event-stream #1856, async-gh
phase #1865, worker-base #1857, status-footprint cluster #1903–06),
clear the 3 dropped items, and pick off DB-hardening + a security
heavy. Show that sprint-50's anchors leave clean leaf-nodes, not
half-finished landings."**

Sprint 51 is a deliberate "tidy the wake" sprint. Sprint 50 landed
six structural changes that each spawned 1–4 follow-ups during
adversarial review or QA. Some are already-done (#1690, #1883, #1935
closed at plan time). The rest cluster cleanly into bundles. Heavy
work is one — `claude-patch` atomicity (#1827, the #1808 cluster).

## Issues

| # | Title | Scrutiny | Batch | Model | Category |
|---|-------|----------|-------|-------|----------|
| 1827 | claude-patch: harden atomicity and error handling in patcher | high | 1 | opus | heavy (#1808) |
| 1948 | session.permission_request fires for auto-approved tools | medium | 1 | sonnet | sprint-50 follow-up |
| 1961+1962 | event-stream: bound subscribers + dispose() closes streams | medium | 1 | sonnet | sprint-50 follow-up (#1856) |
| 1967+1968+1969 | args-bounds lint: Rule 2 / Rule 3 / escape hatch | medium | 1 | sonnet | sprint-50 follow-up (#1900) |
| 1936 | scripts/*.spec.ts excluded from bun test by pathIgnorePatterns | low | 1 | sonnet | filler (unblocks 1967–69 tests) |
| 1892 | legacy DBs skip v3 symlink canonicalization regression | medium | 2 | sonnet | DB hardening |
| 1956 | test: dedicated spec for AbstractWorkerServer base class | low | 2 | sonnet | sprint-50 follow-up (#1857) |
| 1958 | phase model lookup: use findGitRoot instead of process.cwd() | low | 2 | sonnet | sprint-50 follow-up (#1865) |
| 1931+1932 | claude status footprint: MultiEdit accumulation + UTF-16 byte count | low | 2 | sonnet | sprint-50 follow-up (#1903) |
| 1928 | containment.spec.ts symlink traversal CWD-sensitive | low | 2 | sonnet | dropped (sprint 50) |
| 1933 | refactor(claude): cmdClaudeInternal status case bypasses DI | low | 3 | sonnet | sprint-50 follow-up (#1903) |
| 1960 | test: phase-script integration tests for async gh helper | medium | 3 | sonnet | sprint-50 follow-up (#1865) |
| 1632+1633 | check-test-timeouts: callback regex + multi-line patterns | low | 3 | sonnet | dropped (sprint 50) |
| 1374 | sweepCoreBare: missing test for cwd fallback path (#1330) | low | 3 | sonnet | filler |
| 1881 | parseSitesArg sparse-array check bypassed by extra props | low | 3 | sonnet | filler (security; small) |

## Batch Plan

### Batch 1 (immediate)
#1827, #1948, #1961+#1962, #1967+#1968+#1969, #1936

### Batch 2 (backfill)
#1892, #1956, #1958, #1931+#1932, #1928

### Batch 3 (backfill)
#1933, #1960, #1632+#1633, #1374, #1881

### Cross-issue dependencies (addBlockedBy edges)

- #1933 blockedBy #1931+#1932 (both touch `cmdClaudeInternal` status
  case in `packages/command/src/commands/claude.ts:316`. The two small
  bugs land first; the DI refactor rebases on top.)
- #1960 blockedBy #1958 (both touch `.claude/phases/*.ts`. #1958's
  small `findGitRoot` fix lands first; the integration-test scaffolding
  rebases on top so it doesn't conflict on `process.cwd()` call sites.)
- #1967+#1968+#1969 effectively blockedBy #1936 (lands in same batch,
  but #1936 unblocks the script test runner so the args-bounds bundle
  can ship tests that actually run in CI — orchestrator should land
  #1936 first if both are PR-ready in the same window).

### Hot-shared file watch

- `packages/command/src/commands/claude.ts` — touched by #1931+#1932
  bundle and #1933 (cmdClaudeInternal status case). Serialized via the
  blockedBy edge; orchestrator should not start #1933 until #1931+#1932
  is merged or about to merge.
- `scripts/check-args-bounds.ts` — touched by #1967+#1968+#1969 bundle
  (internally serialized as one PR).
- `scripts/check-test-timeouts.ts` — touched by #1632+#1633 bundle
  (internally serialized).
- `packages/daemon/src/event-stream.ts` — touched by #1961+#1962 bundle
  (internally serialized; the dispose-closes-streams change subsumes
  the subscribe-cap change's locking semantics).
- `.claude/phases/*.ts` — #1958 (small) → #1960 (test scaffold).
  blockedBy edge enforces order.
- `packages/daemon/src/db/state.ts` — #1892 only.
- `packages/core/src/claude-patch/patcher.ts` — #1827 only.
- `bunfig.toml` — #1936 only.

No two PRs share a dispatch table this sprint, so the sprint-33
duplicate-`case` hazard does not apply.

## Context

**Sprint-50 outcome**: 10 PRs merged + 2 closed-without-PR, v1.8.4
released. Anchors landed clean — async-gh phase ticks (#1865), daemon
ipc-server split (#1856), AbstractWorkerServer extraction (#1857),
args-bounds lint (#1900), and the security follow-ups (#1929/#1941).
Adversarial review on #1857 and QA on #1856 each spawned a tight
2-issue follow-up cluster (#1961+#1962, #1956). The status-footprint
sprint-50 PR (#1927) shipped with three known leaf-nodes
(#1931/#1932/#1933) deliberately deferred for batching.

**Plan-time triage closed 6 issues** (verified against current main):
- #1935 + #1940 — angleBracketDepth fix already in
  `scripts/check-session-teardown.ts:86–111`
- #1690 — `ci_run_states` table + load/upsert methods already in
  `packages/daemon/src/db/work-items.ts:229+454+473`
- #1883 — `version = version + 1` bumped in upsertWorkItem ON CONFLICT
  branches (`work-items.ts:302, 353`)
- #1965 — duplicate of #1961
- #1966 — duplicate of #1962

**Carry-over signals**:
- **#1808 cluster** (claude 2.1.121 sdk-url break): #1827 is the
  patcher hardening from #1826's adversarial review. Heavy slot.
  Other #1808 work (#1829, #1831) deferred.
- **DB hardening**: #1892 is a real data-integrity regression — legacy
  DBs get stamped at v3 without ever running v3's symlink
  canonicalization migration. Single-PR fix.
- **Orchestrator UX**: #1948 is a sprint-50-discovered noise issue —
  `session.permission_request` fires for auto-approved tools, which
  the orchestrator then has to filter or react to incorrectly. Two
  proposed designs in the issue body; pick at impl time.
- **Script tests not running**: #1936 (`scripts/**` in
  `pathIgnorePatterns`) means `scripts/*.spec.ts` is silently skipped.
  Sprint-50's #1900 lint shipped without test enforcement; sprint 51
  fixes the test-runner gap, then the #1967-69 bundle adds tests that
  actually run.

**Risks**:
- **One opus pick (#1827)** — adversarial-review surface area is the
  patcher in `packages/core/src/claude-patch/patcher.ts`. Three
  defensive items (atomic write, symlink-follow, missing error check).
  No structural rewrite expected.
- **#1933 refactor on hot file**: cmdClaudeInternal in `claude.ts` is
  touched by 4 sprint-50 cluster issues (#1931, #1932, #1933, #1948).
  The blockedBy edge serializes #1931+#1932 → #1933; #1948 lives in a
  different file (event-emit path), so cross-bundle conflicts should
  be rare.
- **Spread across many small files**: 15 PRs across 8 distinct file
  areas (claude.ts, event-stream.ts, args-bounds.ts, test-timeouts.ts,
  containment.spec.ts, db/state.ts, patcher.ts, sites parser).
  Orchestrator should keep PRs small and focused — no cross-area
  bleed.

**Releasability**: Sprint 51 is a polish sprint — all 15 picks are
patch-level (bug fixes + small refactors). Probable v1.8.5 at retro
unless one of the medium picks expands. No minor-bump candidates.

## Process notes (carry-forward from sprint 50)

1. **Capture phase JSON once, extract both fields** (workaround for
   #1922; codified in sprint 50's run, kept until #1922's sprint-49
   fix #1949 is fully soak-tested):
   ```bash
   OUT=$(mcx phase run <p> --work-item ...) && \
     MODEL=$(echo "$OUT" | jq -r '.model // "sonnet"') && \
     PROMPT=$(echo "$OUT" | jq -r '.prompt')
   ```
2. **Reviewer self-repair on contained findings** — keep using; saved
   a repair spawn on #1899 in sprint 49 and on #1857 in sprint 50.
3. **Bundled PRs for related issues** — sprint 51 bundles:
   #1961+#1962, #1967+#1968+#1969, #1931+#1932, #1632+#1633.
4. **8-minute wait before QA vote after PR push** — orchestrator should
   remind QA agents until #1907 (deferred) lands inline-dismiss.
5. **Verify auto-merge with `state == MERGED && mergedAt != null`** —
   never trust just the auto-merge queue.
6. **One TaskCreate per issue (or per bundled-PR)** with addBlockedBy
   edges from the dependency list above.
7. **No `Bun.sleep` in test fixes** — deterministic synchronization
   only.
8. **Use the `Monitor` harness tool, not raw Bash `mcx monitor`** —
   per #1947 (meta PR #1971, queued for auto-merge at plan time).
   `references/run.md` now leads with the `Monitor` form.

## Pre-sprint meta-fixes applied

- **#1947** — `references/run.md` now leads with the `Monitor` harness
  tool form, demotes raw Bash `--max-events 1` to fallback, deletes
  the file-redirection long-lived form. Applied via
  `meta/run-md-monitor-tool` branch (PR #1971; auto-merge armed at
  plan time).
- **Machine-local claude pin migration**: `~/.local/bin/claude` was
  retired from being the mcx-spawn target. mcx now resolves the spawn
  binary via `claudeBinary` config (set to
  `~/.local/share/mcp-cli-archive/claude-code/claude-2.1.119`). The
  user's interactive `claude` advances freely (auto-updater rotates
  the symlink to whatever Anthropic ships). Archive binaries
  2.1.114–2.1.119 protected with `chflags uchg`. Memory updated:
  `feedback_claude_2_1_121_break.md`. Not a code change — purely
  orchestrator-side state.
