---
name: Sprint orchestration — NO for loops, bulk reads, serialized cascades
description: ABSOLUTELY no `for` loops in bash under any circumstances (sprint 43 re-emphasis); use bulk jq for status; serialize update-branch one PR at a time to avoid N² CI
type: feedback
originSessionId: 7bfd9df3-a7df-4c67-a7de-27fecd5bf44b
---
**Rule 0 (absolute): NO `for` loops in bash, under any circumstances, no matter how many extra tool calls it takes.** Sprint 43 night-orchestration: user explicitly said "absolutely no `for` loops under any circumstances, no matter how many extra tool calls that takes. NO FOR LOOPS. one call at a time please. no `for` loops!" Do not rationalize around this. Even if it seems like more calls, use separate bash invocations or bulk jq — never `for ... do ... done`.

Two derived rules for sprint orchestration:

1. **Reads: bulk jq over `gh pr list`, never `for pr in ...; do gh pr view ...`.**
   Every `for` loop triggers a manual approval — 4 PRs = 4 user interruptions.
   Use one bulk query:
   ```bash
   gh pr list --state open --json number,mergeStateStatus,mergedAt,labels \
     --jq '.[] | select(.number==1439 or .number==1464) | "\(.number): \(.mergeStateStatus)/\(.mergedAt // "open")"'
   ```

2. **Writes: single-pointer update-branch cascades, not broadcast.**
   Updating all N BEHIND PRs after each merge triggers N CI runs × N merges = N² CI runs. Instead: update only the *next-to-merge* PR. When it merges, update the next one. Others sit BEHIND until their turn — that's correct and cheap.

**Why:** Sprint 37 burned significant CI budget (and user approval fatigue) by broadcasting update-branch after each merge. Sprint 43 re-emphasis happened at night when user couldn't monitor — a single stray `for` loop would wake them up for permission. User flagged both the `for`-loop approval cost and the quadratic cascade cost directly during the run.

**How to apply:** In any sprint where multiple qa:pass PRs are queued for auto-merge, pick the oldest/smallest and update-branch only that one. Let auto-merge land it, then pick the next. For all multi-PR status rollups, write one bulk `gh pr list` + jq query. For anything that feels like it needs iteration: parallel bash tool calls, or a single `jq` expression, or separate sequential single-command invocations. Never a shell `for`.
