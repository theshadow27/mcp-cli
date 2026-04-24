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
| `/sprint` (sprint plan exists) or `/sprint <N>` (sprint number matching a plan file) | → **Auto-chain**: read `references/run.md` and execute run; at wind-down, read `references/review.md` and execute the release inline; then read `references/retro.md` and execute the retro inline — all in the same session, no re-invocation |
| `/sprint run` or `/sprint run <N>` | → **Run-only**: read `references/run.md` and execute; mark the sprint-plan header with `(RUN ONLY)` next to the "Started …" timestamp; stop at wind-down without review/retro |
| `/sprint <issue-numbers>` (multiple numbers, or single number with no matching plan) | → Read `references/run.md` and run those specific issues (no auto-chain — there's no sprint plan to base review/retro on) |
| `/sprint` (no issues, no plan) | → Offer: "No sprint plan found. Run `/sprint plan` first, or pass issue numbers." |
| `/sprint review` | → Read `references/review.md` |
| `/sprint retro` | → Read `references/retro.md` |

**Why auto-chain is the default**: a sprint's post-run context (~300k+ tokens) is worth more than a single release cut. Running review and retro in a fresh `/sprint review` invocation pays a full cache miss to re-read everything you already know. Auto-chain executes review + retro inline in the same session and preserves it.

**Disambiguation `/sprint <N>`**: if `.claude/sprints/sprint-<N>.md` exists, `<N>` is a sprint number → auto-chain. Otherwise treat `<N>` as an issue number → run-only with no auto-chain.

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
