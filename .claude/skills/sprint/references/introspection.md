# Code-First Introspection

A periodic adversarial review of the daemon + orchestration system, **reading
the code directly instead of trusting the skill markdown / CLAUDE.md / READMEs
as ground truth**. The output is a list of initiative-level issues filed against
specific structural problems.

**Why this exists:** every sprint optimizes for the next-PR loop. Structural
drift accumulates *invisibly* — files balloon to thousands of lines, copy-pasted
modules diverge, defensive workarounds harden into permanent fixtures, coverage
exclusions hide regressions. Catching this on a cadence is far cheaper than
discovering it during an outside-comparison exercise.

The first round (sprint-48 plan-time) produced #1856–#1866 — see those issues
for the kind of finding this round is meant to surface.

## Cadence

**Run during the retro of sprints whose number ends in 7**: 17, 27, 37,
47-done, **57**, 67, 77… The round's findings feed the *next* sprint's
plan (Bucket-1 candidates for sprint 58, 68, …). See `retro.md`
"Introspection cadence" section for the trigger.

The sprint-47 → sprint-48 round was the prototype (#1856–#1866 filed,
tracked by #1867).

Earlier rounds may run if the prior round's debt warrants it — e.g. if a
follow-up issue from the previous round is still open and a fresh pass would
sharpen its scope.

## How to run

Spawn ONE Explore agent (high thoroughness, Sonnet by default — Opus only if
the previous round under-delivered). The Explore agent has its own context
window so heavy reading doesn't cost the orchestrator.

Use this prompt template (substitute the sprint number):

```
Run a code-first adversarial introspection of the mcp-cli daemon, command,
and sprint-skill systems for sprint {N} planning.

DO NOT trust:
- CLAUDE.md
- README files
- .claude/skills/**/*.md
- issue bodies or PR descriptions

DO trust:
- The actual TypeScript source under packages/{core,daemon,command,control}/src/
- The phase scripts under .claude/phases/
- Test files (what's covered, what's gaping)
- scripts/check-coverage.ts (current thresholds + exclusions)
- Recent merged PRs (git log --oneline -200 origin/main) — for what just shipped
  vs. what's still load-bearing

Look for:
1. **Mega-files**: any single .ts file >800 lines with multiple distinct
   responsibilities. Report file:line ranges of the seams.
2. **Copy-paste duplicates**: structurally similar files diverging on small
   diffs (worker-*.ts, *-server.ts pairs, command handlers).
3. **Silent error swallowing**: bare try/catch, .catch(() => {}), `as any` masks,
   ALTER TABLE in try/catch, IPC failures returning fallback values.
4. **Defensive workarounds**: comments referencing an issue number with
   "until X lands" / "belt:" / "guard:" / "see #N recurrence". Each one is a
   load-bearing workaround whose root cause never got fixed.
5. **Coverage gaps**: files <60% line coverage, especially anything in
   packages/daemon/src/ or packages/command/src/commands/.
6. **Stale skill text**: rule-sheet content in references/*.md that contradicts
   the code, or rules whose "Why:" line cites a closed-and-shipped fix.
7. **Half-wired features**: code paths the orchestrator never exercises — agents,
   commands, hooks that exist in source but have no callers.
8. **Concurrency / atomicity issues**: read-modify-write patterns outside
   transactions; SQLite ops mixed with async; shared state across workers.
9. **Latency hotspots**: blocking spawnSync / execSync on tight loops; per-tick
   gh CLI invocations; DB queries inside per-PR fan-out.
10. **Skill drift**: the rule sheet (.claude/skills/sprint/references/*.md)
    grew anecdote text instead of generalized rules; the diary backlog of
    incidents that should have been promoted is too long.

For each finding, report:
- Title (issue-ready, terse)
- File:line receipts (concrete, not "somewhere in the daemon")
- Why this is a problem (1-2 sentences)
- Proposed fix shape (1-2 sentences) — not a full design, just the direction
- Suggested labels: refactor / meta / testing / bug / epic / workflow

Aim for 8-12 findings. Quality over quantity — every finding should be
file:initiative-issue-worthy. Don't pad.

Return as a numbered list. Don't open issues — the orchestrator will file them
after triage with the user.
```

## Triage

The orchestrator reviews the agent's findings with the user before filing. For
each finding:

- **File as initiative issue** if the user agrees it's load-bearing. Use the
  agent's title + receipts + proposed fix as the issue body. Add labels.
- **Add to sprint-{N} plan** if it's tractable in this sprint (Bucket 1 anchor
  candidate, or filler).
- **Defer to backlog** if it's an epic that needs more design work.
- **Drop** if the agent overreached or the finding is already covered by an
  open issue.

Track the round itself with a meta tracking issue (like #1867 was for the
sprint-48 round) so future rounds can see what shipped vs. what's still open.

## Acceptance for the round

A round is "done" when:
- 5+ initiative issues are filed against findings.
- ≥1 of those issues is a Bucket-1 candidate in sprint-{N}'s plan.
- The tracking meta issue is updated with the new round's date + filed-issue
  numbers.

## Round history

| Sprint | Date | Findings filed | Tracking issue |
|--------|------|----------------|----------------|
| 47 (pre-48 plan) | 2026-04-28 | #1856–#1866 | #1867 (this template) |
| 57 | TBD | TBD | TBD |
