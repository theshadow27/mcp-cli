---
name: review-context-in-prs
description: Reviewers must leave findings as PR comments, repairers must read PR comments before fixing
type: feedback
---

Reviewers should post their findings as PR comments (not just print them to the session). Repair sessions should always read PR comments before starting work.

**Why:** Repair sessions kept introducing new issues because they only got a summary of the latest review — not the full context of what was already tried and found. PR comments are the durable, shared source of truth.
**How to apply:** Update adversarial-review skill to always post to PR. Update repair spawn prompts to instruct reading PR comments first. Update sprint run.md to document this pattern.
