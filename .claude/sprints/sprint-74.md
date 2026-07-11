# Sprint 74

> Planned 2026-07-01. Started 2026-07-01 19:25 EDT. Ended 2026-07-02 09:57 EDT. Target: 15 PRs — delivered 16 merged PRs (15 planned-issue PRs incl. #2744 closed-as-fixed without a PR, + 2 amendment P1s #2821/#2825).

## Goal

Drain the sprint-73 fallout: restore trust in the gate (build-smoke accuracy, durable compiled-worker resolution, coverage integrity), clean up stdio/session hygiene, and fix the phase-machinery bugs that bit the pipeline itself.

## Issues

| # | Title | Scrutiny | Batch | Model | Provider | Category |
|---|-------|----------|-------|-------|----------|----------|
| 2800 | build smoke failurePattern over-matches non-worker servers | low | 1 | opus | claude | goal |
| 2761 | extend gate lease to pre-push TEST_CHANGED step | low | 1 | sonnet | claude | goal |
| 2793 | stdio write failure leaves live child after disconnectSession | low | 1 | opus | claude | goal |
| 2781 | repair→qa blocked by hardcoded VALID_TRANSITIONS when repoRoot missing | low-medium | 1 | opus | claude | goal |
| 2735 | parseModelFromSprintTable misses secondary issue in paired-# rows | low | 1 | sonnet | claude | filler |
| 2801 | resolve compiled workers via embedded manifest (ends #2721→#2762→#2796 class; should also close #2798) | medium | 2 | opus | claude | goal |
| 2760 | harden gate-lease: fail-open on fs errors + validate env tuning | low | 2 | opus | claude | goal |
| 2771 | test:hooks runner for .git-hooks/*.spec.ts, wired into am-i-done + CI | low | 2 | opus | claude | goal |
| 2797 | smoke-test.ts: isolate under tmp MCP_CLI_DIR + wire into CI | low-medium | 2 | opus | claude | goal |
| 2802 | mcx memory audit: truncation/exit-0 guard (re-verify --json half first — likely already fixed) | low-medium | 2 | opus | claude | filler |
| 2724 | delete superseded test/review-phase.spec.ts + test/qa-phase.spec.ts | low | 3 | sonnet | claude | filler |
| 2785 | spec-git-env-spread: extend AST to node-form spawnSync + template-literal git | low | 3 | opus | claude | filler |
| 2660 | promptedDirs in config.json grows unbounded — GC dead worktree paths | low | 3 | opus | claude | filler |
| 2804 | mechanize sprint-73 meta rules into phase scripts | high | 3 | opus | claude | goal |
| 2744 | coverage integrity: local-fail/CI-green spec-count divergence (nerd-snipe gate BEFORE impl) | high | 3 | opus | claude | goal |

## Batch Plan

### Batch 1 (immediate)
#2800, #2761, #2793, #2781, #2735

### Batch 2 (backfill)
#2801, #2760, #2771, #2797, #2802

### Batch 3 (backfill)
#2724, #2785, #2660, #2804, #2744

### blockedBy edges
- #2801 blockedBy #2800 (both edit scripts/build.ts — narrow the smoke pattern first, then the manifest rework rebases on it)
- #2760 blockedBy #2761 (both edit scripts/_runner/gate-lease.ts)
- #2771 blockedBy #2761 (both touch am-i-done.ts step wiring)
- #2804 blockedBy #2724 (delete the superseded phase specs before mechanization edits the co-located .claude/phases/*-fn.spec.ts surface)

### Amendments (mid-sprint)

- **#2821** (added 2026-07-01 19:50 EDT): compiled `mcpd` cannot import `./alias-executor.ts` via argv-redispatch (`WORKER_ENTRIES` in `packages/daemon/src/main.ts` predicts a literal embed path) + masking bug (`mcx call _aliases` prints the error to stdout and exits 0). Found by #2797's isolated smoke test; reproduces on clean main. P1. **blockedBy #2801/PR #2822 merge** — the fix must route the argv dispatch through the new layout-tolerant resolver in `worker-path.ts` rather than re-predicting a path. Predicted files: `packages/daemon/src/main.ts`, alias-call error path; no overlap with other in-flight issues. #2797 lands without its CI-wiring step; that step becomes a follow-up after #2821.

- **#2825** (added 2026-07-01 ~19:57 EDT, ESCALATED → **needs-attention** 2026-07-01 21:50 EDT): stdio load/drain test regression, first failure at the #2793/PR #2814 merge. Investigation confirmed + deterministically reproduced a result-line drop mechanism; repair PR #2830 fixes it (review:pass, QA revert-check proved causal necessity) — but #2830's own CI failed the same 12s timeout on the fixed tree (run 28556322363), so a second mechanism (drain throughput under runner contention) is suspected. Halted per one-repair escalation rule; timeline + options on the issue. **Held PRs pending human decision: #2818 (#2771), #2820 (#2785), #2823 (#2660), #2831 (#2821), #2830 itself.**
  - **Round-2 resolution (2026-07-02 ~08:45 EDT):** human was away (AskUserQuestion timed out); default = second investigation. It REFUTED the throughput hypothesis with measurements (drain ≤365ms at load 340) and causally proved a second trigger: the load test's bare-`cat` fixture exits without reading stdin → EPIPE on the daemon's prompt write → failSend disconnect → same #2814 guard drop (A/B: 8/10 vs 0/10 stalls). Test-double defect, no production analog. Resumed from needs-attention: fixture fix (stdin-faithful child, budgets unchanged) lands on PR #2830; guard-narrowing defense-in-depth filed separately. #2830 + fixture = expected deterministic green, then held PRs rerun.

### Hot-shared file watch
- `scripts/build.ts`: #2800 → #2801 (serialized above)
- `scripts/_runner/gate-lease.ts` + `am-i-done.ts`: #2761 → #2760, #2771 (serialized above)
- `.claude/phases/**`: #2724 → #2804 (serialized above)
- `.github/workflows/*`: #2797 and #2771 both add CI wiring — soft overlap; whichever merges second must rebase and check for duplicate job/step entries
- `scripts/_runner/ci-steps.ts` + `scripts/check-coverage.ts`: #2744 is the ONLY in-sprint issue on these files by design. Deferred siblings #2788/#2759 must NOT be amended in without re-running the overlap check (see plan.md amendment gate, #2768).

## Special handling

- **#2744 — mandatory nerd-snipe investigation gate before impl** (references/investigations.md). The issue comment inverts the filed story: the local coverage failure is *correct*; CI green is a false-pass from a ci-steps.ts regex false-positive (ties to #2788). The gate must establish the real mechanism first; hard-fail outcome `needs-attention` is acceptable.
- **#2804 — high scrutiny**: mechanizes #2803's prose rules (artifact-check, dual-label closure gate, verify-hypothesis injection) into `.claude/phases/*.ts` + `.mcx.yaml`. Phase-script changes require `mcx phase install` after merge; orchestrator should reload phases before dispatching post-merge work.
- **#2801 — should also close #2798** (upstream bun count-dependent outbase) if the embedded manifest removes entrypoint-count dependence; note in PR body. Listed as a single row (not paired-#) because #2735 — the paired-row parser fix — hasn't merged yet.
- **#2802 — scoped**: recon found `--json` appears already honored (memory.ts:248); worker must re-verify on current main first and scope to the silent-truncation/exit-0 completeness guard if so.

## Excluded

- #2805 (stdio containment parity): #2688 investigation returned NO-GO; fail-closed refuse merged in #2789. Needs a product decision, not a worker slot.
- #2788, #2759 (coverage siblings): follow #2744's gate outcome; same hot files.
- #2783, #2770 (flakies): likely relieved by gate-lease work (#2761/#2760); re-check after those merge before paying nerd-snipe slots.
- #2736 (phases→tsc): fallout-prone; schedule after #2804 lands.
- #2727: recon indicates the named specs are already clean — needs close-as-done re-verify.
- #2752: root cause corrected in comments to missing GH_TOKEN in workflow yml; rescope before scheduling.
- #2733/#2734 (closure-hash): Windows-priority question outstanding.
- Alternates on deck: #2795, #2742, #2786, #2662.

## Context

First sprint after a ~19-day pause (sprint 73 ended 2026-06-12). Sprint 73 shipped the stdio transport arc and exposed the build/coverage gate weaknesses this sprint targets. Meta-fix #2768 (amendment hot-file re-check) applied pre-sprint in PR #2809. Codex provider remains broken (#2482) — all sessions route to claude. Sprint 74 does not end in 7 — no introspection round.

## Results

- **Released**: v1.14.4 (tag at retro, post sprint-PR merge)
- **PRs merged**: 16 — #2810, #2811, #2812, #2813, #2814, #2816, #2817, #2818, #2819, #2820, #2822, #2823, #2824, #2826, #2830, #2831
- **Issues closed**: 17 — all 15 planned (incl. #2744 closed as already-fixed-by-#2748 after empirical verification, no PR needed) + 2 mid-sprint P1 amendments (#2821 compiled alias-dispatch, #2825 stdio drain regression)
- **Issues dropped**: 0
- **New issues filed**: 9 — #2815 (spec-count sanity enhancement), #2821 + #2825 (amendments, both fixed in-sprint), #2832 (double-Error prefix), #2834/#2835 (alias-dispatch follow-ups), #2836 (bye --cwd worktree removal), #2837 (monitor stale-event replay), #2838 (#2814 guard narrowing — defense-in-depth for the #2825 class); plus data-point comments on #2737 (×2), #2798, #2833
- **External contribution handled**: PR #2807 (promptedDirs GC) closed in favor of #2823 with architectural rationale (write-site vs read-side-effect pruning)
- **Escalations**: #2825 ran the full discipline — 2 unframed investigations (round 1: exit-vs-drain race; round 2: refuted throughput hypothesis with measurements, proved fixture EPIPE trigger via A/B), 1 needs-attention halt at the one-repair cap, resumed on complete causal proof; #2804 survived a wrong QA verdict (verifier's tool hit #2737 and validated the base tree) — override with independent verification + CI-as-arbiter

## Post-sprint correction (2026-07-11)

The Results section above overstated closure: **#2797 was only half-delivered at sprint end.** PR #2824 landed its isolation half (points 1–2), but the CI-wiring step (point 3) was deferred behind #2821 — which merged in the sprint's final minutes — and was never revisited; the issue sat open, uncommented, for 9 days. Closed 2026-07-11 via recovery PR #2842 (smoke-test wired into the build job post-compile). The recovery pass also closed missed external PR #2808 (superseded by #2819, rationale + credit posted) and filed #2841 (opts.slots validation gap #2808 caught that #2819 missed), #2843 (stale #1004 pass-by-policy crash wrappers still in ci.yml).
