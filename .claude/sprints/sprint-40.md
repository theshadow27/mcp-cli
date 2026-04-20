# Sprint 40

> Planned 2026-04-20. Target: 20 PRs (1 decomposition spike + 5 anchor-derived + 6 sprint-39 tails + 2 OWA + 6 filler).

## Goal

**Land the first slice of `mcx monitor`** (#1486) — the streaming, enriched event bus. The epic replaces the poll-and-hydrate loop with a self-contained event stream. Sprint 40 delivers the decomposition + the first two design slices (streaming IPC protocol + unified event bus wiring), along with the sprint 39 follow-ups and a handful of recurring-bug fillers.

## Step 0 (immediate, before batch 1): decompose #1486

Spawn an **opus planning session** that reads #1486 end-to-end and files 3–5
concrete implementation issues with clear surface area and acceptance tests.
The epic body explicitly calls this out ("Needs its own plan phase and ~3-5
issues spawned from the design"). Expected output:

- `#1486-a` — streaming NDJSON IPC over the Unix socket (long-lived response, flush semantics, back-pressure)
- `#1486-b` — unified `MonitorEvent` envelope + bus wiring across session/work-item/mail silos
- `#1486-c` — durable `seq` + persistence so events survive daemon restarts
- `#1486-d` — `mcx monitor` CLI with `--subscribe`, `--session`, `--pr`, `--type` filters
- `#1486-e` — projection layer (≤200-char default lines, ban mid-turn chunks, opt-in `--response-tail`)

Those 5 become the batch 1 picks. Until they exist, only the tails + fillers are runnable.

## Issues (provisional — `#1486-a..e` resolve during Step 0)

| # | Title | Scrutiny | Batch | Model | Category |
|---|-------|----------|-------|-------|----------|
| **1486-a** | streaming NDJSON IPC | high | 1 | opus | monitor-epic (TBD) |
| **1486-b** | unified MonitorEvent bus wiring | high | 1 | opus | monitor-epic (TBD) |
| **1486-c** | durable monotonic `seq` | medium | 2 | opus | monitor-epic (TBD) |
| **1486-d** | `mcx monitor` CLI + filters | medium | 2 | sonnet | monitor-epic (TBD) |
| **1486-e** | projection layer + `--response-tail` | medium | 3 | sonnet | monitor-epic (TBD) |
| **1495** | repoRoot canonicalization in phase_state tools | low | 1 | sonnet | #1468 follow-up |
| **1500** | rename deleteIfMerged → deleteIfSafeToDelete | low | 2 | sonnet | #1498 follow-up |
| **1501** | extract MAX_TIMEOUT_MS = 299_000 constant | low | 2 | sonnet | #1499 follow-up |
| **1504** | `mcx untrack` accepts `#NNNN` / `pr:NNNN` IDs | low | 2 | sonnet | sprint 39 wind-down |
| **1505** | work_items_update null coercion | low | 2 | sonnet | sprint 39 wind-down |
| **1506** | CI `pull_request` trigger gap on force-push | medium | 3 | opus | sprint 39 wind-down |
| **1398** | mcx gc `_acp` / daemon-unreachable recurrence | medium | 3 | opus | recurring (sprint 34 → 39) |
| **1502** | opencode-tools buildAgentTools() refactor | low | 3 | sonnet | filler |
| **1394** | mail: clarify recipient naming in help text | low | 3 | sonnet | filler (docs) |
| **1250** | wind-down rebuild breaks concurrent cross-repo sprints | low | 3 | sonnet | filler |
| **1455** | sites: jq_input/jq_output + named fetch filters + OWA seed | medium | 2 | opus | OWA (imminent use) |
| **1460** | sites: OWA seed missing wiggle.js keep-alive | low | 3 | sonnet | OWA (depends on #1455) |
| **1354** | core: exclude __resetNagStateForTests from public barrel | low | 3 | sonnet | filler (trivial) |
| **1355** | worktree: nag message lacks repo-path context | low | 3 | sonnet | filler (UX) |
| **1361+1319** | manifest: JSDoc says "Does not stat" but uses lstat (bundle) | low | 3 | sonnet | filler (docs bundle) |
| **1366** | add `core_bare_healed_total` metrics counter | low | 3 | sonnet | filler (metrics) |

## Batch Plan

### Batch 1 — Decompose + launch epic (immediate)
**Step 0: decompose #1486** (opus, one session, blocks batch 1 work picks)

Then: #1486-a, #1486-b, #1495

### Batch 2 — Monitor epic slice + sprint 39 tails + OWA foundation (backfill)
#1486-c, #1486-d, #1500, #1501, #1504, #1505, **#1455**

### Batch 3 — Remaining + recurring + fillers (backfill)
#1486-e, #1506, #1398, #1502, #1394, #1250, **#1460**, #1354, #1355, #1361+#1319, #1366

**Batch 3 filler ordering:** #1460 depends on #1455 — land only after #1455
merges. The other fillers are independent; spawn in parallel as sessions
free up from epic waits.

## Dependency graph

```
#1486 decomposition (spike) — blocks all #1486-* picks
#1486-a — streaming IPC — blocks #1486-d (needs the stream to consume)
#1486-b — event bus — blocks #1486-c (seq needs bus)
#1486-c — durable seq — independent-ish after #1486-b
#1486-d — CLI — needs #1486-a landed
#1486-e — projection — independent, can land anytime

#1495 — independent (work-items-server.ts, small)
#1500 — independent (worktree-shim.ts)
#1501 — follow-up to #1499 (claude.ts:1418 area, tiny)
#1504 — independent (untrack command)
#1505 — independent (work_items_update)
#1506 — investigation-heavy, may close without a code change
#1398 — may split into sub-issues — daemon startup ordering for virtual servers
#1502 — independent refactor
#1394 — independent help text
#1250 — independent, design-only discussion may predominate

#1455 — sites/ area; NamedCall resolver + jq transforms + OWA seed. Foundation for OWA usability.
#1460 — BLOCKED on #1455; adds seeds/owa/wiggle.js + config wiring.

#1354 — barrel export tweak; no conflicts.
#1355 — worktree nag UX string; independent.
#1361+#1319 — manifest.ts JSDoc fixes; bundle into one PR; independent.
#1366 — add metrics counter; touches metrics.ts + daemon.ts call site; independent.
```

**Hot-shared file watch:**
- `packages/daemon/src/ipc-server.ts` — #1486-a will rewrite significant
  portions. No other picks touch it. OK to parallel.
- `packages/core/src/work-item.ts` + `packages/daemon/src/github/work-item-poller.ts`
  — #1486-b and #1495 both land here. Serialize: #1495 first (tiny), then #1486-b.

## Excluded (with reasons)

- **Sites: #1453** (Bun.WebView adapter) — not OWA-critical, defer to a dedicated sites-infra pass.
- **Sites: #1459** (500→retry for stale session headers) — preferred fix is `wiggle.js` (#1460), which eliminates staleness at the source. Revisit only if #1460 doesn't fully resolve.
- **fast-import cluster** (#1263, #1277, #1279, #1280) — blocked on #1209 epic progress; not ready.
- **pull.spec.ts cluster** (#1256, #1266, #1265, #1264, #1224) — sprint 39 verified #1267 was already fixed; these may be dups of it. One worker should scan/consolidate in sprint 41 or during a filler.
- **#1397 merge-queue** — still superseded by post-#1486 "merge-then-verify-main-CI" design. Re-spec after monitor lands.
- **#1049 work-item tracker epic** — foundation for #1486, already landed. Close after #1486 ships.

## Risks

- **#1486 scope.** It's the largest epic queued. Scope discipline matters — the decomposition spike must write acceptance criteria tight enough that each sub-issue is ≤1 day. If the spike returns with "we need 12 issues," renegotiate before spawning; prefer landing the first 3 slices cleanly over a partial 12-issue wave.
- **Streaming IPC protocol change.** `#1486-a` touches the protocol hash. Coordinate: daemon + clients must restart together. Orchestrator must not spawn workers mid-deploy. Reference sprint 34 daemon-restart issue.
- **#1398 / mcx gc** is now on its third recurrence across sprints 34, 37, 39. If opus triage can't produce a repro, close as WONTFIX and document the manual fallback.
- **Sprint 39 follow-up inflation.** 6 issues in this plan were filed *during* sprint 39. That's normal, but if sprint 40 itself generates another 6+, we're accumulating follow-up debt. Track and review in retro.

## Merge strategy

Continue the sprint 38/39 pattern: full parallel merge authority
(`strict_required_status_checks_policy=false`), per-batch CI watch on last
merge, no single-pointer rebase cascade.

**New risk introduced in sprint 39 wind-down:** direct push to main is
rejected by branch protection (no push-bypass ruleset for orchestrator).
The release commit had to route through a PR + admin-merge. Sprint 40 must
either:
1. Add a bypass ruleset for the orchestrator (small meta change, pre-sprint), or
2. Continue routing releases through PR + `gh pr merge --admin`.

Option 2 is already viable (sprint 39 v1.6.2 used it); option 1 saves ~2
minutes per sprint end. Deferred to the retro/meta discussion.

## Context

Sprint 39 shipped v1.6.2 (13 work PRs + 9 closures = 22 resolved against
target 20). The pre-flight fix (#1489) to externalize `@mcp-cli/core` in
the alias bundler cleared a blocker introduced by PR #1487 in sprint 38.
Sprint 40 can now assume phase scripts can import core utilities safely.

Runway for `mcx monitor`:
- `_work_items` server has `phase_state_get/set/list/delete` (#1492)
- `ContainmentGuard.reset()` + `--containment-reset` send flag (#1494) —
  workers that trip containment can recover mid-sprint, freeing the
  orchestrator from daemon restarts
- Containment coverage extended: `sed`, `dd`, `curl`, `wget`, quoted-path
  variants, symlink realpath with iterative dirname walk (#1503, #1491)

With decomposition + 2 epic slices + 5 tails + 3 fillers, wall-time target
is **~3 hours** — longer than sprint 39 because the epic slices are
architectural, not mechanical. Expected opus count: 3–4 (up from sprint
39's ~6 via self-repair).
