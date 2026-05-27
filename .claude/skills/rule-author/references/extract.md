# Per-PR classifier prompt (one Sonnet agent per group of ~10 PRs)

The orchestrator launches one agent per group with a short pointer instead of
the full prompt:

> Follow the instructions at `.claude/skills/rule-author/references/extract.md`.
> Your group is **<group-id>**. Your PR files are:
> `build/harvest/pr/<n>.md` (×10). Write to `build/harvest/findings/group-<id>.md`.

Everything below is what the agent does.

---

You are surveying GitHub PR review comments to find **recurring author
mistakes that reviewers flagged** — the kind a linter / architecture check /
"doing-it-wrong" rule could catch mechanically instead of costing a review
round.

## Context

This repo has a custom rule engine at `scripts/rules/*.rule.ts`, run by
`bun run doing-it-wrong` (pre-commit). A rule is worth writing only if a
mistake is (1) **mechanically detectable** without human judgment,
(2) **generalizable** beyond one PR, and (3) **recurring**. Existing rules:
`shell-injection` (no template interpolation into execSync) and
`no-js-extension-local-import` (relative imports must be extensionless).

Reviews come mostly from **Copilot inline threads** and Claude **"QA
Verification"** comments. A `qa:fail` label or a repair round signals churn —
those findings are the highest-value because they cost the most.

## Your task

Read each of your assigned `build/harvest/pr/<n>.md` files (each has the
description, changed-file list, and ALL review comments). For each PR, extract
every distinct review **finding** representing a mistake the author made and a
reviewer flagged: Copilot inline comments, QA "must fix" / blocking items,
review-body actionable items, anything that triggered a repair round.

**Ignore:** praise; pure style nits the formatter already owns; one-off logic
bugs with no general pattern; "add a test" with no specifiable pattern;
doc-only suggestions with no mechanical check.

For EACH finding assign a normalized `pattern_key` — a short snake_case slug
for the GENERAL mistake class, NOT the specific instance. This key is how the
orchestrator clusters across all PRs, so invest in making it **reusable and
consistent**. Good keys: `incomplete_optional_chaining`,
`unbounded_concurrent_api_calls`, `poll_until_timeout_equals_test_timeout`,
`hardcoded_union_duplicating_source_of_truth`, `new_command_missing_completions`.
Bad keys: anything naming a specific function, file, or PR.

## Output

Write `build/harvest/findings/group-<id>.md` as a table, one row per finding:

```
| pr | pattern_key | severity | mechanically_enforceable | finding (1 sentence) | source (reviewer + file:line) |
```

- **severity**: `blocked-merge` (caused qa:fail/repair) | `flagged`
  (commented, fixed) | `minor`.
- **mechanically_enforceable**: `yes` | `maybe` | `no` — would a regex / AST /
  arch-check catch it WITHOUT judgment?

After the table add `## Notes`: which `pattern_key`s you saw more than once
within your 10 PRs, and any judgment calls on key naming.

Return to the orchestrator ONLY the table + notes you wrote. Be thorough but
precise — clean signal beats volume.
