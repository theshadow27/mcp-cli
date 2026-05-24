---
name: harvest-rules
description: Mine merged-PR review comments for recurring author mistakes that could be caught by a doing-it-wrong rule. Use when the user wants to reduce review churn, asks "what should we lint for", "harvest rules", "mine PR comments for rules", or after a batch of PRs has merged. Surveys N PRs across parallel Sonnet agents, clusters findings, and proposes rules.
---

# Harvest Rules

Find mistakes that reviewers flag **more than twice** across merged PRs, then
decide which deserve a mechanical `doing-it-wrong` rule. The goal is to spend
review rounds on judgment, not on the same catchable mistake again and again.

## Philosophy

- **Bottom-up, not rule-first.** Agents extract the raw *finding* and tag it
  with a normalized `pattern_key`; the orchestrator discovers clusters from
  the keys. Don't ask an agent "is this a rule" per-PR — it can't see across
  PRs, and the recurring-ness is the whole signal.
- **Signal over volume.** A clean, consistently-named key set clusters
  cleanly. Garbage in the keys ruins the clustering.
- **Enforceable or skip it.** Stale-doc-comments recur constantly and are
  worthless as rules — they need human judgment. Leave those to review.
- **Human in the loop.** Present clusters and rule verdicts; the user decides
  what to file. Never auto-create rules.

## Pipeline

The three stages the user cares about: **(1) survey → candidate list,
(2) dedup → clusters, (3) investigate each cluster → rule / no-rule.**

### 1. Pick the PR range and extract context

```bash
# Last N merged PRs, newest first
gh pr list --state merged --limit 100 --json number --jq 'sort_by(.number) | reverse | .[].number' > build/harvest/pr-list.txt

# Extract all in parallel (owner/repo auto-derived from gh context)
xargs -P 6 -n 4 bun .claude/skills/harvest-rules/scripts/extract-pr.ts < build/harvest/pr-list.txt
```

`extract-pr.ts` writes `build/harvest/pr/<n>.md` per PR (description, changed
files, issue comments, review bodies, inline threads). `build/` is gitignored.
~10KB/PR; 100 PRs ≈ 1MB. The `gh pr diff` of merged PRs is unreliable, so the
script deliberately fetches the file *list*, not the diff — findings live in
the comments.

### 2. Classify — one Sonnet agent per ~10 PRs

```bash
split -l 10 build/harvest/pr-list.txt build/harvest/group-
mkdir -p build/harvest/findings
```

Launch one agent per group **in a single message** (parallel), `model:
sonnet`, `subagent_type: general-purpose`. Keep the prompt tiny — point at the
reference, don't inline it:

> Follow the instructions at `.claude/skills/harvest-rules/references/extract.md`.
> Your group is **aa**. Your PR files: `build/harvest/pr/2235.md` … (list the 10).
> Write your table to `build/harvest/findings/group-aa.md`.

Each agent reads its files, writes a findings table, and returns it. The
reference defines the finding criteria, the `pattern_key` normalization, the
severity/enforceability columns, and the output format.

### 3. Cluster and decide

Read all `build/harvest/findings/group-*.md`. Group findings by semantic
equivalence of `pattern_key` (agents won't use identical strings — merge
`poll_timeout_equals_test_timeout` and `pollduration_equals_test_timeout`).
For each cluster count **distinct PRs**.

Write `build/harvest/REPORT.md` tiering clusters by
`distinct_PR_count × mechanical_enforceability × value`:

- **File a rule** when distinct-PR ≥ 3, enforceable (at least a high-precision
  subset), and recurring. `blocked-merge` findings weigh more — they cost
  repair rounds.
- **Narrow-subset rule** when the cluster is huge but judgment-heavy in
  general (e.g. "vacuous test assertions") — enforce only the crisp sub-forms
  (`toBeLessThanOrEqual(1)`, `expect(arr.filter(...)).toHaveLength(0)`).
- **Not a rule** when it's already covered by Biome/tsc (then it's a
  *pre-commit/process* gap, not a missing rule), or needs semantic judgment
  (stale doc comments), or is one-off.

Present the tiered report. Let the user pick what to file.

### 4. File issues (the ticket bar)

This repo's bar for a rule ticket is stricter than a generic "suggestion."
Before filing, search open issues to dedup (`gh issue list --state open
--search "<keyword>"`). Then **every rule ticket must specify all three of:**

1. **Mechanical detection** — exactly what a regex / AST / `check` rule matches,
   and which paths it's scoped to. No "improve X" — a concrete predicate.
2. **A test fixture** — the rule engine is fixture-driven: name the
   `<id>__clean.fixture.ts` (`@expect 0`) and `<id>__flagged.fixture.ts`
   (`@expect N`) cases, using the `@rule` / `@expect` / `@path` JSDoc frontmatter
   format (see `scripts/rules/fixtures/`).
3. **A non-smelling alternative** — the better pattern the rule's `guidance`
   will point authors to. If the alternative is "use helper X" and X doesn't
   exist yet, the ticket is a **helper + rule double-header** (build X, then ban
   the manual form) — say so.

**If you can't write all three, it isn't a rule.** File it instead as a
process note (pre-commit/lint-scope gap, fixture-coverage gap) or a
judgment-only review item — don't dress it up as a dotw rule.

Conventions: title `feat(rules): …` (or `feat(core)`/`feat(command)` for a
helper double-header); label `enhancement`; body leads with the source PR list
(`harvested from #A, #B, …`) and `blocked-merge` count, since recurrence +
cost is the justification. Implementation lands later as
`scripts/rules/<id>.rule.ts` + fixtures (`scripts/rules/_engine/rule.ts` has the
`Rule` type; copy an existing `*.rule.ts` for shape), with the rule's
`documentation` field pointing back at the issue number.

## Diary mining (secondary, lower yield)

Diaries (`.claude/diary/*.md`) are mostly *orchestration* lessons, not
execution mistakes, so they rarely produce code rules. The exception worth a
pass: **flaky-test root causes.** When a diary or `/flaky-tests` run names
*why* a test flaked (fixed-delay sleep, poll timeout == test deadline,
hardcoded port, unmocked clock), that cause is often a clean, high-value rule —
flakiness is expensive and recurring. Grep diaries for "flak", "timeout",
"race", "intermittent" and feed any mechanical cause into stage 3 alongside the
PR clusters. Skip the rest of the diary content.

## Notes

- **Idempotency:** unlike the original phoenix version, this does not label
  PRs `harvested`. Re-runs re-extract (cheap) and re-cluster. If you want to
  extend the corpus, just widen the `gh pr list --limit` and re-run; the
  cluster counts grow.
- **Cost:** 100 PRs = 10 Sonnet agents, ~40–70k tokens each. Extraction is
  ~100 `gh` calls; `-P 6` stays under rate limits. If you see 403s, lower the
  parallelism.
- **Tuning the prompt:** the per-agent prompt is `references/extract.md` — edit
  it in one place, all agents pick it up. The first proven run (sprint 60,
  PRs #2050–2235) produced clean clusters; see that `REPORT.md` for the
  baseline pattern taxonomy.
