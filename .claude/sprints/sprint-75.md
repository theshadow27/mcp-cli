# Sprint 75

> Planned 2026-07-11. Target: 16 PRs (15 + pre-start amendment #2848). Started 2026-07-11 18:30 EDT.

## Goal

Orchestrator reliability: fix the stdio drop-and-hang class, the monitor/daemon blind spots, and the phase-lock worktree bug — clear the sprint-74 fallout so the next orchestrated run sits on trustworthy rails.

## Issues

| # | Title | Scrutiny | Batch | Model | Provider | Category |
|---|-------|----------|-------|-------|----------|----------|
| 2840 | mcx auth: stale/revoked keychain refresh_token hard-fails instead of interactive re-auth | low-medium | 1 | opus | claude | goal |
| 2737 | phase-lock: findGitRoot resolves to main checkout from linked worktrees | medium | 1 | opus | claude | goal |
| 2838 | handleStdioLine guard discards buffered pre-disconnect output (structural fix for the #2825 class) | high | 1 | opus | claude | goal |
| 2836 | mcx claude bye attempts worktree removal for --cwd sessions it didn't create | low | 1 | opus | claude | goal |
| 2832 | alias error output doubled prefix "Error: Error:" (fix on alias-server side) | low | 1 | sonnet | claude | filler |
| 2833 | unbounded await on stdioDrainDone hangs exit handler if grandchild holds stdout fd | low-medium | 2 | opus | claude | goal |
| 2508 | mcx monitor/wait silently binds to a dead daemon — fail-fast + liveness | low-medium | 2 | opus | claude | goal |
| 2788 | coverage crash-tolerance passthrough misses #1419 pattern when verdict entirely absent | low-medium | 2 | opus | claude | goal |
| 2782 | mcx daemon reload silently downgrades daemon from a stale client | low | 2 | opus | claude | goal |
| 2835 | daemon main.ts: worker-dispatch async rejection undiagnosed + argv provenance ungated | low | 2 | opus | claude | filler |
| 2837 | monitor: bursts of stale session.idle re-emitted as new (nerd-snipe gate BEFORE impl) | high | 3 | opus | claude | goal |
| 2662 | mcx worktree gc: squash-merged and pristine worktrees never reclaimed (~130 dirs today) | low-medium | 3 | opus | claude | goal |
| 2815 | coverage: defense-in-depth against silent spec-count reduction | low | 3 | opus | claude | filler |
| 2843 | ci.yml: two inline steps still pass-by-policy on Bun crash citing closed #1004 | low | 3 | sonnet | claude | filler |
| 2749 | mcx claude ls: spurious "git diff failed (exit null)" on stderr | low | 3 | sonnet | claude | filler |
| 2848 | acp: grok banner before JSON-RPC frames kills session start (tolerate preamble + surface first bytes on failure) | low-medium | 3 | opus | claude | goal |

## Batch Plan

### Batch 1 (immediate)
#2840, #2737, #2838, #2836, #2832

### Batch 2 (backfill)
#2833, #2508, #2788, #2782, #2835

### Batch 3 (backfill)
#2837, #2662, #2815, #2843, #2749, #2848

### blockedBy edges
- #2833 blockedBy #2838 (both rewrite the ws-server.ts drain/exit/disconnect state machine, L990–L1220)
- #2662 blockedBy #2836 (gc builds on the removeWorktree idempotency #2836 introduces)
- #2815 blockedBy #2788 (same scripts/_runner/ci-steps.ts region — bug first, defense-in-depth on top)
- #2835 blockedBy #2832 (both touch packages/daemon/src/alias-server.ts — different regions, light, but serialize to avoid a surprise rebase)

## Hot-shared file watch
- `packages/daemon/src/claude-session/ws-server.ts`: #2838 → #2833 (serialized above). Deferred siblings #2774/#2773 also live here — do NOT amend them in while #2838/#2833 are in flight without re-running the overlap check.
- `packages/daemon/src/abstract-worker-server.ts`: #2774/#2773 (both DEFERRED — confirmed adjacent-line collision L574–586; if either is amended in, the other stays out).
- `scripts/_runner/ci-steps.ts`: #2788 → #2815 (serialized above).
- `packages/daemon/src/index.ts` removeWorktree: #2836 → #2662 (serialized above).
- `packages/core/src/monitor-event.ts`: #2508 and #2837 share only this type file; their work (`commands/monitor.ts` vs `event-log.ts`) is disjoint. Whichever merges second rebases and checks for envelope-type conflicts.
- `.github/workflows/ci.yml`: #2843 only (PR #2842 already merged pre-sprint; #2752's GH_TOKEN fix already on main — no live overlap).

## Special handling

- **#2837 — mandatory nerd-snipe investigation gate before impl** (references/investigations.md; `mcx claude spawn` shape, NOT the Agent tool). The stale-replay mechanism is NOT root-caused: repro requires heavy rate-limiting; seq ranges are recorded on the issue from the sprint-74 orchestrator session. Hard-fail outcome `needs-attention` is acceptable. Do not let a worker "fix" event-log replay without a reproduced mechanism.
- **#2838 — high scrutiny**: structural narrowing of the #2814 guard (the #2825 class: any premature disconnect drops buffered output). Constraint from #2833/#2825 history: NO `Promise.race` timeout band-aids — that re-introduces the #2825 drop. Regression tests must use stdin-faithful fixtures (see PR #2830's fixture lesson: bare `cat` exits without reading stdin → EPIPE → false repro).
- **#2737 — product-code fix, not phase-file surface**: `packages/core/src/git.ts` findGitRoot + `packages/command/src/commands/phase.ts` resolveRoot. Includes re-adding phase-lock to PRE_COMMIT/PRE_PUSH in `scripts/am-i-done.ts` and dropping the absence assertions in am-i-done.spec.ts. Two recorded manifestations (#2826 QA round, #2728 deferral) are the acceptance evidence: `mcx phase check` from a linked worktree must resolve the worktree tree, not the main checkout.
- **#2840 — P1 usability**: analog to landed #1546; scope is oauth-retry.ts `_runFlow`, oauth-provider.ts `tokens()`/`invalidateCredentials` (+ `skipKeychainTokens` opt mirroring `skipKeychainClientId`), and the auth.ts error text. Verify against SDK 1.29.0 behavior described on the issue.
- **#2836 must NOT change the bye default** (that's blocked #1750): only gate removal on isCreator + make removal idempotent ("is not a working tree" → no-op).
- **#2848 (pre-start amendment, 2026-07-11)**: implement suggested fixes (1) + (3) together — skip non-JSON preamble lines until the first parseable JSON-RPC frame in the ACP stdio reader (hardens against ANY banner-printing agent, not just grok), and on handshake failure surface the first bytes actually read instead of the bare "Process exited". Surface: `packages/daemon/src/acp-session/` (+ `packages/acp/src/agents.ts` only if a spawn-env flag is added — prefer not). Test with a fake agent that emits a banner line then valid ACP; no overlap with any batched issue (claude-session and acp-session are disjoint trees). The issue's trailing codex log/status bug is being split into its own issue — do NOT fix it under #2848.

## Excluded

- #2774/#2773 (stderr sanitize + SQLite batching): confirmed collision pair on abstract-worker-server.ts L574–586, and #2774 also lands in the #2838/#2833 ws-server hot file. Deferring both keeps the ws-server chain 2-deep instead of 4-deep. First alternates if slots free late — as a serialized pair only.
- #2841 (gate-lease opts.slots): cheap but just filed; alternate on deck.
- #2834 (_work_items isError semantics): latent trap with no current in-repo caller — defer.
- #2783/#2770 (flakies): NOT relieved-confirmed post-gate-lease; both need one bundled nerd-snipe investigation (same suspected bun worker-pool contention root). Alternate: a single investigation slot covering both, only if capacity frees up.
- #2727 (suite mutates tracked files): recon says both named specs are clean on main — close-as-done pending one clean-tree confirmation (`bun test` + `git status`) at sprint start; no impl slot.
- #2752 (stale-todos retry): root cause (missing GH_TOKEN) already fixed on main at ci.yml L106 — rescope comment to be posted, residual retry/backoff is low value.
- #2805 (stdio containment parity): still needs a product decision, not a worker slot.
- #2743, #2500, #2499, #2485, #2577, #2611 etc.: epics — not sprint-sized.
- Meta-labeled issues (#2839, #2576, #2553, #2507, #2485, #2393, #2182): orchestrator/retro surface, per the meta-issue planning guard. #2839 (release-tag sha guard) recommended as a pre-sprint meta-fix.

## Context

Sprint 74 (gate integrity) closed 2026-07-02 with v1.14.4; its last deliverable (#2797 CI smoke wiring) landed 2026-07-11 via PR #2842 during recovery, which also produced #2841/#2843. This sprint drains the rest of the 74 fallout: the #2825 stdio class gets its structural fix (#2838/#2833), the orchestrator's two blind spots (#2508 dead-daemon bind, #2837 stale-event replay) get fixed or root-caused, and #2737 stops taxing every phase-file PR. Codex provider remains broken (#2482) — all sessions route to claude. Sprint 75 does not end in 7 — no introspection round.
