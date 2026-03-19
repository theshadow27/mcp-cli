# Sprint Skill

Autonomous sprint orchestrator for Claude Code. Plans, executes, reviews, and retros a batch of GitHub issues without human intervention.

## What it does

`/sprint` turns a backlog of GitHub issues into merged PRs. One Claude session acts as the orchestrator, spawning and managing parallel worker sessions through the full lifecycle:

```
/sprint plan    → survey board, pick ~15 issues, write sprint file
/sprint         → run the pipeline (implement → triage → review → QA)
/sprint review  → cut a versioned release from what shipped
/sprint retro   → write a diary entry capturing learnings
```

## How it works

The orchestrator never writes code directly. It delegates everything to spawned Claude Code sessions via `mcx claude spawn`, managing them through a Unix socket IPC protocol.

### Pipeline per issue

```
1. Implement    opus session in a git worktree, runs /implement skill
2. Triage       automated diff analysis to determine review depth
3. Review       sonnet adversarial review (high scrutiny only)
4. Repair       opus session to fix review findings (if any)
5. QA           sonnet session runs /qa skill, merges if passing
```

### Concurrency model

- 5 opus implementation slots run in parallel
- Unlimited sonnet review/QA slots
- `mcx claude wait --timeout 30000` blocks until a session completes (event-driven, not polling)
- As slots free up, the next issue from the backlog is spawned

### Worktree isolation

Each issue gets its own git worktree. All phases (implement, review, repair, QA) reuse the same worktree via `--cwd`, so branches don't collide and the user's working tree is never touched.

## Sprint planning

`/sprint plan` surveys open issues, groups them into thematic arcs, and writes a sprint file to `.claude/sprints/sprint-N.md`. Issues are classified by scrutiny level:

| Scrutiny | Review depth | Typical mix |
|----------|-------------|-------------|
| Low      | QA only     | ~60%        |
| Medium   | QA only     | ~25%        |
| High     | Adversarial review + QA | ~15% |

Issues are batched (3 batches of 5) to avoid file conflicts between concurrent sessions.

## Triage

After implementation, an automated triage script analyzes the diff:

```bash
bun .claude/skills/estimate/triage.ts --base main --json
```

High scrutiny is triggered by: 120+ lines of src churn, 100+ src additions, 2+ risk areas touched, or 4+ source files across 2+ packages.

## Key rules

- **Never implement directly** — always delegate to spawned sessions
- **Spawn fresh sessions per phase** — don't reuse across implement/review/QA
- **File every problem as an issue** — unfiled problems are invisible
- **Use `mcx claude wait`, not `sleep`** — wait is event-driven and interruptible
- **All PRs target `main`** — no feature branches (learned the hard way)

## Sprint artifacts

```
.claude/sprints/sprint-N.md    # plan + results
.claude/diary/yyyyMMdd.N.md    # retrospective
```

## Dependencies

- `mcx` CLI (this repo) for session management
- `mcpd` daemon running for IPC
- `gh` CLI for GitHub operations
- Git worktree support

## Related skills

- `/implement` — single-issue implementation (called by sprint workers)
- `/qa` — verification and merge (called by sprint workers)
- `/adversarial-review` — multi-agent PR review
- `/board-overview` — board survey without planning
- `/release` — standalone release cutting
