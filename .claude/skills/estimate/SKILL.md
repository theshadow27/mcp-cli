---
name: estimate
description: "Post-implementation triage: measure actual diff metrics to determine review depth. Run after implement, before review. Usage: /estimate (in a worktree with changes)"
---

# Post-Implementation Triage

Measure the actual implementation diff and decide how much review it needs. This replaces upfront estimation — the implementation itself is the best signal.

## Philosophy

Predicting effort before implementation is unreliable (validated: best model achieved only 29.7% tier accuracy on 91 historical PRs). Instead:

1. Always implement with opus (the cost is similar across models; quality isn't)
2. Measure what was actually produced
3. Use concrete diff metrics to decide review depth

## Usage

After implementation completes, in the worktree:

```bash
bun .claude/skills/estimate/triage.ts
bun .claude/skills/estimate/triage.ts --json    # machine-readable
bun .claude/skills/estimate/triage.ts --base develop
```

## Triage Rules

High scrutiny if ANY of (validated: 92.5% F1, 0% false negatives on 91 PRs):

- **src churn ≥ 120 lines** (additions + deletions, excluding tests)
- **src additions ≥ 100 lines**
- **2+ risk areas touched** (IPC, auth, workers, server-pool, config, db, transport)
- **4+ source files across 2+ packages**

Everything else is low scrutiny.

## Pipelines

**Low scrutiny**: implement → QA → done

**High scrutiny**: implement → adversarial-review → QA → done
- If adversarial review finds issues → repair → re-review (loop until clean)

## Tools

- `triage.ts` — post-implementation triage (reads git diff, outputs scrutiny level)
- `score.ts` — AST-level complexity analysis (used by triage and backfill)
- `backfill.ts` — mines historical PRs into SQLite for validation
- `embed.ts` — text embeddings for PR similarity (research; not used in triage)
- `validate.ts` — method comparison (proves triage > prediction)
- `validate-triage.ts` — validates triage rules against historical data
- `db.ts` — shared SQLite database helpers (used by backfill, validate, triage)

## Data

Historical PR data lives in `~/.mcp-cli/estimates.db`. Run `bun .claude/skills/estimate/backfill.ts` to populate/update.
