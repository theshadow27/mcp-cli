# Sprint 50

> Planned 2026-04-30 20:28 EDT. Started 2026-04-30 20:55 EDT. Target: 15 PRs.

## Goal

**"Anchor on async gh (event-driven phase transitions); knock down flakes,
sprint-47/48 tech debt, and post-#1899 security follow-ups; show sprint 50
ships quality, not slop."**

Sprint 50 is a milestone — a deliberate moment to clear leaf-node backlog,
remediate the introspection-round tech debt that should be done before the
sprint-57 round, and avoid pure papercut sweeps. Anchor #1865 moves phase
ticks off blocking `Bun.spawnSync('gh', ...)` toward an event-driven model.

## Issues

| # | Title | Scrutiny | Batch | Model | Category |
|---|-------|----------|-------|-------|----------|
| 1865 | perf(phase): async gh / daemon-side gh cache | high | 1 | opus | anchor |
| 1857 | refactor(daemon): extract AbstractWorkerServer<T> for claude/codex/acp/opencode | high | 1 | opus | tech-debt (47-48) |
| 1934 | flaky: server-pool closeAll kills all stdio child processes races on CI | medium | 1 | sonnet | flake |
| 1929 | security: @file denylist misses ~/.config/gh/hosts.yml + 20+ credential paths | medium | 1 | sonnet | security |
| 1922 | bug: qa phase script returns no .model on re-entry (audit review/repair too) | low | 1 | sonnet | orchestrator |
| 1856 | refactor(daemon): split ipc-server.ts (1,973L / 58 handlers → per-domain modules) | medium | 2 | sonnet | tech-debt (47-48) |
| 1825 | Flaky test: offline git-remote-mcx scenario | low | 2 | sonnet | flake |
| 1890+1891 | bundle: schema_versions idempotent INSERT + UPSERT for setSchemaVersion | medium | 2 | sonnet | db-hardening |
| 1941 | security: readFileWithLimit can hang on FIFOs/character devices inside cwd | medium | 2 | sonnet | security |
| 1908 | phase(review): respect plan's high-scrutiny model column or accept --model override | low | 2 | sonnet | filler |
| 1928 | containment.spec.ts symlink traversal test is CWD-sensitive — fails from /tmp | low | 3 | sonnet | filler |
| 1604 | docs: mcx claude spawn help text — returns immediately, don't background | low | 3 | sonnet | filler |
| 1900 | lint: flag unbounded args[++i] without bounds check in hand-rolled arg parsers | low | 3 | sonnet | filler |
| 1632+1633 | bundle: check-test-timeouts regex misses (multi-line + callback patterns) | low | 3 | sonnet | filler |
| 1690 | Persist ciRunStates to SQLite across daemon restarts (#1577 follow-up) | low | 3 | sonnet | filler |

## Batch Plan

### Batch 1 (immediate)
#1865, #1857, #1934, #1929, #1922

### Batch 2 (backfill)
#1856, #1825, #1890+#1891 (bundle), #1941, #1908

### Batch 3 (backfill)
#1928, #1604, #1900, #1632+#1633 (bundle), #1690

### Cross-issue dependencies (addBlockedBy edges)

None at plan time. The two refactors (#1856 ipc-server, #1857 worker-base)
touch independent files. The DB bundle (#1890+#1891) and the security
follow-ups (#1929, #1941) are independent. If #1865's daemon-side gh cache
introduces a new IPC handler, it may serialize against #1856's
ipc-server split — orchestrator should land #1856 first OR coordinate
rebase guidance when one merges.

### Hot-shared file watch

- `packages/daemon/src/ipc-server.ts` — touched by #1856 (the split).
  If #1865's anchor adds a new handler, it lands in the post-split layout
  on rebase.
- `scripts/check-test-timeouts.ts` — touched by #1632+#1633 bundle and
  potentially by #1900 (lint extensions). Bundle them in #1632/#1633
  as one PR; #1900 is a separate file (different lint script).

## Context

**Sprint-49 outcome**: 15 PRs merged, v1.8.3 released. First sprint on the
new monitor-stream playbook (sprint-48's #1871) ran reactively — no polling
loop. Plan-time triage closed 11 dups/already-done. Adversarial review on
#1899 worked exactly as designed (caught architectural issue + edge case).

**Carry-over signals**:
- Security wave: #1899 fixed cwd-only @file containment, but the broader
  credential exposure (#1929) and FIFO hang (#1941) are real follow-ups.
- DB hardening: #1890+#1891 are race conditions surfaced by sprint-49
  schema-versions work. #1883/#1892 deferred (different files, no cluster
  pressure).
- Phase-script orchestrator pain: #1922 directly bit sprint 49 (5 sessions
  spawned with --model null). Same pattern likely affects review.ts and
  repair.ts — audit those too.
- Tech debt (#1856–#1866 round): 6/11 already closed by sprint 49 work.
  Still open: #1856, #1857, #1860, #1861. Sprint 50 picks 2 (#1856 +
  #1857). #1860 deferred (needs reproducer). #1861 deferred (coverage
  threshold work — fits a quieter sprint).

**Risks**:
- **Two opus picks in batch 1** (#1865 + #1857). If both stall in
  adversarial review simultaneously, batch progress suffers — orchestrator
  should drain to QA before launching batch 2 if cost climbs.
- **#1856 split is mechanical but high blast-radius** (58 handlers across
  one file). Adversarial review must verify behavior parity, not just
  module shape.
- **Sprint 50 = milestone** — natural moment to release v1.9.0 if sprint
  diff warrants it (anchor + 2 refactors + security cluster ≈ minor bump).

## Process notes (carry-forward from sprint 49)

1. **Capture phase JSON once, extract both fields**: `OUT=$(mcx phase run
   <p> --work-item ...) && MODEL=$(echo "$OUT" | jq -r '.model // "sonnet"') &&
   PROMPT=$(echo "$OUT" | jq -r '.prompt')` — never call twice. Codified
   workaround until #1922 lands.
2. **Reviewer self-repair on contained findings** — keep using; saved a
   repair spawn on #1899.
3. **Bundled PRs for related issues** — #1890+#1891 + #1632+#1633.
4. **8-minute wait before QA vote after PR push** — not yet codified in
   /qa, orchestrator should remind QA agents.
5. **Verify auto-merge with `state == MERGED && mergedAt != null`**.
6. **One TaskCreate per issue (or per bundled-PR)** with addBlockedBy edges.
7. **No Bun.sleep in test fixes** — deterministic synchronization only.

## Pre-sprint meta-fixes applied

- **#1867** — code-first introspection cadence template + retro hook
  (sprints ending in 7). Merged as #1943 on `meta/introspection-template`
  branch before sprint open.
- **`workflow` label created** to replace `meta` mislabeling on
  workflow-idea issues (#1860, #1806 relabeled; #1863 closed in favor of
  #1945 with corrected Haiku-audit framing).

## Retro notes (captured during run)

- **Long-lived Monitor should be the runbook default, not an alternative**
  (user feedback during run). `references/run.md` currently presents the
  per-tick `--max-events 1` form first and the long-lived stream as
  "Long-lived alternative" — this should be inverted. The orchestrator's
  Monitor harness tool persists across ticks, ndjson is push-shaped, and
  the `--max-events 1` form belongs to subprocess harnesses we don't use.
- **Premature bye on #1922 (Dave session 1bbc1f5d)**: I ended Dave's
  session immediately after `session.idle` while PR #1949 was still
  CI=BLOCKED. Runbook says bye only on PR merged OR `qa:pass` + clean
  threads + green CI. PR survived on origin (worktree cleanup deleted only
  the local branch), so recoverable, but a process violation worth flagging.
- **Compaction trial mid-run**: post-spawn compaction reduced context
  bloat as intended; only loss observed was the `mcx tracked --json`
  schema (`.id` not `.workItem`/`.items`), recovered with one inspect
  call. Net positive — keep trying.
