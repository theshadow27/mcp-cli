---
name: sprint
description: >
  Sprint lifecycle: plan, run, review, retro. The top-level orchestrator for
  autonomous issue resolution. Use for "run a sprint", "plan the sprint",
  "sprint review", "sprint retro", "/sprint", "/sprint plan", "/sprint review",
  "/sprint retro", or any variant.
---

# Sprint

The sprint lifecycle has four phases. Route based on arguments:

| Input | Action |
|-------|--------|
| `/sprint plan` | → Read `references/plan.md` |
| `/sprint` (with issue numbers or sprint plan exists) | → Read `references/run.md` |
| `/sprint` (no issues, no plan) | → Offer: "No sprint plan found. Run `/sprint plan` first, or pass issue numbers." |
| `/sprint review` | → Read `references/review.md` |
| `/sprint retro` | → Read `references/retro.md` |

## Sprint numbering

Sprints are numbered sequentially. The current sprint number is determined by:
```bash
ls .claude/sprints/sprint-*.md | sort -t- -k2 -n | tail -1
```

If no sprint files exist, start at sprint 10 (we've done ~9 unnumbered sprints).

The sprint number threads through all phases:
- Plan writes `.claude/sprints/sprint-N.md`
- Run reads that file for its issue list
- Review appends results to that file
- Retro writes `.claude/diary/yyyyMMdd.N.md`

## Key references

- `references/mcx-claude.md` — session management commands
- `references/plan.md` — sprint planning phase
- `references/run.md` — sprint execution phase (orchestrator prose)
- `references/review.md` — release + changelog phase
- `references/retro.md` — retrospective / diary phase

**Per-phase logic is defined in `.mcx.yaml` + `.claude/phases/*.ts`**, not
in `run.md`. Inspect a phase with `mcx phase show <name>` or preview its
next action with `mcx phase run <name> --dry-run`. See `docs/phases.md` for
the manifest schema.

## Rules (apply to all phases)

- **Never implement directly.** Always delegate to spawned sessions.
- **Never switch models mid-stream.** Kill and restart fresh if wrong model.
- **Spawn fresh sessions per phase.** Don't reuse across implement/review/QA.
- **File every problem as an issue.** Unfiled problems are invisible problems.
- **Never randomly kill the daemon.** File an issue if a kill seems required.
- **Use `mcx claude wait`, not sleep.** `wait --timeout` is event-driven and interruptible.
