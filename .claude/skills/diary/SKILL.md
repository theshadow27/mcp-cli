---
name: diary
description: >
  Backfill diary entries from Claude Code session transcripts. Extracts insights,
  learnings, and patterns from past sessions and writes structured diary entries to
  .claude/diary/. Use when the user says "write diary", "backfill diary", "/diary",
  "what did we do today", or wants to capture session learnings. Also use proactively
  at the end of long productive sessions when significant work was completed.
---

# Diary: Session Transcript Analysis

Generate diary entries from Claude Code session JSONL transcripts stored in
`~/.claude/projects/<project-key>/`.

## How it works

1. Run the extraction script to produce per-date text extracts
2. Spawn one Sonnet agent per date (in parallel, foreground) to analyze and write entries
3. Multiple entries per day are supported (YYYYMMDD.md, YYYYMMDD.1.md, YYYYMMDD.2.md, etc.)

## Step 1: Run the extraction script

```bash
bun run .claude/skills/diary/extract-sessions.ts
```

This outputs a JSON manifest to stdout listing which dates need diary entries and where
the extract files are. Parse it.

## Step 2: Spawn analysis agents

For each date in the manifest, spawn a Sonnet agent (NOT background — foreground, but
all in parallel in a single message) with this prompt template. Use `diaryFilename`
from the manifest for the output path — it handles the `.N.md` suffix automatically.

```
You are analyzing Claude Code session transcripts from the mcp-cli project.
Read the file {extract_path} which contains extracted text from sessions on {date}.
Also read {diary_dir}/20260310.md for the format/style reference.

Write a diary entry to {diary_dir}/{diaryFilename} following this format:
- # {formatted_date} — Title (short thematic title)
- ## What was done (PRs, features, fixes — with issue/PR numbers where visible)
- ## What worked well
- ## What didn't work
- ## Patterns established (if any new ones emerged)

Extract specific issue/PR numbers, technical details, and concrete learnings.
Be specific about what code was changed. Keep it concise but specific — like
good engineering notes, not a summary report.
```

## Step 3: Report

After all agents complete, list the diary entries created with their titles.

## Notes

- The extraction script derives the project key from the current working directory
- Sessions with fewer than 5 user messages are filtered out (worker sessions, quick chats)
- Top 6 sessions per date by size are included
- Text is capped at ~25K chars per session to fit in agent context
- XML system tags (system-reminder, local-command-caveat, etc.) are stripped
- Only user and assistant text blocks are extracted (no tool_use/tool_result)
