# Sprint Planning

Plan the next sprint: survey the board, set a goal, pick issues, write the plan file.

**When to run:** At the end of a sprint (while last QA sessions drain), or when
starting fresh. If running at sprint end, you already have context — skip reading
issue bodies you just worked on.

**Run planning commands from within the project root.** `mcx claude ls` and related
session commands filter to the current repo. If you're in the wrong directory, you
won't see your sessions. When running concurrent sprints across repos, each orchestrator
is isolated to its own repo — use `--all` only when you explicitly need a cross-repo view.

## Step 1: Survey the board

Fetch all open issues and recently closed issues:

```bash
gh issue list --state open --json number,title,labels,body --limit 200
gh issue list --state closed --json number,title,labels,closedAt --limit 50
```

While surveying:
- Close duplicate issues (sessions often file the same finding independently)
- Note which arcs just completed vs still active
- Identify issues that got filed during the current sprint (follow-ups from reviews)

### Step 1a: Review pending `meta` issues with the user

Meta issues (`.claude/skills/**`, `.claude/memory/**`, `CLAUDE.md`,
`.gitignore`) do not go into the sprint backlog — they are applied by the
orchestrator directly on main, outside any sprint. But they must be
reviewed **before** the sprint starts, while the user has full attention.
Don't rely on the user to remember to run improvements independently —
the plan phase pulls them up.

```bash
gh issue list --state open --label meta --json number,title,body,updatedAt --limit 50
```

Present each one to the user in order of recency, with a short summary and
a recommendation: **apply now, defer to later retro, or close.** For each
one the user approves for *now*:

1. Apply the change directly on `main` (orchestrator edits the files —
   these are small, well-scoped edits, not worker tasks)
2. Commit with a conventional message (`chore(skill): …`, `chore(memory): …`)
3. Push
4. Close the issue: `gh issue close <n> --comment "Applied in <sha>."`

Only proceed to Step 2 once the user has reviewed every pending `meta`
issue. They might all get deferred — that's fine, the goal is just that
the user sees them and makes a conscious call. Meta issues left unattended
across multiple sprints are a signal that either the label filter is wrong
(should be a normal bug, not meta) or the project needs a dedicated
"improvement sprint" pass.

## Step 2: Set a sprint goal

Every sprint needs a thesis — one sentence that drives issue selection:

- "Clear the Control TUI follow-ups"
- "Harden the daemon for production"
- "Ship the auth story end-to-end"

Choose based on:
- What arc has the most ready issues?
- What just shipped that needs follow-through?
- What has the user expressed priority on?
- What's been gathering dust the longest?

The goal doesn't mean *only* goal-aligned issues. It means the goal gets priority
for slots, and filler issues round out capacity.

## Step 3: Select issues

Target: **15 issues** (adjust based on user input).

Classify each pick:

| Category | Scrutiny | Review? | Target mix |
|----------|----------|---------|------------|
| Quick win | low | QA only | ~60% (9) |
| Medium | low-medium | QA only | ~25% (4) |
| Heavy | high | adversarial + QA | ~15% (2) |

Rules:
1. Never pick issues labeled `needs-clarification`
2. Prefer issues that unblock other issues (dependency roots first)
3. Read each issue body before selecting — skip if unclear or underspecified
4. Group related issues so they land in the same sprint (shared context)
5. **Never pick issues that modify orchestration meta-files**: `.claude/skills/**`,
   `.claude/memory/**`, `CLAUDE.md`, `.gitignore`, or similar files the
   orchestrator reads live while running. Those changes belong in retro, done
   by the orchestrator directly on main. Workers modifying these mid-sprint
   means the orchestrator is reading a mix of old/new definitions across
   concurrent sessions (observed in sprint 32 when `/qa` and a docs PR both
   edited `run.md`). If an issue is pure meta, defer it to retro or a
   user-led cleanup pass.

Split picks into:
- **Goal issues** (10-12): aligned with the sprint thesis
- **Filler issues** (3-5): independent quick wins, tech debt, test coverage.
  These fill slots when goal issues are in review/QA. Explicitly mark as filler.

## Step 4: Assign batches

Group the 15 issues into 3 batches of 5. Batch 1 launches immediately;
batches 2-3 backfill as slots free. Within each batch:
- No two issues should modify the same files
- Mix quick and medium — don't put all heavies in one batch
- Put dependency roots in batch 1

**Watch for logical merge conflicts on shared dispatch files.** If two
picks both add entries to the same dispatch table (e.g., a `case "..."`:
in `packages/command/src/main.ts`, a new route in a router, a new flag
in a feature-flag map, a new entry in a registry), git will happily
merge both without conflict (different line ranges) but the combined
main will have duplicate handlers. Sprint 33 hit this with #1291 and
#1293 both adding `case "phase":` — lint caught it post-merge, but main
was red in between. Defuse at planning time:

- Identify picks that touch known "hot-shared" files: `main.ts`,
  router files, any `registry.ts`/`dispatch.ts`, feature flag configs
- Either serialize them across batches (second PR starts after first
  merges — natural rebase enforces the conflict) or explicitly flag
  them in the plan so the orchestrator broadcasts a targeted rebase
  directive when the first merges ("rebase AND check for duplicate
  dispatch entries you may have added in parallel")

This is planning-time guidance, not a review-time grep — the cost of
reviewers grepping every PR for potential duplicates across all open
sibling branches is far higher than the (rare) cost of a single lint
failure + rebase.

## Step 5: Write the sprint plan

Determine the sprint number:
```bash
ls .claude/sprints/sprint-*.md 2>/dev/null | sort -t- -k2 -n | tail -1
```
Increment by 1. If no files exist, start at 10.

Write `.claude/sprints/sprint-{N}.md`:

```markdown
# Sprint {N}

> Planned {date} {HH:MM local}. Target: 15 PRs.

## Goal

{one-sentence sprint thesis}

## Issues

| # | Title | Scrutiny | Batch | Model | Provider | Category |
|---|-------|----------|-------|-------|----------|----------|
| 638 | stale expandedEntries indices | low | 1 | opus | claude | goal |
| 385 | README missing commands | low | 1 | sonnet | claude | filler |
| 642 | SIGTERM escalation fix | medium | 2 | opus | copilot | goal |
...

The `Provider` column is optional — omit it or leave blank to default to `claude`.
Valid values: `claude`, `copilot`, `gemini`, `acp:<agent-name>`.
See `references/run.md` for how the provider routes spawn commands.

## Batch Plan

### Batch 1 (immediate)
#638, #639, #640, #641, #647

### Batch 2 (backfill)
#642, #496, #409, #466, #385

### Batch 3 (backfill)
#140, #126, #361, #129, #290

## Context

{2-3 sentences on what just shipped, what arcs are active, any risks}
```

## Step 6: Report and confirm

Show the user:
- Sprint number and goal
- Issue list grouped by batch
- Estimated scrutiny mix
- Any issues you considered but excluded (and why)

Wait for confirmation. The user may swap issues, adjust the goal, or approve as-is.

## Step 7: Overlap with current sprint

If planning during an active sprint:
- Do steps 1-6 while QA sessions are draining
- Don't spawn new implementation sessions — that's the next sprint's job
- The plan file is ready for the next `/sprint` invocation in a fresh context
