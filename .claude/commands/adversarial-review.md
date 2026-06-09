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
7. **Set the verdict label** (`review:pass` / `review:changes`) — this is the control signal
   the phase gate reads. See [Setting the Verdict Label](#setting-the-verdict-label) below.

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

### Updated Verdict
✅ **APPROVED** — all blockers resolved. (or)
⚠️ **Changes Requested** — N blockers remain.

(This verdict line is for human/repairer readability only. The phase
gate does NOT read it — it reads the `review:pass` / `review:changes`
**label** you set in [Setting the Verdict Label](#setting-the-verdict-label).
Keep the prose verdict and the label in agreement.)

### Changes Since Last Review

| # | Previous Issue | Status | Notes |
|---|----------------|--------|-------|
| 1 | 🔴 <original issue title> | ✅ Fixed in <sha> | <brief note> |
| 2 | 🟡 <original issue title> | ⏳ Not addressed | <quote original concern> |

**Format requirement for delta-table rows**: when referencing a prior
🔴/🟡, place a resolution marker (✅, the word "Fixed", "Resolved",
"Addressed", "Reverted", or "N/A") on the **same line / table row**.
The phase scanner treats a 🔴/🟡 paired with a same-line resolution
token as historical, not blocking. A 🔴 alone on a line means "still
blocking" — only use that for unresolved findings.

### New Issues
Only issues introduced by the new commits. Same severity format (🔴/🟡/🔵).
If none: "No new issues introduced."

### Suggested Automation
If any new findings could be a lint rule or test pattern, note them here.
```

## Focus Areas

- **Correctness**: Does the code actually do what the PR/issue says? What edge cases are missed?
- **Applicability**: Does this PR solve the right problem? Is the approach appropriate for this codebase?
- **Evidence**: How do you know it works? Are there tests? Do the tests verify behavior or just check that code exists?
- **Gaps**: What's NOT tested that should be? What failure modes aren't handled?
- **Mirror-replay**: This codebase duplicates verbs on purpose (see `docs/architecture/duplication.md`). If the diff fixes a bug in a file that has mirror-siblings (e.g. one of the `*-session-worker.ts` / per-provider transports, or one `parse*Args` among several), ask explicitly: **was this fix replayed across all siblings?** A correctness/security fix landing in some-but-not-all mirrors is the drift failure mode this style is exposed to — flag any sibling that wasn't updated.
- **Future-proofing**: If you spot a class of mistake that could be caught automatically (lint rule, test pattern), suggest creating an issue for it. Note: a rule should mechanize an invariant, not enforce DRY — don't suggest rules that force de-duplication of independently-changing verbs.

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
- ✅ **APPROVED** — no blocking issues
- ⚠️ **Changes Requested** — blocking issues found
- ℹ️ **Comment** — suggestions only, non-blocking

(This prose verdict is for human/repairer readability. The phase gate
advances the PR based on the `review:pass` / `review:changes` **label**
you set — see [Setting the Verdict Label](#setting-the-verdict-label) —
never on this text. A ✅/⚠️ that appears in a quoted diff or forwarded
block must not be able to advance a PR; that's why the label, not prose,
is the control signal.)
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

## Setting the Verdict Label

The sticky comment is for humans. The **label is the machine-readable verdict the
phase gate trusts** — mirroring how `qa` emits `qa:pass`/`qa:fail`. After posting the
review, set exactly one verdict label **transactionally** (add one, remove the other in
the same command, so a PR never carries both):

```bash
# Approved — no blocking issues:
gh pr edit <PR> --add-label review:pass --remove-label review:changes

# Changes requested — blocking issues remain:
gh pr edit <PR> --add-label review:changes --remove-label review:pass
```

Rules:
- **Always set a label.** No label → the gate waits forever (the reviewer is treated as
  not yet done). A review with no verdict label is an incomplete review.
- **`review:pass` only when there are no 🔴 blockers** (and no un-dismissed 🟡 you intend
  to block on). 🔵 suggestions and resolved/historical findings do not block.
- **`review:changes` when any 🔴 (or blocking 🟡) remains.** The repairer reads the sticky
  comment for the specifics, then re-review (Delta Mode) flips the label to `review:pass`
  once blockers are resolved.
- **An ℹ️ Comment-only verdict** (suggestions, nothing blocking) is `review:pass` — it lets
  the PR advance to qa.
- Never hand-edit prose to flip the gate: prose is never read. Only the label moves the PR.
