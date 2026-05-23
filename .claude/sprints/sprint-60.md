# Sprint 60

> Planned 2026-05-23 05:35 EDT. Target: 13 PRs. Theme: **tech debt**.

## Goal

Pay down test-reliability and code-cleanliness debt: kill the known flaky/timeout-fragile tests, remove dead code and duplicated helpers, and fix stale orchestration comments — so future sprints run on a quieter, less surprising codebase.

## Issues

| # | Title | Scrutiny | Batch | Model | Category |
|---|-------|----------|-------|-------|----------|
| 2196 | pollUntil default 5s timeout leaves no headroom vs Bun 5s test timeout | medium | 1 | opus | goal |
| 2083 | Flaky: alias-bundle-tsc.spec.ts times out under parallel test load | high | 1 | opus | goal |
| 2204 | refactor(sites): remove dead sitesOpenInBrowser state | low | 1 | sonnet | goal |
| 1248 | clone.spec.ts commits to worktree HEAD during full test runs | medium | 1 | opus | goal |
| 2186 | phase(impl): stale #1286 reference; in-handler auto-spawn never shipped | medium | 1 | opus | goal |
| 2211 | flaky(test): server-pool disconnect tests timeout (pollUntil=test timeout) | high | 2 | opus | goal |
| 2205 | refactor(sites): dedup ToolResult/toolOk/toolError across browser-handlers + site-worker | low | 2 | opus | goal |
| 1353 | workItemResolver: add timeout + debug logging for hung-mount resilience | medium | 2 | opus | goal |
| 1662 | chore(sites): codegen/build-time validation for seeds.ts vs seeds/ parity | medium | 2 | opus | goal |
| 2217 | reviveSession does not propagate cwd from state to config before spawnClaude | low | 2 | sonnet | goal |
| 1247 | test(tracing-server): strengthen limit-clamping test with actual data | low | 3 | sonnet | filler |
| 2193 | fix: grammar in OpenCode tool descriptions ("a OpenCode" → "an OpenCode") | low | 3 | sonnet | filler |
| 2100 | lint: make Bun.sleep check blocking once existing violations are cleaned up | high | 3 | opus | goal |

All `claude` provider (column omitted = default).

## Batch Plan

### Batch 1 (immediate)
#2196, #2083, #2204, #1248, #2186

### Batch 2 (backfill)
#2211, #2205, #1353, #1662, #2217

### Batch 3 (backfill)
#1247, #2193, #2100

### Dependency edges (translate to `addBlockedBy` at run)
- #2211 blockedBy #2196 (the pollUntil default decision must land first; #2211's server-pool fix then rebases onto it — both touch `server-pool.spec.ts`)
- #2205 blockedBy #2204 (both touch `packages/daemon/src/site/browser-handlers.ts`; remove dead state first, then dedup the remaining helpers)
- #2100 blockedBy #2083, #2196, #2211 (the Bun.sleep sweep touches ~15 spec files; let the targeted flaky fixes land first so the sweep rebases onto them instead of conflicting)

### Hot-shared / serialization notes
- `server-pool.spec.ts`: #2196 + #2211 (serialized via blockedBy)
- `browser-handlers.ts` / `site-worker.ts`: #2204 + #2205 (serialized via blockedBy)
- Spec files broadly: #2100 is the last thing to land — broadcast a "rebase + re-run lint:timeouts" directive when it starts. Scope it to exclude any files still in flight.

### Investigation gate (nerd-snipe before impl — see references/investigations.md)
- #2083 and #2211 are flaky-test issues with timing-dependent mechanisms. Both require the mandatory nerd-snipe gate (`mcx claude spawn`, persona inlined — NOT the Agent tool). Acceptable hard-fail outcome is `needs-attention` if the root cause is environmental rather than fixable. Recon suggests both are timeout-headroom issues (likely simple bumps), but confirm the mechanism before patching.

## Context

Sprint 59 wrapped clean (only open PR is the permanent #1077 bun-segfault repro). Plan-time verification closed **6 already-done issues** (#1400, #2209, #2212, #2213, #2214, #1234) — pr-thread refactors and cmdImport tests had already landed via recent PRs. #2193 was initially flagged done but verification found the grammar bug still live in the OpenCode snapshot, so it stays in scope.

Deferred this sprint: #2200 (meta — needs user review per Step 1a), #2208 + #2215 (external GitHub Actions transients, not fixable in our repo), #1639 (Bun stream-cancel limitation, code is already correct), and the fast-import/clone arc bugs (#1311/#1323/etc — entangled with the unbuilt #1211 writer, too risky to mix into a debt sprint).

Risk: #2100 is the heaviest pick (131 Bun.sleep violations across ~15 spec files). It's gated behind the flaky fixes and lands last; if it balloons, it's a clean candidate to split file-by-file or carry to sprint 61.
