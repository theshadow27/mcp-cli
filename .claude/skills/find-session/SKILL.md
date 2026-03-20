---
description: Full-text search of Claude Code session histories to find and resume past conversations. Use when user says "find session", "search sessions", "find that conversation where", or wants to locate a previous Claude session.
---

# Find Session Skill

Search through Claude Code session history files (JSONL) to find past conversations by keyword, then summarize and rank matches for easy resumption.

## When to Use

Trigger when the user:
- Wants to find a past conversation ("find the session where we discussed X")
- Can't remember which window had a specific discussion
- Wants to resume work from a previous session
- Says `/find-session`

## Workflow

### Step 1: Extract Keywords

From the user's request, identify keywords and/or literal phrases:

- **Quoted phrases** (`"feature/PROJ-123"`) — matched as exact substrings (case-insensitive). Use for branch names, ticket IDs with prefixes, error messages, file paths, or any string where the exact form matters.
- **Unquoted words** — tokenized and matched via BM25. Use for general concepts, function names, topics.
- Cast a wider net — the search matches ANY keyword/phrase, so more terms = better ranking (sessions matching more score higher)

Tell the user what keywords you're searching for.

### Step 2: Run the Search

```bash
.claude/skills/find-session/scripts/search-sessions.ts [keyword] ["literal phrase"] ... [--max 10]
```

Examples:
```bash
# Tokenized keywords (matches "auth", "middleware" independently)
.claude/skills/find-session/scripts/search-sessions.ts auth middleware refactor

# Literal phrase (matches exact substring "feature/fix-auth-middleware")
.claude/skills/find-session/scripts/search-sessions.ts '"feature/fix-auth-middleware"'

# Mixed: literal phrase + tokenized keywords
.claude/skills/find-session/scripts/search-sessions.ts '"PROJ-123"' branch deploy
```

Options:
- `--max N` — limit results (default 10)
- `--project-filter SUBSTRING` — restrict to project dirs matching substring

The script searches ALL `.jsonl` files under `~/.claude/projects/` and `~/.claude/sessions/` (~2.7s for 671 files via Bun's parallel I/O). Uses BM25 ranking: matches ANY keyword, ranks by term frequency * inverse document frequency, with a coverage bonus for matching more distinct terms. Sessions containing `/find-session` + the query keywords in the same user message are penalized 90% (self-reference suppression).

### Step 3: Summarize Matches with Parallel Agents

For each result (up to ~5), launch a **parallel Haiku Agent** to summarize the session.

**Agent prompt template:**
```
Run this command to extract the conversation text from a Claude Code session:

.claude/skills/find-session/scripts/extract-messages.ts {jsonl_path}

Then summarize the output in 2-3 sentences — what was being worked on, key decisions, and outcome.
Output ONLY the summary text, nothing else.
```

The extraction script strips tool_use, tool_result, and thinking blocks, outputting clean USER:/ASSISTANT: text. This gives Haiku pre-chewed input in a single tool call instead of fumbling with JSONL parsing.

Use `model: "haiku"` for these agents. Run them in parallel since they're independent.

### Step 4: Present Results

Display results as a ranked table:

```
## Session Search Results for: "keyword1 keyword2"

| # | Date | Project | Summary | Resume Command |
|---|------|---------|---------|----------------|
| 1 | 2026-03-19 | repo-name | Summary here... | `claude --resume abc123-def456` |
| 2 | ... | ... | ... | ... |
```

For each result show:
- **Date**: Last modified date
- **Project**: The project directory (cleaned up — strip the encoded home directory prefix and replace `-` with `/` for readability)
- **Summary**: The Haiku-generated summary
- **Resume command**: `claude --resume {session_id}`

### Step 5: Offer Follow-up Options

After presenting results, offer:

> **Options:**
> 1. **Resume directly** — Run `claude --resume <session_id>` to pick up where you left off
> 2. **Load condensed context** — I'll create a focused summary of the session that you can start a fresh conversation with (useful if the session is very long or you only need specific context from it)
> 3. **Refine search** — Try different keywords if these aren't the right sessions

### If User Chooses "Load Condensed Context"

Launch another **Haiku Agent** with this prompt:

```
Run this command to extract the conversation text from a Claude Code session:

.claude/skills/find-session/scripts/extract-messages.ts {jsonl_path}

Then create a condensed context document that could be used to resume this work in a fresh session. Structure it as:

## Session Context: {brief title}
**Original project**: {cwd}
**Date**: {date}

### What was being worked on
{1-2 paragraphs describing the task/goal}

### Key decisions and progress
{Bullet points of important decisions, approaches taken, things that worked/didn't}

### Current state
{Where things left off — what's done, what's remaining}

### Files touched
{List of key files that were modified or discussed}

{If the user provided a specific focus area, concentrate the summary on that aspect.}
```

Then display the condensed context to the user and suggest they can copy it as the opening message of a new `claude` session.

## Formatting Notes

- Clean up project dir names: strip the `-Users-user-name-github-` prefix and replace `-` with `/` for readability
- Truncate summaries to ~100 chars in the table, show full text below if needed
- If no results found, suggest alternative keywords or broader search terms
