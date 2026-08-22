---
name: project-domain-scoped-mcx-3019
description: The #3019 domain-scoped mcx arc — ten sub-epics, dependency order, and how the multi-sprint program is being run
metadata:
  type: project
---

**#3019 — domain-scoped mcx, the agentic loop harness.** Started 2026-08-22. Roughly a
six-sprint arc; mcp-cli's largest single program to date.

Design is six docs on `main` (merged in #3020): `docs/domain-scoped-mcx.md`, `domains.md`,
`cards.md`, `sensors.md`, `trust.md`, `console.md`. Read them before touching anything in
the arc — the issue bodies restate the constraints, the docs carry the reasoning.

Ten sub-epics, all filed as tracked sub-issues of #3019 with `blocked_by` edges wired to
match the design's dependency table:

| | Epic | Issue | Depends on |
|---|---|---|---|
| A | Domains + clean-slate DB | #3021 | — |
| B | Domain servers | #3022 | A |
| C | Trust rings + console auth | #3023 | A, B |
| D | Cards | #3024 | A, C |
| E | Reducer + scheduler | #3025 | B, D |
| F | Sensors + snapshot store | #3026 | B, C |
| G | Email transport | #3027 | C, F |
| H | Console (mcpctl on the web) | #3028 | C, D |
| I | Spend + quota per domain | #3029 | A |
| J | Dogfood + bootstrap | #3030 | E, H |

**A blocks everything.** Sprint 78 = epic A (#3034–#3042) + the domain worker from B
(#3043–#3045). Then 79 = C+I, 80 = D + B tail, 81 = E+F, 82 = H+G, 83 = J.

**Scope (operator, 2026-08-22): shipping #3019 means getting the harness working *here* —
mcp-cli as domain #1, dogfooded.** Migrating phoenix/clrg/work (#3103) is explicitly OUT of
scope and unlinked from epic J; it stays filed for later.

The load-bearing idea, which applies to how the code is written and not just what it does:
**any invariant an orchestrator could rationalize past is a function, not prose.** Origin
is `nextAction()` in phoenix-octovalve's `scripts/sprint/select.ts`. Prefer a unit-tested
function or a `doing-it-wrong` rule over a sentence in a design doc.

**How the program is run**: a program-manager session decomposes each epic into issues and
plans the sprint, then spawns a *dedicated orchestrator per sprint* via `mcx claude spawn
--cwd .claude/worktrees/sprint-{N}` running `/sprint {N}`. The manager does not orchestrate
a sprint itself — that keeps each orchestrator's context bounded to one sprint and lets the
manager survive the whole arc. See [[feedback-context-rot]].

**Every orchestrator brief must forbid ending a turn on an intention to watch.** Sprint 78's
orchestrator ended a turn with "Letting the watch run" and sat stopped for 11 minutes with
five unattended workers — the same shape that cost sprint 77 nineteen days. A spawned
orchestrator does not inherit operator memory, so this has to be *in the brief*: block inside
the turn with `mcx claude wait --timeout 240000` in a wait → assess → act → wait loop; end a
turn only to ask for a decision, and say what is blocked. Tracked as a meta issue for run.md.

**Gate hold wording.** A gate hold must forbid `git commit` too — the pre-commit hook runs the
full static+test+coverage gate, so committing is as heavy as the thing being held. Correct
wording: *no `am-i-done`, no `bun test`, no `git push`, no `git commit`; stage with `git add` and
hold; reading, writing, reviewing and analysis continue.* Saying "commit locally is fine" makes
the hold self-contradictory.

**Shared box.** The operator runs a second project, phoenix, on this host — session
`phoenix-boss`, capped at 2 lanes. mcx-boss has CPU priority, but with 2 orchestrators and
~6 workers we are the noisy neighbour, not them. Reachable by `SendMessage` to
`phoenix-boss`. Load spikes to ~30+ on 12 cores are **our** concurrent `am-i-done` fork
storms (#2690), not saturation — instantaneous CPU stays ~80% idle. The tell is timing
tests failing: `findProcessesByCwd`, `reapWorktreeProcesses`, `handleWorkerCrash`,
`ServerPool rate limiting`. Never fix those with timeout bumps (that caused the 69/70
collapse, reverted in #2637); wait for load < 12 and retry, or stagger gate runs.

Two orchestrators in one repo is normal during a wind-down overlap; `mcx claude ls` shows
sessions across worktrees of the same repo, so **never `bye` a session you did not spawn**.
