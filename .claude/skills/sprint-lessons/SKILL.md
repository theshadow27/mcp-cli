---
name: sprint-lessons
description: >
  Extract actionable lessons from sprint history. Buckets every Claude Code
  session into the sprint it ran in, builds a deterministic per-session digest
  (tokens, duration, errors, orchestration signals, evidence), then runs a
  multi-agent Workflow that classifies each session (orchestrator vs worker),
  scans for tool errors / autoclassifier rejections / user interventions,
  summarizes it, aggregates per-sprint, per-10-sprint window, and over time —
  ending in ranked, concrete actions. Use for "extract sprint lessons", "what
  can we learn from sprint history", "/sprint-lessons", or a retro deep-dive.
---

# Sprint Lessons

Mines the full sprint session history for **what worked, what broke, and how the
operation has evolved** — and turns it into ranked, implementable actions.

Two halves:

- **Extractor** (`extract-sprint-sessions.ts`) — the *data* half. Runs locally,
  reads the raw session JSONL, and produces small **deterministic digests**.
  Facts (token totals, duration, error counts, orchestration signals) are
  computed here, not by an LLM, so they can't be hallucinated or recomputed.
- **Engine** (`../../workflows/sprint-lessons.js`) — the *judgment* half. A
  multi-phase `Workflow` of haiku/sonnet agents that read the digests and
  produce structured classification, summaries, aggregates, and a trend.

The extractor writes a **generated runner** to `/tmp` that feeds the digest
paths (grouped by sprint) into the engine via `args`. You invoke the runner;
you never paste the data into a tool call.

## How sessions map to sprints

Sprint boundaries are the **commit timestamps of diary files**
(`.claude/diary/YYYYMMDD.N.md`), validated against `.claude/sprints/sprint-N.md`
plan files — the same fencepost logic as the transcript archiver. Consecutive
fenceposts tile the timeline, so every session lands in exactly one sprint.
Sessions before the first diary ("legacy" era) are skipped.

## Step 1 — extract (local)

```bash
# Full history:
bun .claude/skills/sprint-lessons/extract-sprint-sessions.ts

# Scope it (recommended first run — cheaper, validates the pipeline):
bun .claude/skills/sprint-lessons/extract-sprint-sessions.ts --since-sprint 60
bun .claude/skills/sprint-lessons/extract-sprint-sessions.ts --sprint 69 --sprint 70
```

Flags: `--sprint N` (repeatable), `--since-sprint N`, `--window N` (sprints per
window, default 10), `--max-sessions-per-sprint N` (keep the N largest),
`--min-user-msgs N` (default 1), `--project-repo PATH`.

It prints progress to **stderr** and a single JSON line to **stdout**:

```json
{"runnerPath":"/tmp/sprint-lessons-…/run.js","runDir":"…","sprints":12,"sessions":140,"windowSize":10}
```

Parse that line. `runDir` also holds `manifest.json` (the full args) and
`digests/<sprint-label>/<id>.json` (one digest per session).

## Step 2 — run the engine (Workflow)

Hand the runner path straight to the Workflow tool — **no `args` needed**, the
runner embeds them:

```
Workflow({ scriptPath: "<runnerPath from step 1>" })
```

Phases (watch with `/workflows`):

1. **Per-session** (haiku) — classify orchestrator/worker/planning/exploratory,
   scan for tool errors, autoclassifier/usage-policy rejections, api/quota
   stalls, user corrections, rework loops; summarize what it did; emit
   structured issues + lessons. Tokens/duration are read from the digest, not
   re-derived.
2. **Orchestrator deep-dive** (sonnet, pipelined off phase 1) — only for
   sessions classified orchestrator: model-routing logic, user feedback
   (categorized), orchestration decisions + consequences, antipatterns.
3. **Sprint aggregate** — one agent per sprint folds its sessions into a picture
   (summary, themes, deduped top issues/lessons, integer health signals).
4. **Window aggregate** — one agent per `windowSize` sprints: what *recurs*,
   each issue's trajectory (worsening/persistent/improving/resolved), metric
   trend.
5. **Trend** — single synthesis over all windows: how the operation changed over
   time, improvements, regressions, and **ranked actionable items** (P0–P2) each
   with rationale and a target (a rule, a skill, CLAUDE.md, daemon behavior).

## Step 3 — write the report

The Workflow returns a structured object (`meta`, `sessionResults`,
`sprintSummaries`, `windowSummaries`, `trend`). Write it to a durable artifact:

- A human-readable markdown report (lead with `trend.actionable`, then the
  over-time narrative, then per-window and per-sprint detail) to
  `.claude/diary/` or wherever the user wants it.
- File issues for the P0/P1 actionable items via the `issue-author` agent.

## Cost & scaling notes

- One haiku agent per session + one sonnet agent per orchestrator session + one
  sonnet per sprint + one per window + one trend. Full history (~190 sessions,
  ~70 sprints) is the large case — scope with `--since-sprint` /
  `--max-sessions-per-sprint` for a cheaper first pass.
- Digests are capped (see `CAP` in the extractor) so each fits a haiku prompt.
  If a session's evidence feels thin, raise the caps — don't make agents read
  the raw JSONL (multi-MB; defeats the point).
- Re-running the extractor is cheap and idempotent per run (new `/tmp/runDir`
  each time). The engine is the expensive half.

## Design rationale

- **Facts vs judgment are split.** Numbers an LLM would get wrong (tokens,
  durations, counts) are deterministic in the digest; agents only judge.
- **Pipelined, not barriered, where possible.** Per-session → orchestrator
  deep-dive is a pipeline: an orchestrator session deep-dives the moment its
  classification lands, while other sessions are still being classified.
  Sprint/window/trend are genuine barriers (each needs all of the prior level).
- **The runner carries paths, not payloads.** Embedding digest *paths* (not the
  digests) in the runner keeps the Workflow invocation tiny and the orchestrator
  context clean.
