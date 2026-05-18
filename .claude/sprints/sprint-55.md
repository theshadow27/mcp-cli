# Sprint 55

> Planned 2026-05-18 08:30 local. Target: 17 issues / ~13 effective PRs (mail-wait + segfaults bundle).

## Goal

Land the sprint-54 fallout cluster: bun-floor bump, manifest hardening, mail-wait error handling, and the automation framework refactor that makes the merge module declarative.

## Issues

| # | Title | Scrutiny | Batch | Model | Category |
|---|-------|----------|-------|-------|----------|
| 2072 | chore: bump engines.bun to 1.3.14 (was >=1.2.18) | low | 1 | sonnet | goal-quick |
| 2042 | bug(mcx gc): branch deletion fails on `+` prefix parse artifact | low | 1 | sonnet | filler |
| 2063 | test(daemon-integration): guard afterAll hooks with optional chaining | low | 1 | sonnet | filler |
| 2067 | fix(manifest): reject repeatable:true on non-string state field types | low | 1 | sonnet | goal-quick |
| 2052 | docs/types: ambient mcp-cli.d.ts missing waitForEvent on AliasContext | low | 1 | sonnet | filler |
| 2069 | automation-dispatcher.spec.ts: cover emit-event + shell variants | low | 2 | sonnet | goal-quick |
| 2060 | bug(mail-wait): orphaned pollMailUntil promise burns IPC after race | medium | 1 | sonnet | goal (cluster lead) |
| 2061 | bug(mail-wait): catch{} swallows ProtocolMismatchError + TypeError | medium | 1 | sonnet | goal (bundled) |
| 2062 | bug(mail-wait): NaN from malformed createdAt silently drops mail | medium | 1 | sonnet | goal (bundled) |
| 2075 | bug(daemon): mid-sprint manifest schema changes require manual restart | medium | 2 | sonnet | goal |
| 2051 | ci: add PTY test job to catch TTY-vs-CI color skew bugs | low | 2 | sonnet | filler |
| 2071 | site browser session dies on system sleep, even brief | medium | 2 | sonnet | filler |
| 2074 | bug(spawn): per-action tool permission prompts despite --allow | medium | 2 | sonnet | goal (user MRE pending) |
| 2073 | feat(automation): backfill action executors (refactor — option A) | high | 1 | opus | goal-heavy |
| 2022 | feat(automation): merge module — auto-merge when preconditions met | high | 3 | opus | goal-heavy |
| 2068 | bug: Bun segfault in claude-server.spec.ts during parallel test run | high (gated) | 3 | opus | filler-heavy |
| 2055 | bun segfault when running orphan-reaper.spec.ts + claude-server.spec.ts | high (gated) | 3 | opus | filler-heavy (bundled w/ #2068) |
| 2058 | flaky: 3 tests failed in 1/3 runs during QA of PR #2050 (unidentified) | high (gated) | 3 | opus | filler-heavy |

## Dependency edges (translate to `addBlockedBy` at run time)

- #2068 blockedBy #2072 (re-test under 1.3.14 — close if clean, nerd-snipe gate only if still crashing)
- #2055 blockedBy #2072 (same — bundle investigation into #2068's PR if both still crash)
- #2058 blockedBy #2072 (bun bump may resolve underlying instability; identify failing specs only after 1.3.14)
- #2075 blockedBy #2067 (both touch `packages/core/src/manifest.ts` — sequence to avoid logical conflict)
- #2069 blockedBy #2073 (dispatcher tests must match the refactored dispatcher shape)
- #2022 blockedBy #2073 (merge module is the 3rd-module data point validating the refactor)
- #2061 blockedBy #2060 (same PR — `pollMailUntil` in `packages/command/src/commands/mail-wait.ts`)
- #2062 blockedBy #2060 (same PR — same file)

## Batch Plan

### Batch 1 (immediate — no deps, longest-pole work starts now)
#2072 (bun bump), #2042 (mcx gc), #2063 (afterAll guards), #2067 (manifest repeatable), #2052 (ambient types), #2060 (mail-wait cluster lead), #2073 (action executor refactor — heavy, start early)

### Batch 2 (backfill — partial deps)
#2069 (after #2073), #2071 (site browser sleep), #2074 (--allow permissions), #2075 (after #2067), #2051 (PTY test job)

### Batch 3 (backfill — gated on Batch 1 results)
#2022 (merge module — after #2073 lands), #2068 + #2055 (bun segfault re-test — after #2072), #2058 (flaky identification — after #2072)

## Hot-shared file watch

- `packages/core/src/manifest.ts` — #2067 lands first, #2075 rebases on top. Orchestrator must broadcast targeted rebase on #2075 worker when #2067 merges.
- `packages/command/src/commands/mail-wait.ts` — single PR (#2060) closes all three (#2060/61/62); workers spawned only on #2060.
- `packages/daemon/src/automation-dispatcher.ts` — #2073 refactors; #2069 (tests) and #2022 (merge module) build on it. Strict serial order.

## Special gates

- **#2073 decision-gate (resolved at plan time)**: User chose option A — framework owns dispatch. Worker prompt must reference this and pull `executeActionSideEffects` out of #2020/#2021 modules into the dispatcher.
- **Bun segfault re-test (#2068 + #2055)**: After #2072 lands, run `for i in $(seq 1 10); do bun test; done`. If 0 segfaults: close both as "fixed upstream in 1.3.14." If still crashing: nerd-snipe gate per `references/investigations.md` (spawn shape: `mcx claude spawn` NOT Agent tool — #2009).
- **Flaky #2058 identification**: After #2072, same loop. Identify failing spec file(s) before assigning fix work.
- **#2074 MRE**: User provides tight repro on issue body before spawning the impl session. Mark `needs-clarification` if no MRE by Batch 2 start.
- **#2022 risk gate**: Late-Copilot regression test required (label passed → new unresolved thread arrives → merge must be blocked). Reviewer must verify this scenario is covered.

## Excluded (with reason)

None at plan time — board was triaged into Sprint 55 picks above, deferrals into sprint 56, or already-closed.

## Context

Sprint 54 shipped 15 PRs in 3h01m including the declarative automation framework (#2018) and two consumer modules (bind #2021, cleanup #2020). The framework gate fired during reviews of both modules: action types declared but never executed. Both reviewers self-repaired by inlining executors in the modules. Sprint 55 closes that gap (#2073) and adds the third consumer (#2022 merge module) to validate the refactor. Mail-wait cluster (#2060/61/62) surfaced during sprint 54 phase scripts. Bun segfaults (#2068, #2055) are likely upstream-fixed in 1.3.14 — we'll know after #2072 lands. Sprint started at 100% quota near reset; #2074 (--allow ignored) and #2075 (manifest schema reload) were filed as carry-forward findings from the sprint 54 wind-down notes.

**Pre-sprint dependency note**: PR #2037 (sha `9de3087`) landed at 14:18Z immediately before plan finalization — 1803 LOC adding `scripts/am-i-done.ts` step runner + `scripts/doing-it-wrong.ts` rule engine (currently one rule: `shell-injection`, enforced via pre-commit). Workers must know:
- `bun run doing-it-wrong` is a new pre-commit gate; rule failures need either fix or `// dotw-todo <rule-id>: <desc> — fix in #NNN` suppression linked to an issue.
- `scripts/check-shell-injection.ts` is now a thin shim around the rule engine — touch the rule under `scripts/rules/shell-injection.rule.ts`, not the legacy file.
- `.git-hooks/pre-commit`, `biome.json`, and `package.json` all changed in #2037 — any worker that opened a worktree from an older `main` base needs to rebase.
- #2072 (bun bump) edits `package.json` — sequence after picking up #2037's pre-commit script changes to avoid stale-rebase confusion.
