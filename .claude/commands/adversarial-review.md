---
description: Adversarial PR review with multi-agent second opinions
---

Adversarial review of the current branch's PR. Be critical, not agreeable.

## Process

0. **Check for a previous review:** Look for an existing review comment on this PR
   that starts with `## Adversarial Review`. If one exists, switch to **Delta Mode** (below).
   Otherwise, continue with full review.
1. Read the PR description and linked issue
2. Read CLAUDE.md for repo conventions
3. Read the full diff carefully
4. Launch these agents **in parallel** for second opinions:
   - **eigenbot** — unfiltered technical critique
   - **pessimist-prime** — failure mode analysis
   - **chaos-dancer** — user abuse/social weaponization vectors (if applicable)
5. Synthesize all perspectives into the output format below
6. If issues are out of scope of the PR description, create follow-up issues in gh.

## Delta Mode (re-review after fixes)

When a previous review comment exists, the author has likely pushed fixes.
Don't repeat the full adversarial process — evaluate what changed.

1. Read the previous review comment and extract all flagged issues (🔴, 🟡, 🔵)
2. Read the PR diff and recent commits to see what changed since that review
3. For each previous issue, determine: ✅ Fixed, ⏳ Not addressed, or 🔄 Partially fixed
4. Scan the new changes for any **genuinely new** issues introduced by the fix commits
5. Use the Delta Output Format below

Only escalate to a full re-review if the new commits are substantial (new feature scope,
major refactor, >50% of files changed are new files not touched in the original review).

### Delta Output Format

```
## Adversarial Review (Delta)

### Changes Since Last Review

| # | Previous Issue | Status | Notes |
|---|----------------|--------|-------|
| 1 | 🔴 <original issue title> | ✅ Fixed in <sha> | <brief note> |
| 2 | 🟡 <original issue title> | ⏳ Not addressed | <quote original concern> |

### New Issues
Only issues introduced by the new commits. Same severity format (🔴/🟡/🔵).
If none: "No new issues introduced."

### Suggested Automation
If any new findings could be a lint rule or test pattern, note them here.

### Updated Verdict
Based on the current state of ALL issues (resolved + remaining + new).
```

## Focus Areas

- **Correctness**: Does the code actually do what the PR/issue says? What edge cases are missed?
- **Applicability**: Does this PR solve the right problem? Is the approach appropriate for this codebase?
- **Evidence**: How do you know it works? Are there tests? Do the tests verify behavior or just check that code exists?
- **Gaps**: What's NOT tested that should be? What failure modes aren't handled?
- **Future-proofing**: If you spot a class of mistake that could be caught automatically (lint rule, test pattern), suggest creating an issue for it

## Full Review Output Format

```
## Adversarial Review

### What This PR Does
1-2 sentences.

### How We Know It Works
Summarize test coverage. Call out what's tested and what isn't.

### Issues
- 🔴 **Must Fix** — incorrect behavior, security issue, data loss risk (`file:line`)
- 🟡 **Should Fix** — missing edge case, weak test, architectural concern (`file:line`)
- 🔵 **Suggestion** — style, naming, minor improvement

If no issues: say so explicitly.

### Suggested Automation
If any findings could be caught by a new lint rule or test pattern, note them here
with enough detail to file an issue.

### Verdict
- ✅ **Approve** — no blocking issues
- ⚠️ **Changes Requested** — blocking issues found
- ℹ️ **Comment** — suggestions only, non-blocking
```

## Posting the Review (Sticky Comment)

Post the review as a **sticky comment** — update the previous one if it exists,
create a new one if it doesn't:

```bash
# Find existing review comment
COMMENT_ID=$(gh api repos/{owner}/{repo}/issues/<PR>/comments \
  --jq '.[] | select(.body | startswith("## Adversarial Review")) | .id' | tail -1)

if [ -n "$COMMENT_ID" ]; then
  # Update existing comment
  gh api repos/{owner}/{repo}/issues/comments/$COMMENT_ID \
    -X PATCH -f body="<review body>"
else
  # Create new comment
  gh pr comment <PR> --body "<review body>"
fi
```

This ensures repair sessions and second reviewers always see the latest state
of all findings in one place, with clear tracking of what was fixed vs what remains.
