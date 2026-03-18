# Sprint Planning

Plan the next sprint: survey the board, set a goal, pick issues, write the plan file.

**When to run:** At the end of a sprint (while last QA sessions drain), or when
starting fresh. If running at sprint end, you already have context — skip reading
issue bodies you just worked on.

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

| # | Title | Scrutiny | Batch | Model | Category |
|---|-------|----------|-------|-------|----------|
| 638 | stale expandedEntries indices | low | 1 | opus | goal |
| 385 | README missing commands | low | 1 | sonnet | filler |
| 642 | SIGTERM escalation fix | medium | 2 | opus | goal |
...

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
