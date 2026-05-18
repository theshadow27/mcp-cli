# Sprint 54

> Planned 2026-05-17 19:53 EST. Target: 15 PRs.

## Goal

**"Ship the automation-modules epic scaffold + first two modules so the
orchestrator stops being a polling event-loop. Clean up the
parallel-CI flake cluster (not just one symptom). Close sprint-53
fallout."**

Sprint 53 was 12 PRs in 72 minutes, but every minute of that wall-clock
was an orchestrator manually triaging events, flipping labels, rerunning
CI, byeing sessions. The Monitor stream surfaced the events but the
*loop* was still me. That's exactly what #2018 (automation modules)
attacks: declarative, event-triggered phase transitions defined in
`.mcx.yaml` instead of orchestrator prose. Ship the scaffold (#2018) +
the two simplest concrete modules (#2021 bind, #2020 cleanup), and a
substantial fraction of sprint-53's per-tick orchestrator work becomes
no-op'd by the framework. The compounding payoff lands sprint-55+.

Side quest: attack the parallel-CI flake **cluster** instead of one
symptom. #1980 ate 2 sprints. There are 3 more flakes on the board
(#2015, #2016, #1978) with the same "investigation needed, fix small"
shape. Nerd-snipe gate all three in one sprint, accept that one may
hit `needs-attention` (that's the gate working), and stop paying the
flake tax going forward.

## Issues

| #    | Title                                                                 | Scrutiny | Batch | Model  | Category                  |
|------|-----------------------------------------------------------------------|----------|-------|--------|---------------------------|
| 2018 | epic: automation modules — declarative, event-triggered framework     | high     | 1     | opus   | automation arc (epic)     |
| 2019 | feat(track): per-work-item custom metadata via manifest-declared schema | medium | 1   | opus   | automation arc (substrate)|
| 2021 | feat(automation): bind module — auto-attach PR + branch on push event | medium   | 2     | opus   | automation arc (proof)    |
| 2020 | feat(automation): cleanup module — auto-bye + untrack on verified merge | medium | 3   | opus   | automation arc (proof)    |
| 2015 | flaky(parallel): HTTP/SSE transport + 401 auth daemon-integration tests fail under --parallel | high | 1 | opus | flake cluster (nerd-snipe) |
| 2016 | flaky(test): colorState + MetricsPanel fail when stdout is a TTY      | low      | 1     | sonnet | flake cluster (quick)     |
| 1978 | flaky: AcpSession approve() waitForResult timeout in pre-commit hook  | high     | 2     | opus   | flake cluster (nerd-snipe)|
| 1224 | bug: pull.spec.ts fails in pre-commit hook due to core.hooksPath inherit | low    | 1     | sonnet | flake cluster (quick)     |
| 2014 | test: refactor daemon-integration.spec.ts to share daemons; drop from TIMING_EXCLUSIONS | medium | 2 | sonnet | flake hardening           |
| 2025 | bug(claude-ls): `mcx claude ls --all --short` hangs on empty result set | low    | 1     | sonnet | sprint-53 fallout (P1)    |
| 2040 | test: cover orphan-reaper + claude-server null-ownership paths (#1980) | low     | 2     | sonnet | sprint-53 fallout         |
| 2036 | build: platform npm packages include bin/.gitkeep in published tarballs | low    | 2     | sonnet | sprint-53 fallout         |
| 2017 | docs/phases.md: clarify that 'mcp-cli' is a virtual package           | low      | 3     | sonnet | docs / DX                 |
| 1605 | mcx claude wait: stable header line before JSON for truncation safety | low      | 3     | sonnet | DX (customer-requested)   |
| 1395 | refactor: deduplicate pollMailUntil/emitMailEvent between claude.ts and agent.ts | low | 3 | sonnet | hygiene                   |

15 work items. **4 high (opus)** — 1 epic, 1 substrate, 2 flake
nerd-snipes. **4 medium (opus or sonnet)** — 2 automation modules
(opus, the modules are the proof-of-design and adversarial review
needs to verify the framework's invariants), 1 daemon-test refactor,
1 substrate. **7 low (sonnet)**. Much heavier opus profile than
sprint 53, intentionally — the framework arc is where this sprint
earns its keep.

## Batch Plan

### Batch 1 (immediate — epic scaffold + flake gates + fallout P1)
#2018, #2019, #2015, #2016, #2025, #1224

### Batch 2 (the proof modules + fallout + #1978 gate)
#2021, #1978, #2014, #2040, #2036

### Batch 3 (second proof module + remaining DX)
#2020, #2017, #1605, #1395

### Cross-issue dependencies (addBlockedBy edges)

- **#2019 blockedBy #2018** — the manifest schema scaffold (#2018) defines
  the shape of per-work-item custom metadata; #2019 plugs into that
  shape. Land the framework first.
- **#2021 blockedBy #2018, blockedBy #2019** — the bind module declares
  its event subscription via the manifest schema. Needs both.
- **#2020 blockedBy #2021** — same framework shape, but ordered so the
  bind module's PR provides a concrete reference for the cleanup
  module's review. Reviewer can compare the second module against
  the first to verify the framework's invariants.
- **#1978 blockedBy nerd-snipe verdict** — gate per
  [`investigations.md`](../skills/sprint/references/investigations.md).
  If verdict is `needs-attention`, drop from sprint.
- **#2015 blockedBy nerd-snipe verdict** — same gate. May also benefit
  from #2014 landing first (shared-daemon refactor may reduce parallel
  contention), so #2014 is in Batch 2 ahead of #2015's impl, but
  #2015's nerd-snipe spawns in Batch 1 alongside #2018's design work
  (parallel investigation, no shared file).
- **#2014 implicit ordering wrt #2015** — if #2014 lands first AND the
  nerd-snipe says #2015's cause is per-test daemon load, #2015 impl
  may be trivial. Re-evaluate after #2014's QA pass.

5 explicit blockedBy edges (4 within the automation arc, 1 across
flakes), 2 nerd-snipe gates that may resolve to `needs-attention`.
This is the heaviest dependency graph this project has run; the
automation arc is the entire point.

### Flake nerd-snipe gate (per investigations.md)

**Two flake nerd-snipes this sprint**: #2015 and #1978. Sprint 53's
flake nerd-snipe (#1980) demonstrated the gate works: the diagnosis
was incomplete but the gate caught a concrete root cause + fix plan
before impl. QA then caught the gap. Accept that one of (#2015, #1978)
may hit `needs-attention` — that's the gate working, not the gate
failing. The cost of `needs-attention` is one sprint slot; the cost
of impl-on-hope is sprint 47's coverage-CI-retry mess that ate
months.

Spawn shape (binding): `mcx claude spawn --worktree --model opus -t
"You are nerd-snipe..."` — NOT the Agent tool. See #2009. Persona
must be inlined; `do NOT invoke the Agent tool yourself` must appear
verbatim in the prompt.

**Per-flake context to seed the spawn:**

- **#2015**: 22 daemon spawns, ~12s wall, tests P3b (HTTP) + P3c (SSE)
  flake under `bun test --parallel`. Investigation body suggests 3
  hypotheses (socket-readiness race, startTestDaemon polls, 401 test
  race). Nerd-snipe should pick the verifiable one + post bisect
  before any impl. May share root cause with #1980's PID-recycling
  pattern (concurrent `Bun.spawn` load contention).
- **#1978**: AcpSession `approve()` `waitForResult` times out after
  965s under pre-commit hook load. Could be test logic (infinite
  poll loop) or real daemon hang on resource pressure. Nerd-snipe
  must reproduce locally — sprint 53's lesson: "reproduce locally
  before claiming a fix."

### Hot-shared file watch

- `.mcx.yaml` and `.claude/phases/*.ts` — #2018, #2019, #2021, #2020
  all touch. **Serialized via the blockedBy edges above.** The four
  PRs land in a strict chain.
- `packages/daemon/src/site/...` — none picked this sprint.
- `test/daemon-integration.spec.ts` — #2014 only (impl); #2015's
  flake fix may also land here depending on nerd-snipe verdict.
  Watch for late conflict.
- `packages/command/src/commands/claude.ts` — #1605 (wait header)
  + #1395 (extract mail-wait helper). Disjoint regions. **Flagged,
  not serialized** — second to merge rebases trivially.
- `packages/daemon/src/work-items/` (or wherever the tracked-item
  state lives) — #2019 only this sprint. The substrate change.

### No #2042 / #2012 picks

- **#2042 (mcx gc parsing)** — Explore agent flagged root cause
  unclear; the parsing code in `getMergedBranches` looks correct.
  Defer until either the user repros or someone explicitly traces
  where the `+ ` prefix is fed back from.
- **#2012 (clock-inject StuckDetector)** — sub-500ms wall savings,
  19-test rewrite cost. Off the critical path. Defer indefinitely;
  pick up in a "test perf" sprint if one ever materializes.

## Context

**Sprint-53 outcome**: 12 PRs merged + 1 already-done (#1645),
v1.8.7 released. 47-sprint flake epic (#1980/#1987) finally closed.
Reviewer self-repair pattern (#1944) and nerd-snipe gate (#1980)
both proved their worth in production. User PR #2037 (am-i-done MVP)
is open mid-sprint; user is handling.

**Why the automation arc matters now**: sprint 53's orchestrator
loop made ~50 distinct `mcx phase run` calls, ~30 `gh pr view` /
`gh api` calls, ~15 label-flip operations, ~6 manual CI reruns. Each
was an orchestrator decision based on a Monitor event payload.
Roughly two-thirds of those decisions are formulaic — they're
exactly what an event-triggered framework executes deterministically:
"on `ci.finished` with `allGreen=true` and `state=CLEAN`: arm
auto-merge"; "on `pr.merged`: bye the impl session if alive". #2018
defines the manifest shape for these subscriptions, #2019 stores
the per-work-item state the modules read, #2021 and #2020 prove the
framework on the two simplest event types. Sprint-55's orchestrator
loop should drop ~40% of those tick operations.

**Why the flake-cluster vs one-flake-at-a-time**: sprint 53's
post-mortem showed #1980's nerd-snipe took two passes because the
diagnosis was partial. The fix is good but the *process* was
expensive. Batching three flake nerd-snipes (one of which may
already be straight-forward post-#2014) amortizes the per-flake
context-load cost across the sprint. Two of the three may need
multiple rounds; that's fine, the cluster is a cooldown bet that
pays out for the test suite as a whole.

**Plan-time triage** (verify-still-open, with just-in-time recheck
because sprint 53's plan-time triage missed two already-done picks
that merged ~12h before sprint start):
- All 15 picks verified open at plan time (2026-05-17 19:53 EST).
- #2018, #2019, #2020, #2021, #2022, #2023 reviewed together;
  #2022 (auto-merge module) deferred to sprint 55 to keep the arc
  scope to "framework + 2 modules proving 2 event types"; #2023
  (`ctx.gh` first-class) is a separate concern (extending the
  alias API, not the work-item lifecycle), deferred.
- #2025: re-confirmed P1 — running the command verbatim hangs.
  Isolated to non-JSON `--all --short` formatter.
- #1928 (closed at plan time as already-done — fixed in PR #1918).
- #1686 (closed at plan time as dup of #1673).
- #1673 dropped from this sprint as Bun.sleep lint addition — pure
  tooling improvement, no urgency, defer to a cleanup sprint.

**Plan-time meta-fixes**: None this sprint. No `label:meta` issues
open.

**Risks**:
- **#2018 scope blow-up**: epic-labeled, framework-shaped. Risk is
  the impl session designs too much in one PR. Adversarial review
  must enforce: only the schema + module loader + event dispatch.
  No actual module logic in #2018's PR — that's what #2021 and #2020
  prove. If the impl session bundles a module into #2018's PR, send
  back to repair to extract it.
- **#2021 / #2020 reviewer comparison**: the second module's reviewer
  should explicitly diff against the first to verify the framework
  abstractions hold up. If the second module needs to break the
  framework's invariants to work, that's a #2018 redesign — surface
  to retro, don't paper over.
- **Flake nerd-snipe `needs-attention` budget**: budget for 1 of 2
  nerd-snipes to hit the hard-fail outcome. If both hit
  `needs-attention`, treat that as a signal that the flake-cluster
  approach isn't reproducible enough yet; split each into its own
  sprint with a user-led pre-investigation.
- **Opus quota**: 4 opus picks this sprint vs sprint 53's 2 opus.
  Watch the 5-hour quota during the framework batch; if utilization
  trends toward 80% mid-sprint, finish-in-flight on the modules
  before spawning #1978's nerd-snipe.
- **#1605 vs #1486 epic**: same caveat as sprint 53 — keep #1605's
  scope to the wait command's output formatter. Don't bundle in
  monitor-epic refactoring.

**Releasability**: bug fixes + framework feature + flake fixes +
test back-fills. If the automation framework lands cleanly, this is
a **minor** bump (v1.9.0) — `.mcx.yaml` gets a new top-level
section (`automation:`/`modules:`), which arguably qualifies as a
new public surface. If the framework slips and only fallout +
flakes land, patch (v1.8.8). Defer the call to retro.

## Process notes (carry-forward from sprint 53)

1. **Capture phase JSON once, extract both fields** (still applies).
2. **Verify cwd before every compound `git commit` shell command** —
   sprint 53's direct-to-main accident. `pwd` first. Use absolute paths.
3. **`mcx claude bye` returns multi-line JSON** — parse with
   `jq -r '...'`, not `tail -1`.
4. **Flip `qa:fail` → `qa:pass` label** when the QA verdict
   explicitly diagnoses the failure as a known flake AND CI rerun
   is green.
5. **Reviewer self-repair beats fresh opus repair** when findings
   are contained + diagnosed. Saved one opus spawn on #1944 in
   sprint 53.
6. **Nerd-snipe spawn shape** is `mcx claude spawn --worktree
   --model opus -t "..."`, NOT the Agent tool. Persona inlined.
   See `investigations.md`.
7. **Sprint-53 lesson — nerd-snipe must reproduce locally** before
   posting a fix plan. The CI-log-only bisect on #1980 was partially
   wrong because it never ran the failing test under load.
8. **Verify auto-merge with `state == MERGED && mergedAt != null`**.
9. **One TaskCreate per issue** with addBlockedBy edges from the
   dependency list. **(5 edges this sprint — the heaviest yet.)**
10. **No `Bun.sleep` in test fixes**.
11. **Use the `Monitor` harness tool, not raw Bash `mcx monitor`**.
12. **Plan-time triage step** caught 1 already-done (#1928) + 1 dup
    (#1686) at sprint-54 plan time. The discipline is working.
