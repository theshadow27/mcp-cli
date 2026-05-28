# Sprint 67

> Planned 2026-05-27. Started 2026-05-27. Ended 2026-05-28. Target: ~16 PRs. Theme: **Rules + tech-debt mop-up** (introspection sprint, ends in 7).

## Goal

Finish the doing-it-wrong rules system (#2352) and clear high-leverage tech-debt — anchored on the structural fix that ends the duplicate-issue storms: diff-scoping the coverage ratchet (#2495).

## Issues

| # | Title | Scrutiny | Batch | Model | Category |
|---|-------|----------|-------|-------|----------|
| 2495 | diff-scope am-i-done coverage ratchet (anchor) | high (adversarial) | 1 | opus | goal |
| 2343 | worker filesystem-escape into main checkout | high (nerd-snipe gate) | 1 | opus | goal |
| 2492 | allow-patterns resolveEffectiveTools empty-array footgun | low | 1 | sonnet | goal |
| 2457 | ci-steps happy-path closure-cache tests | low | 1 | sonnet | goal |
| 2488 | import-graph edge-drop diagnostic + cache hardening | low | 1 | sonnet | goal |
| 2491 | doing-it-wrong rules for allow-pattern regressions | medium | 2 | opus | goal |
| 2497 | monitor-executor dead bus.publish channel (double-emit) | high (adversarial) | 2 | opus | goal |
| 2496 | no-as-any rule + extend empty-catch to production | medium | 2 | opus | goal |
| 2486 | break alias-bundle.ts barrel-induced import cycle | medium | 2 | sonnet | goal |
| 2455 | acp-cost-tracking-evidence block-comment FP | low | 2 | sonnet | goal |
| 2464 | flaky ci-steps.spec.ts:403 under parallel run | high (nerd-snipe gate) | 3 | opus | goal |
| 2498 | production catch {} swallowing auth/git/parse failures | medium | 3 | opus | goal |
| 2317 | migrate clone-provider unwrapToolResult copies to core | low | 3 | sonnet | filler |
| 2474 | rule: no console.warn in .catch() without verbosity gate | low | 3 | sonnet | filler |
| 2489 | file-loader.ts coverage (14.3% → 80%) | low | 3 | sonnet | filler |
| 2490 | docs: DEFAULT_SAFE_TOOLS union Claude-specific comment | low | 3 | sonnet | filler |

All Provider = `claude` (codex spawn is broken — #2482; never route codex this sprint).

## Batch Plan

### Batch 1 (immediate)
#2495, #2343, #2492, #2457, #2488

### Batch 2 (backfill)
#2491, #2497, #2496, #2486, #2455

### Batch 3 (backfill)
#2464, #2498, #2317, #2474, #2489, #2490

### Dependency edges (blockedBy)
- #2491 blockedBy #2492 (shared `packages/core/src/allow-patterns.ts`; #2492 changes the return contract first)
- #2490 blockedBy #2492 (shared `allow-patterns.ts`)
- #2464 blockedBy #2457 (shared `scripts/_runner/ci-steps.spec.ts`; land the clean happy-path tests, then rebase the flaky fix)

### Notes
- Rule-adds (#2488/#2455/#2474/#2491/#2496) each create their own `scripts/rules/*.rule.ts`; the engine discovers by glob (no central registry), so no dispatch-table collision.
- #2495 supersedes the *urgency* of #2489 — once the ratchet is diff-scoped, a pre-existing file-loader gap no longer fails unrelated worktrees. #2489 stays as a quick coverage backfill, not a blocker.
- #2343 and #2464 hit the **nerd-snipe investigation gate** (`references/investigations.md`) before impl — `mcx claude spawn` with persona inlined, NOT the Agent tool (#2009). Hard-fail outcome = `needs-attention`; accept it as a possible result.

## Results

- **Released**: v1.12.3 (patch)
- **PRs merged**: 14 (#2514, #2515, #2516, #2517, #2518, #2521, #2523, #2524, #2525, #2526, #2528, #2530, #2531, #2532)
- **Issues closed**: 16 of 16 (14 PR-merged + 2 closed-as-already-fixed: #2455 by #2452, #2489 by #2484)
- **Issues dropped**: 0
- **New issues filed**: 8 (#2519 containment for non-Claude providers, #2520 ContainmentGuard fail-open for unknown tools, #2522 alias-bundle drift hazard inversion, #2527 pre-commit hook test-commit pollution, #2533 dotw-todo-stale-issue rule, #2534 string-literal-aware pattern matching, #2536 noGraph stub `as` cast → `satisfies`, plus a comment on #2210 for Bun crash telemetry)
- **Convergence-failure / simplify passes**: 2 (#2343 worktree-containment hit twice — round 1 missed NotebookEdit, round 2 missed MultiEdit + arg-form patterns; #2498 silent-catch hit once — round 1 fix exposed adjacent dead-catch sites). Both resolved by stepping back and writing a canonical helper + enumerating the full tool set, not by patching the flagged lines.
- **Sprint anchor**: #2495 diff-scope coverage ratchet landed first batch, eliminated the "shared gap fails my unrelated PR" failure mode that drove sprints 64–66's duplicate-issue storms.

## Context

Theme C chosen over the #2485 mail/issue funnel (deferred to a feature sprint) and an agent-session-reliability sprint (#2482 codex is routed around, not blocking). This is the first code-first **introspection** round since sprint-47 (sprint-57 was skipped); it produced #2495–#2498 (pulled in here) plus a tracking epic and a backlog of structural findings (StateDb/ws-server god-objects as epics, perf wins, the cadence-guard #11) for sprint 68. Meta-fix #2350 (fold harvest-rules → /rule-author) lands pre-sprint via PR #2494; the introspection.md/retro.md 57=skipped record update is a pending orchestrator meta-edit. Risk: 4 high-scrutiny issues (2 nerd-snipe gates) is a heavier-than-usual top end — the gates may consume slots and one could land in needs-attention.
