---
name: coherence-review
description: "Review recent PRs in a feature area for architectural consistency, missed integration points, duplicated patterns, and wrong directions. File issues for problems found. Use after 3-4 related issues merge or when a session's cost exceeds $15."
---

# Coherence Review

Review a batch of related PRs for architectural consistency. Catches integration issues early — before multiple sessions build on top of a flawed foundation.

## Input

A feature area description and/or PR numbers. Parse from: $ARGUMENTS

Examples:
- `/coherence-review auth overhaul PRs #301 #305 #310 #312`
- `/coherence-review daemon session lifecycle`
- `/coherence-review 350 351 352 353`

## When to Run

- After every 3-4 issues in the same feature area merge
- When a session's cost exceeds $15 (sign of complexity/struggle)
- When you suspect related PRs may have diverged architecturally

## Workflow

### 1. Gather Context

If PR numbers were provided, fetch each:

```bash
gh pr view <number> --json title,body,files,mergedAt
gh pr diff <number>
```

If only a feature area was provided, find recent merged PRs in that area:

```bash
gh pr list --state merged --limit 20 --json number,title,files,mergedAt
```

Filter to PRs that touch relevant files. Build a picture of what changed across the batch.

### 2. Review for Architectural Consistency

For each concern below, compare across all PRs in the batch:

#### Consistent patterns
- Do the PRs use the same approach for the same problem? (e.g., error handling, logging, IPC patterns)
- Are naming conventions consistent across the changes?
- Do similar features follow the same structure?

#### Integration points
- Do the PRs interact correctly where they touch shared code?
- Are there missing integration points where PRs should connect but don't?
- Did any PR change an interface that another PR depends on?

#### Duplicated work
- Did multiple PRs implement the same or similar functionality?
- Are there new utilities or helpers that overlap with existing ones?
- Could shared abstractions reduce duplication?

#### Wrong directions
- Does any PR introduce a pattern that contradicts the project's conventions?
- Are there changes that will be painful to maintain or extend?
- Did any PR optimize for the wrong thing (e.g., premature abstraction, unnecessary flexibility)?

### 3. Cross-reference with Project Standards

Check that changes align with:
- `CLAUDE.md` conventions (strict TypeScript, no `any`, Bun-native, etc.)
- Existing patterns in the codebase (IPC protocol, config loading, test patterns)
- `test/CLAUDE.md` testing conventions

### 4. File Issues

For each problem found, file a GitHub issue:

```bash
gh issue create --title "<type>: <concise description>" --body "..."
```

Include in the issue body:
- Which PRs exhibit the problem
- Specific file paths and line numbers
- What the consistent approach should be
- Severity: is this a "fix now" or "fix next time you're in this area"

**Batch related problems** — don't file one issue per nit. Group related concerns into coherent issues.

### 5. Report

Summarize findings:

- **PRs reviewed**: list with titles
- **Consistency**: overall assessment (strong / minor drift / significant divergence)
- **Issues filed**: list with numbers and titles
- **Recommendations**: any broader architectural guidance for future work in this area

## Guidelines

- Be constructive, not pedantic. Focus on problems that will compound if left unaddressed.
- Minor style differences between PRs are normal — only flag patterns that will cause confusion or bugs.
- If the PRs are architecturally coherent, say so. A clean review is valuable signal too.
- Prefer filing actionable issues over vague concerns. "These two PRs handle errors differently" is vague; "PR #301 uses try/catch while #305 uses Result types for the same error category — standardize on Result types per CLAUDE.md" is actionable.
