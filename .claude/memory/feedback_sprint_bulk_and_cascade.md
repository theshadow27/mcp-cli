---
name: Sprint orchestration — bulk reads + serialized cascades
description: For batch status checks use bulk jq not `for` loops (each `for` requires manual approval); for update-branch cascades, update one PR at a time not all — avoids N² CI load
type: feedback
originSessionId: 7bfd9df3-a7df-4c67-a7de-27fecd5bf44b
---
Two rules for sprint orchestration:

1. **Reads: bulk jq over `gh pr list`, never `for pr in ...; do gh pr view ...`.**
   Every `for` loop triggers a manual approval — 4 PRs = 4 user interruptions.
   Use one bulk query:
   ```bash
   gh pr list --state open --json number,mergeStateStatus,mergedAt,labels \
     --jq '.[] | select(.number==1439 or .number==1464) | "\(.number): \(.mergeStateStatus)/\(.mergedAt // "open")"'
   ```

2. **Writes: single-pointer update-branch cascades, not broadcast.**
   Updating all N BEHIND PRs after each merge triggers N CI runs × N merges = N² CI runs. Instead: update only the *next-to-merge* PR. When it merges, update the next one. Others sit BEHIND until their turn — that's correct and cheap.

**Why:** Sprint 37 burned significant CI budget (and user approval fatigue) by broadcasting update-branch after each merge. User flagged both the `for`-loop approval cost and the quadratic cascade cost directly during the run.

**How to apply:** In any sprint where multiple qa:pass PRs are queued for auto-merge, pick the oldest/smallest and update-branch only that one. Let auto-merge land it, then pick the next. For all multi-PR status rollups, write one bulk `gh pr list` + jq query.
