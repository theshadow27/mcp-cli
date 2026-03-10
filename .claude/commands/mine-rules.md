# Mine Rules from Conversation History

Extract actionable rules and user feedback from a Claude Code conversation history to improve skills and memory.

## Input

The user provides a conversation ID (UUID) and optionally a target skill name. Parse from: $ARGUMENTS

Format: `<conversation-id> [skill-name]`

Examples:
- `/mine-rules a47556cb-7200-4403-aae6-0988f88e5a71 manage`
- `/mine-rules a47556cb-7200-4403-aae6-0988f88e5a71` (general — updates MEMORY.md)

## Workflow

### 1. Locate the conversation

Search for the JSONL file in `~/.claude/projects/`:

```bash
find ~/.claude/projects -name "<conversation-id>.jsonl" 2>/dev/null
```

If not found, report and stop.

### 2. Extract user messages

The file is JSONL (one JSON object per line). Extract all human/user messages. These are large files (often 5k-15k lines), so use bash to filter:

```bash
# Extract user message content from JSONL
cat <file> | jq -r 'select(.type == "human") | .message.content[]? | select(.type == "text") | .text' 2>/dev/null
```

If jq isn't available or the format differs, use grep/awk to extract lines with `"role":"human"` or `"type":"human"`.

### 3. Analyze for rules

Scan all user messages for:

1. **Corrections** — "no, don't do X" / "you should have done Y instead"
2. **Explicit rules** — "always X" / "never Y" / "from now on..."
3. **Complaints about efficiency** — "this wastes time" / "too slow" / "burns context"
4. **Process instructions** — "the pipeline should be..." / "do X before Y"
5. **Repeated feedback** — same correction given multiple times (high signal)

Focus on **efficiency-related** feedback — things that affect context usage, time, cost, or pipeline throughput. Skip stylistic preferences unless they affect efficiency.

### 4. Categorize and deduplicate

Group extracted rules by category:
- **Orchestration** — how to manage sessions, polling, delegation
- **Pipeline** — phase ordering, when to clear, skip, or reuse
- **Resource management** — model selection, concurrency, context preservation
- **Cleanup** — worktree handling, daemon discipline, session lifecycle
- **Issue discipline** — when to file, label, skip

Remove duplicates. Cross-reference with existing skill content and MEMORY.md — don't extract rules that are already captured.

### 5. Output results

Present the extracted rules as a numbered list, grouped by category. For each rule, include:
- The rule itself (concise, actionable)
- Brief context on why (from the user's feedback)
- Whether it's **new** or **strengthens an existing rule**

### 6. Apply (with confirmation)

If a target skill was specified:
- Show the proposed additions/edits to the skill's SKILL.md
- Wait for user confirmation before writing

If no target skill:
- Propose updates to `~/.claude/projects/.../memory/MEMORY.md`
- Wait for user confirmation before writing

## Important

- This is a **research-only** task until the user confirms writes. Read files, analyze, and present findings.
- Large conversations may need to be processed in chunks. Use an Agent for the heavy extraction work.
- Only extract rules that are clearly user feedback/corrections, not assistant reasoning or tool output.
- Prioritize rules about efficiency over rules about style or preference.
