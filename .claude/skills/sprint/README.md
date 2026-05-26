# Sprint Skill

Autonomous sprint orchestrator for Claude Code. Plans, executes, reviews, and retros a batch of GitHub issues without human intervention — driven by a declarative phase manifest and a push-shaped event stream from the daemon.

## What it does

`/sprint` turns a backlog of GitHub issues into merged PRs. One Claude session acts as the orchestrator, spawning and managing parallel worker sessions through the full lifecycle:

```
/sprint plan    → survey board, pick ~15 issues, write sprint file
/sprint         → run the pipeline (auto-chains review + retro inline)
/sprint run     → run-only (stop at wind-down, no review/retro)
/sprint review  → cut a versioned release from what shipped
/sprint retro   → write a diary entry capturing learnings
```

Routing details live in [`SKILL.md`](SKILL.md). Per-phase command sequences live in `references/{plan,run,review,retro}.md`.

## How it works

The orchestrator never writes code directly. It delegates everything to spawned Claude / agent sessions via `mcx claude spawn` (or `mcx agent <provider> spawn`), and **reacts** to a unified event stream from the daemon instead of polling.

### Phase manifest, not hardcoded steps

The pipeline graph is declared in [`.mcx.yaml`](../../../.mcx.yaml) at the repo root. Per-phase logic lives in [`.claude/phases/*.ts`](../../phases/) as `defineAlias` scripts that the daemon executes with a live `ctx` (state DB, MCP proxy, work-item info). The orchestrator never hardcodes "impl → triage → review → QA" — it ticks phases:

```bash
mcx phase list                       # overview + install status
mcx phase show <phase>               # resolved source, schema, next
mcx phase run <phase> --work-item <id>   # returns { action: "spawn" | "wait" | "goto" | "in-flight", ... }
mcx phase advance --work-item <id>   # run current phase, follow goto chain, stop at first wait
mcx phase install                    # hash sources, write .mcx.lock (run after editing phase scripts)
```

The current sprint graph: `impl → triage → review | qa → repair → review | qa | needs-attention → done`. Round caps: review ≤ 2, repair ≤ 3, qa:fail ≤ 2. Hitting a cap routes the item to `needs-attention`.

### Event-driven orchestration (not polling)

The orchestrator opens **one** event stream at sprint start via the Claude Code `Monitor` tool:

```bash
mcx monitor --subscribe session,work_item --json 2>&1 \
  | grep -E --line-buffered '"event":"(session\.idle|session\.result|session\.permission_request|session\.stuck|ci\.finished|pr\.merge_state_changed|pr\.review_comment_posted|work_item\.phase_changed|cost\.|quota\.|daemon\.restarted|worker\.ratelimited)"'
```

Each ndjson line arrives as an in-conversation notification. The orchestrator reacts when an event fires — no polling, no cache miss between ticks.

Event payloads are pre-enriched by the producers (`cost`, `turns`, `lastTool`, `resultPreview`, `cascadeHead`, `allGreen`, per-check conclusions, etc.) so a tick rarely needs a follow-up `mcx claude log` or `gh pr view`. Acting on a `mcx claude wait` line would force a 5-lookup hydration loop per event; the monitor stream collapses that to ~1 lookup (the action).

Event types the orchestrator handles:

| Event type | Meaning |
|------------|---------|
| `session.idle` / `session.result` | Worker idle — tick the bound work item via `mcx phase run` |
| `session.permission_request` | Approval needed — `mcx claude log` then `mcx claude send` |
| `session.stuck` | Heuristic stall — interrupt + send guidance |
| `ci.started` / `ci.running` / `ci.finished` | CI outcome — `allGreen` advances; otherwise repair/needs-attention |
| `pr.merge_state_changed` | If `cascadeHead`, advance the merge queue |
| `pr.review_comment_posted` | Possibly substantive — file followup if so |
| `work_item.phase_changed` | Phase script just updated state — observe |
| `cost.*` / `quota.utilization_threshold` | Apply quota gating (see `references/run.md`) |
| `daemon.restarted` / `worker.ratelimited` | Diagnostic — log + continue |

### Work items as state

Every tracked issue is a row in the daemon's `work_items` table — phase, branch, PR number, scrutiny, session bindings, repair/review round counters, all visible to phase scripts via `ctx.workItem` and `ctx.state`:

```bash
mcx track <n>                     # create work item in initial phase (impl)
mcx tracked --json                # current state of every tracked item
mcx tracked --phase repair        # filter by phase
mcx untrack <n>                   # remove from tracking
```

Phase scripts update state via `_work_items.work_items_update`; the event bus emits `work_item.phase_changed` on every transition.

### Concurrency model

- 5 opus implementation slots run in parallel
- Unlimited sonnet review/QA slots
- One `TaskCreate` per tracked issue (not per batch), with `addBlockedBy` edges for hot-shared-file serialization
- The Monitor stream — not `sleep`, not `mcx claude wait` — is the wait primitive

### Worktree isolation

Each issue gets its own git worktree under `.claude/worktrees/`. All phases (impl, review, repair, QA) reuse the same worktree via `--cwd`, so branches don't collide and the user's main checkout is never touched.

Sprint-meta commits (plan, mid-sprint amendments, results, retro diary, release commit) accumulate on a single long-lived `sprint-{N}` branch in `.claude/worktrees/sprint-{N}/`. A single auto-merge PR is opened at plan time (as draft) and converted to ready at retro — one watchable PR per sprint, never pushing directly to main.

## Sprint planning

`/sprint plan` surveys open issues, groups them into thematic arcs, and writes a sprint file to `.claude/sprints/sprint-N.md`. Issues are classified by scrutiny level:

| Scrutiny | Review depth | Typical mix |
|----------|-------------|-------------|
| Low      | QA only     | ~60%        |
| Medium   | QA only     | ~25%        |
| High     | Adversarial review + QA | ~15% |

Issues are batched (3 batches of 5) to avoid file conflicts between concurrent sessions. Triage is automated by `.claude/phases/triage.ts`; high scrutiny is triggered by ~120+ lines of src churn, 100+ src additions, 2+ risk areas touched, or 4+ source files across 2+ packages.

## Key rules

- **Never implement directly** — always delegate to spawned sessions
- **Spawn fresh sessions per phase** — don't reuse across impl/review/QA
- **File every problem as an issue** — unfiled problems are invisible
- **Use the Monitor stream, not `sleep` or `mcx claude wait` polling** — event-driven, push-shaped, pre-enriched payloads
- **Verify auto-merge actually fired** — `state == MERGED && mergedAt != null`, not just "queued"
- **Meta-files are orchestrator-only** during a sprint (`.claude/skills/**`, `.claude/phases/**`, `.mcx.yaml`, `CLAUDE.md`, `.gitignore`) — workers must not touch them; changes go through retro + next-plan
- **All PRs target `main`** — no feature branches

## Sprint artifacts

```
.claude/sprints/sprint-N.md       # plan + start/end timestamps + results
.claude/sprints/.active           # sentinel — blocks commits on main during sprint
.claude/diary/yyyyMMdd.N.md       # retrospective
.claude/worktrees/sprint-N/       # sprint-meta branch (one auto-merge PR per sprint)
```

## Dependencies

- `mcx` CLI (this repo) for session management, monitor stream, phase engine
- `mcpd` daemon running for IPC, event bus, work-item state
- `gh` CLI for GitHub operations
- Git worktree support
- `.mcx.yaml` + `.claude/phases/*.ts` defining the phase graph

Supported agent harnesses for workers (via `provider` column or `mcx <provider> spawn`):
`claude` (primary), `copilot`, `gemini`, `grok` (via native ACP `grok agent stdio`), generic `acp:*`, plus Codex/OpenCode where installed.

## Related skills

- `/implement` — single-issue implementation (called by sprint workers)
- `/qa` — verification and merge (called by sprint workers)
- `/adversarial-review` — multi-agent PR review
- `/board-overview` — board survey without planning
- `/release` — standalone release cutting
- `/diary` — backfill diary entries from session transcripts
- `/flaky-tests` — mine session transcripts for test failures across sessions
