# Sprint Retro

Write a retrospective diary entry capturing what happened, what worked, and
what didn't. This is internal engineering memory — concrete and specific.

## When to write

At the end of a sprint, **after** `/sprint review` (release) is done.

**IMPORTANT:** You already have the full sprint context in your conversation.
Do NOT launch transcript scanners, agents, or extraction scripts. Write the
retro directly from what you observed during the sprint.

## Determine the output file

Get the sprint number from the sprint plan:
```bash
ls .claude/sprints/sprint-*.md | sort -t- -k2 -n | tail -1
```

The diary file is: `.claude/diary/yyyyMMdd.{sprint_number}.md`

For example, sprint 12 on 2026-03-12 → `.claude/diary/20260312.12.md`

## Write the entry

Use this template exactly:

```markdown
# {yyyy-MM-dd} — {Short thematic title} (Sprint {N})

## What was done

{N} PRs merged, v{X.Y.Z} released.

**{Arc/theme name}:**
- Description of change (#issue/PR #pr) — brief technical detail
- ...

**{Another theme}:**
- ...

**Also closed:**
- Issues that were already implemented, duplicates, etc.

## What worked well

- Specific observation with evidence (e.g. "triage model was 100% accurate —
  all low scrutiny PRs passed QA first try, all high scrutiny needed repair")
- ...

## What didn't work

- Specific problem with context (e.g. "session 5c085a stuck in connecting —
  had to kill and respawn, no root cause")
- ...

## Patterns established

- New pattern or process change that emerged (if any)
- ...

## Stats

- **PRs merged**: N
- **Issues closed**: M (including already-done)
- **Adversarial reviews**: K (L findings fixed)
- **Failed/dropped**: J
- **Sprint cost**: ~$X (if observable)
```

## Commit and push

```bash
git add .claude/diary/{filename}
git commit -m "retro: sprint {N} — {short title}"
git push origin main
```

## Guidelines

- Be specific: issue numbers, session IDs, file names, line counts
- Capture surprises — things that went differently than expected
- Note process improvements for the next sprint
- Keep it concise — engineering notes, not an essay
- If something went wrong, say what the fix or workaround was
