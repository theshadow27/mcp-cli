# Sprint Planning

Plan the next sprint: survey the board, set a goal, pick issues, write the plan file.

**When to run:** At the end of a sprint (while last QA sessions drain), or when
starting fresh. If running at sprint end, you already have context — skip reading
issue bodies you just worked on.

**Run planning commands from within the project root.** `mcx claude ls` and related
session commands filter to the current repo. If you're in the wrong directory, you
won't see your sessions. When running concurrent sprints across repos, each orchestrator
is isolated to its own repo — use `--all` only when you explicitly need a cross-repo view.

## Step 1: Survey the board

Fetch all open issues and recently closed issues:

```bash
gh issue list --state open --json number,title,labels,body --limit 200
gh issue list --state closed --json number,title,labels,closedAt --limit 50
```

While surveying:
- Close duplicate issues (sessions often file the same finding independently)
- Note which arcs just completed vs still active
- Identify issues that got filed during the current sprint (follow-ups from reviews)

### Step 1a: Review pending `meta` issues with the user

Meta issues (`.claude/skills/**`, `.claude/memory/**`, `CLAUDE.md`,
`.gitignore`) do not go into the sprint backlog — they are applied by the
orchestrator outside any sprint, between sprints. But they must be
reviewed **before** the sprint starts, while the user has full attention.
Don't rely on the user to remember to run improvements independently —
the plan phase pulls them up.

```bash
gh issue list --state open --label meta --json number,title,body,updatedAt --limit 50
```

Present each one to the user in order of recency, with a short summary and
a recommendation: **apply now, defer to later retro, or close.** For each
one the user approves for *now*, apply via a short-lived `meta/<descriptor>`
branch + auto-merge PR (the autoapprover blocks direct-push to main):

```bash
# (a) Branch from main
git checkout -b meta/<short-descriptor>

# (b) Edit the meta files (orchestrator edits directly — small well-scoped
#     changes, not worker tasks)

# (c) Commit + push + auto-merge PR
git add <files>
git commit -m "chore(skill): …"   # or chore(memory): …
git push -u origin meta/<short-descriptor>
gh pr create --base main --head meta/<short-descriptor> \
  --title "chore(skill): …" \
  --body "Applies meta-fix #<n>. Docs/skill-only — pre-commit hooks should skip the test suite."
gh pr merge --squash --delete-branch --auto

# (d) After merge: close the issue
gh pr view <pr> --json state -q .state    # poll until MERGED
gh issue close <n> --comment "Applied in <merged-sha>."
git checkout main && git pull --ff-only
```

Meta-fixes use their own `meta/<descriptor>` branch (not the sprint branch)
because they're outside the sprint lifecycle — they need to land on main
*before* the new sprint's plan PR opens, so the new sprint inherits them.

Only proceed to Step 2 once the user has reviewed every pending `meta`
issue. They might all get deferred — that's fine, the goal is just that
the user sees them and makes a conscious call. Meta issues left unattended
across multiple sprints are a signal that either the label filter is wrong
(should be a normal bug, not meta) or the project needs a dedicated
"improvement sprint" pass.

## Step 2: Set a sprint goal

Every sprint needs a thesis — one sentence that drives issue selection:

- "Clear the Control TUI follow-ups"
- "Harden the daemon for production"
- "Ship the auth story end-to-end"

Choose based on:
- What arc has the most ready issues?
- What just shipped that needs follow-through?
- What has the user expressed priority on?
- What's been gathering dust the longest?

The goal doesn't mean *only* goal-aligned issues. It means the goal gets priority
for slots, and filler issues round out capacity.

## Step 3: Select issues

Target: **15 issues** (adjust based on user input).

### Step 3a: Delegate candidate reconnaissance to an Explore agent

Before classifying, spawn one `Explore` agent to do the issue-body + code +
cross-reference reading in depth. The planner (you) is working under
context pressure — triaging 20+ candidates by title or by a 30-second
skim is how decisions land based on assumptions that the code + PR
history would have refuted.

The Explore agent reads everything for you and reports back a compact
digest per candidate. Example prompt:

```
Explore these candidate issues for sprint N planning: #A, #B, #C, #D, …

For each, report in 3–5 lines:
- Goal summary (1 line from issue body)
- Scope estimate: files likely touched, approximate LOC, any shared-file
  serialization risk with other candidates in this list
- Blockage check: is there an unresolved dependency, a recent comment
  flagging new info, a linked issue/PR that changes the story, or a
  `needs-clarification`/`waiting-for-reproduction` marker the title
  doesn't show?
- Already-done risk: grep the code for the proposed symbols/functions;
  flag any that already exist (we've closed 2–3 as already-done per
  sprint lately — better to catch these at plan time than after
  spawning an impl session)
- Recommended: include / defer / close-as-done / needs-clarification

Do not read issues outside this list. Report under 100 words per issue.
```

The Explore agent has its own context window, so heavy reading doesn't
cost the planner. It also does the cross-referencing (which candidate
conflicts with which) more reliably than a quick skim.

**When to skip Explore**: if the full candidate list is ≤5 issues AND the
planner just ran the previous sprint (so the issue bodies are fresh in
context), reading directly is fine. Otherwise use Explore — the overhead
is small and the quality uplift is consistent.

### Step 3b: Classify

Classify each pick:

| Category | Scrutiny | Review? | Target mix |
|----------|----------|---------|------------|
| Quick win | low | QA only | ~60% (9) |
| Medium | low-medium | QA only | ~25% (4) |
| Heavy | high | adversarial + QA | ~15% (2) |

Rules:
1. Never pick issues labeled `needs-clarification`
2. Prefer issues that unblock other issues (dependency roots first)
3. Read each issue body (via the Explore digest) before selecting — skip
   if unclear or underspecified
4. Group related issues so they land in the same sprint (shared context)
5. **Never pick issues that modify orchestration meta-files**: `.claude/skills/**`,
   `.claude/memory/**`, `CLAUDE.md`, `.gitignore`, or similar files the
   orchestrator reads live while running. Those changes belong in retro or
   between sprints, applied by the orchestrator via the meta-fix flow in
   Step 1a (a `meta/<descriptor>` branch + auto-merge PR). Workers modifying
   these mid-sprint means the orchestrator is reading a mix of old/new
   definitions across concurrent sessions (observed in sprint 32 when `/qa`
   and a docs PR both edited `run.md`). If an issue is pure meta, defer it
   to retro or a user-led cleanup pass.

Split picks into:
- **Goal issues** (10-12): aligned with the sprint thesis
- **Filler issues** (3-5): independent quick wins, tech debt, test coverage.
  These fill slots when goal issues are in review/QA. Explicitly mark as filler.

## Step 4: Assign batches (launch order only — NOT the orchestrator's task structure)

Group the 15 issues into 3 batches of 5. Batch 1 launches immediately;
batches 2-3 backfill as slots free. Within each batch:
- No two issues should modify the same files
- Mix quick and medium — don't put all heavies in one batch
- Put dependency roots in batch 1

**Batches are a planning mental-model for launch order; they are NOT
TaskCreate groupings.** The run phase will create one Task per issue with
`addBlockedBy` edges for each cross-issue dependency — that way idle slots
automatically pull the next unblocked issue instead of waiting for a batch
tail. Sprint 41 burned multi-minute stretches with one active session while
the other slots waited for "Batch 2 to finish" before starting Batch 3;
sprint 42 fixed it by creating 20 issue-scoped Tasks; sprint 43 regressed
to 3 Batch-level Tasks and re-introduced the cascade. See `run.md` Input
section — "Task list setup" — for the exact pattern.

Document the dependency edges explicitly in the plan so the run phase can
translate them to `addBlockedBy` without re-derivation. Format each edge as
"#child blockedBy #parent" in a bullet list under the Batch Plan section:

```
- #1579 blockedBy #1578 (CopilotPoller must land first)
- #1582 blockedBy #1583 (defineMonitor contract consumes the runtime)
```

Hot-shared file serializations also become blockedBy edges — the second PR
to a shared file is blocked on the first's merge, regardless of batch.

**Watch for logical merge conflicts on shared dispatch files.** If two
picks both add entries to the same dispatch table (e.g., a `case "..."`:
in `packages/command/src/main.ts`, a new route in a router, a new flag
in a feature-flag map, a new entry in a registry), git will happily
merge both without conflict (different line ranges) but the combined
main will have duplicate handlers. Sprint 33 hit this with #1291 and
#1293 both adding `case "phase":` — lint caught it post-merge, but main
was red in between. Defuse at planning time:

- Identify picks that touch known "hot-shared" files: `main.ts`,
  router files, any `registry.ts`/`dispatch.ts`, feature flag configs
- Either serialize them across batches (second PR starts after first
  merges — natural rebase enforces the conflict) or explicitly flag
  them in the plan so the orchestrator broadcasts a targeted rebase
  directive when the first merges ("rebase AND check for duplicate
  dispatch entries you may have added in parallel")

This is planning-time guidance, not a review-time grep — the cost of
reviewers grepping every PR for potential duplicates across all open
sibling branches is far higher than the (rare) cost of a single lint
failure + rebase.

## Step 5: Write the sprint plan

Determine the sprint number:
```bash
ls .claude/sprints/sprint-*.md 2>/dev/null | sort -t- -k2 -n | tail -1
```
Increment by 1. If no files exist, start at 10.

Write `.claude/sprints/sprint-{N}.md`:

```markdown
# Sprint {N}

> Planned {date} {HH:MM local}. Target: 15 PRs.

## Goal

{one-sentence sprint thesis}

## Issues

| # | Title | Scrutiny | Batch | Model | Provider | Category |
|---|-------|----------|-------|-------|----------|----------|
| 638 | stale expandedEntries indices | low | 1 | opus | claude | goal |
| 385 | README missing commands | low | 1 | sonnet | claude | filler |
| 642 | SIGTERM escalation fix | medium | 2 | opus | copilot | goal |
...

The `Provider` column is optional — omit it or leave blank to default to `claude`.
Valid values: `claude`, `copilot`, `gemini`, `acp:<agent-name>`.
See `references/run.md` for how the provider routes spawn commands.

## Batch Plan

### Batch 1 (immediate)
#638, #639, #640, #641, #647

### Batch 2 (backfill)
#642, #496, #409, #466, #385

### Batch 3 (backfill)
#140, #126, #361, #129, #290

## Context

{2-3 sentences on what just shipped, what arcs are active, any risks}
```

## Step 6: Report and confirm

Show the user:
- Sprint number and goal
- Issue list grouped by batch
- Estimated scrutiny mix
- Any issues you considered but excluded (and why)

Wait for confirmation. The user may swap issues, adjust the goal, or approve as-is.

## Step 6a: Open the long-lived sprint branch + draft PR

Once the user approves, open the sprint container: a `sprint-{N}` branch in
its own worktree, plus a draft PR that will accumulate every sprint-meta
commit (plan, mid-sprint amendments, run-time edits, Results, retro,
release) and merge as a single squash at retro time. See `SKILL.md` for
the rationale.

```bash
# (a) Make sure main is current and the worktree path is free
git fetch origin main
git worktree list | grep -q "sprint-{N}" \
  && { echo "ERROR: a sprint-{N} worktree already exists — leftover from an earlier attempt?" >&2; exit 1; }

# (b) Create the sprint branch + worktree from current origin/main
git worktree add -b sprint-{N} .claude/worktrees/sprint-{N} origin/main

# (c) Move the plan file into the worktree (keep an uncommitted copy in
#     the orchestrator's main checkout so phase scripts can read it during
#     run — see run.md "Sprint-meta edits during run")
cp .claude/sprints/sprint-{N}.md .claude/worktrees/sprint-{N}/.claude/sprints/sprint-{N}.md

# (d) Commit the plan inside the worktree
(
  cd .claude/worktrees/sprint-{N}
  git add .claude/sprints/sprint-{N}.md
  git commit -m "sprint({N}): plan — {one-line goal}"
  git push -u origin sprint-{N}
)

# (e) Open the container PR as DRAFT — converts to ready at retro time.
#     Use --draft so it doesn't auto-merge prematurely.
gh pr create --base main --head sprint-{N} \
  --draft \
  --title "sprint({N}): {one-line goal}" \
  --body "$(cat <<'PRBODY'
Sprint {N} container PR. Accumulates every sprint-meta commit on the
\`sprint-{N}\` branch:

- plan + any mid-sprint amendments
- run-time edits (Started/Ended timestamps, Excluded section)
- Results summary
- retro diary file
- release commit (if a release is cut this sprint)

Marked **draft** until \`/sprint retro\` flips it ready and arms auto-merge.

Docs/skill-only by construction — pre-commit hooks should skip the test suite.
PRBODY
)"
```

The orchestrator now has two relevant working trees:
- **Main checkout** (`./`) — where `mcx` runs, where phase scripts read
  `.claude/sprints/sprint-{N}.md` from. The plan file lives here uncommitted.
- **Sprint worktree** (`.claude/worktrees/sprint-{N}/`) — where the
  `sprint-{N}` branch lives. Source of truth for sprint-meta commits.

The two are kept in sync manually (orchestrator copies updates between them).

## Step 7: Overlap with current sprint

If planning during an active sprint:
- Do steps 1-6 while QA sessions are draining
- Don't spawn new implementation sessions — that's the next sprint's job
- The plan file is ready for the next `/sprint` invocation in a fresh context
