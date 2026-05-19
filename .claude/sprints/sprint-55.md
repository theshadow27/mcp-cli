# Sprint 55

> Planned 2026-05-18 08:30 local. Started 2026-05-18 09:34 local. Ended 2026-05-18 23:36 local (quota gate; full wall ~5h with mid-run OOM + recovery). Target: 17 issues / ~13 effective PRs (mail-wait + segfaults bundle). Actual: 9 merged + 3 already-fixed + 2 deferred to s56 + 1 excluded (no MRE).

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

- **#2074** — marked `needs-clarification`; user MRE never landed before Batch 2 start, per the special gate.
- **#2069** (dispatcher tests) — quota at 100% after recovery cascade; deferred to sprint 56. #2073's PR #2080 (refactor) merged with adequate test coverage from the refactor PR itself; #2069's separate test PR is incremental polish.
- **#2022** (merge module) — quota at 100% after recovery cascade; deferred to sprint 56. Plan/research from Iris's session preserved in transcript at `~/.claude/projects/<encoded>/b0d897fc-0355-4688-918d-914efc9b2b59.jsonl` — next sprint can fast-track via `mcx claude resume` since the worktree is intact.

## Crash recovery snapshot (2026-05-18 ~22:55 local)

**System OOM mid-sprint** — Ghostty reported 458 GB RAM use, all worker sessions disconnected. Sprint paused. State as of crash:

**Merged (5 PRs + 3 closed-as-already-fixed):**
- PR #2077 → #2072 (bun bump 1.3.14, also closed #2055 + #2068 as fixed-upstream after re-test loop)
- PR #2078 → #2051 (PTY test job)
- PR #2079 → #2063 (afterAll guards)
- PR #2081 → #2042 (mcx gc `+` prefix parse)
- (no PR) → #2067 (closed by worker: already shipped in PR #2064)

**Open PR (work survived on remote, repair in-flight when crash hit):**
- PR #2080 → #2073 (action executor refactor). Adversarial review found 1 blocker (`as "automation"` cast not in MONITOR_CATEGORIES) + 2 should-fix (rest-spread override, dead `escalate` case). Copilot inline flagged same blocker plus "satisfies never is compile-time only — need runtime throw in default". June (reviewer self-repair) had just been sent the repair instructions when crash hit. **No repair commits pushed.**

**Lost (worktree-only work, no remote push):**
- #2052 (Eve, ambient types waitForEvent) — small edit, full restart trivial
- #2060 (Frank, mail-wait cluster lead — bundles #2061/#2062) — significant work lost
- #2071 (Hank, site browser sleep)
- #2075 (Dave, manifest schema reload, unblocked from #2067 mid-sprint)
- #2069 (Carol, dispatcher tests — was blocked on #2073 landing first)
- #2022 (Iris, merge module — had presented plan, not yet implementing)
- #2058 (Kurt, flaky verification triage — just spawned)

**Likely contributor to OOM**: stale `mcx tracked` DB carried 40+ done items from old sprints. Cleanup deferred — file as a sprint-56 chore so it doesn't repeat.

## Post-recovery resolution (2026-05-18 ~23:35 local)

User suggested the **WIP-commit hack** to bypass `mcx claude resume`'s false-positive merge check (filed as #2082). All 8 dead workers' worktrees survived on disk — created a synthetic WIP commit on each branch (real files for 4 with uncommitted work, `--allow-empty` for 4 pristine), then `mcx claude resume <worktree>` restored conversation history for each.

**Recovered + landed (all 6 resumed sessions completed cleanly):**
- #2052 → PR #2085 merged (ambient types + waitForEvent stubs, plus #2088 filed for docs/phases template gap, plus #2089/#2090-ish followups for stub completeness)
- #2060 cluster → PR #2087 merged (mail-wait abort signal + ProtocolMismatch re-throw + NaN guard, closes #2061, #2062)
- #2071 → PR #2084 merged (site browser auto-restart, Copilot's docstring/lock-scope findings addressed inline)
- #2075 → PR #2086 merged (manifest schema version check; #2090 filed for 3 post-merge polish nits)
- #2073 → PR #2080 merged (final fix added runtime category guard + audited-action capture for errored audits; June's self-repair commit `0a8ccba` + Hank's QA-repair both landed)
- #2058 → closed by Frank's verification (5/5 bun-test runs clean under 1.3.14, 36,335 test executions, 0 failures)

**Quota gate hit immediately after #2080 merged**: 5-hour utilization 100%. #2069 and #2022 deferred to sprint 56 — see Excluded above for rationale and worktree-restart path.

## Sprint 55 final scorecard

**Merged**: 9 PRs (#2077 #2078 #2079 #2080 #2081 #2084 #2085 #2086 #2087) + 3 closed-as-already-fixed (#2055 #2058 #2067 #2068)
**Goal hit**: framework refactor #2073 + 2 modules-from-sprint-54 patched + bun bump + mail-wait cluster + manifest hardening — yes
**3rd consumer (#2022 merge module)**: deferred to sprint 56, plan + research intact in transcript
**Excluded**: #2074 (no MRE), #2069 + #2022 (quota)
**Issues filed during sprint**: #2082 (mcx claude resume merge-check false positive), #2088 (docs/phases template gap from #2052 OOS), #2090 (manifest version check polish nits)
**Outage**: 1× system OOM (Ghostty 458GB) mid-run; full recovery via user-suggested WIP-commit hack — became the load-bearing pattern for the second half of the sprint

## Results

- **Released**: v1.9.1 (patch — bug fixes + tests + CI improvements + automation framework polish)
- **PRs merged**: 9 (#2077 #2078 #2079 #2080 #2081 #2084 #2085 #2086 #2087)
- **Issues closed (by PR)**: 11 (#2042 #2051 #2052 #2060 #2061 #2062 #2063 #2071 #2072 #2073 #2075)
- **Issues closed without PR**: 4 (#2055 #2058 #2067 #2068 — all fixed upstream / already-shipped)
- **Issues dropped**: 3
  - #2074 (no MRE — `needs-clarification`)
  - #2069 (deferred to sprint 56 — quota cap after recovery)
  - #2022 (deferred to sprint 56 — quota cap; Iris's research worktree preserved for fast resume)
- **New issues filed during sprint**: 4
  - #2082 — `mcx claude resume` blocks recovery of branches with 0 commits ahead of main (load-bearing for crash recovery)
  - #2088 — docs/phases template gap from #2052 scope
  - #2090 — 3 post-merge polish nits on the manifest version check
  - #2091 — auto-prune stale `mcx tracked` entries (memory-bloat suspect contributor to the Ghostty OOM)

## Release Notes (v1.9.1)

### What's New
- **Automation framework** — `executeActionSideEffects` now exhaustively handles all 6 action types (`emit-event`, `shell`, `none`, `escalate`, `set-state`, `bye-and-untrack`) with a runtime category guard for `emit-event` and an `auditedAction` capture so errored audit events report the real action (#2080).
- **Site browser auto-restart** — `mcx site` Playwright sessions now detect a dead browser after system sleep and auto-restart with the prior engine/site context restored, eliminating "No credentials available" after brief sleeps (#2084).
- **Manifest schema version check** — `loadManifest` now validates schema version and throws an actionable `ManifestVersionError` with `bun run build && mcx phase install` guidance when a mid-sprint manifest change requires a daemon refresh (#2086).
- **PTY CI job** — new `pty-test` job runs historically PTY-sensitive specs under `unbuffer bun test` to catch TTY-vs-CI color skew regressions (#2078).

### Fixes
- `mcx gc` no longer fails on branches with `+` prefix (worktree-checkout marker from `git branch --merged`) (#2081).
- Mail-wait cluster: `pollMailUntil` now accepts an `AbortSignal` and both `claudeWait`/`agentWait` abort it on race resolution, narrowed catch to re-throw `ProtocolMismatchError`/unknown errors, and guards against `NaN` from malformed `createdAt` (#2087, closes #2060 #2061 #2062).
- `AliasContext` ambient type stubs now include `waitForEvent`, `EventFilterSpec`, and `MonitorEvent` so freeform aliases get IDE completion (#2085).
- `daemon-integration.spec.ts` afterAll hooks guarded with optional chaining to prevent test crashes when setup fails (#2079).

### Internal
- Bun engine floor bumped to `>=1.3.14`; fixes 3 segfault issues (#2055, #2068) and 1 flake cluster (#2058) upstream (#2077).

## Context

Sprint 54 shipped 15 PRs in 3h01m including the declarative automation framework (#2018) and two consumer modules (bind #2021, cleanup #2020). The framework gate fired during reviews of both modules: action types declared but never executed. Both reviewers self-repaired by inlining executors in the modules. Sprint 55 closes that gap (#2073) and adds the third consumer (#2022 merge module) to validate the refactor. Mail-wait cluster (#2060/61/62) surfaced during sprint 54 phase scripts. Bun segfaults (#2068, #2055) are likely upstream-fixed in 1.3.14 — we'll know after #2072 lands. Sprint started at 100% quota near reset; #2074 (--allow ignored) and #2075 (manifest schema reload) were filed as carry-forward findings from the sprint 54 wind-down notes.

**Pre-sprint dependency note**: PR #2037 (sha `9de3087`) landed at 14:18Z immediately before plan finalization — 1803 LOC adding `scripts/am-i-done.ts` step runner + `scripts/doing-it-wrong.ts` rule engine (currently one rule: `shell-injection`, enforced via pre-commit). Workers must know:
- `bun run doing-it-wrong` is a new pre-commit gate; rule failures need either fix or `// dotw-todo <rule-id>: <desc> — fix in #NNN` suppression linked to an issue.
- `scripts/check-shell-injection.ts` is now a thin shim around the rule engine — touch the rule under `scripts/rules/shell-injection.rule.ts`, not the legacy file.
- `.git-hooks/pre-commit`, `biome.json`, and `package.json` all changed in #2037 — any worker that opened a worktree from an older `main` base needs to rebase.
- #2072 (bun bump) edits `package.json` — sequence after picking up #2037's pre-commit script changes to avoid stale-rebase confusion.
