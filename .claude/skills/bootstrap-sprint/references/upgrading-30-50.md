# Upgrading a sprint-30-era skill to sprint-50-era

When you encounter an existing sprint skill in another repo (yours or
someone else's) that was written ~20 sprints ago, the gap between it and
the current mcp-cli sprint skill is large enough that fixing one symptom
at a time is the wrong instinct. The deltas cluster — they came in
together, and they're worth lifting together.

This doc is the diagnostic checklist + upgrade buckets, written so a
fresh Claude can audit a target sprint skill without first re-deriving
the gaps from scratch. **No project-specific details** — every item
applies to any sprint skill running on the current `mcx` CLI.

## When this doc applies

You're probably looking at a sprint-30-era skill if you see most of:

- `mcx claude wait --timeout NNNNN` polling in the orchestrator main loop
- A `for each session in mcx claude ls --short` loop that re-derives state
  from logs every tick (`mcx claude log <id> --last 10` inside the loop body)
- Sprint state tracked by **editing the sprint plan file inline** (no
  `mcx track` / `mcx tracked --json`)
- One `TaskCreate` per *batch* (3 batches → 3 tasks blocking each other)
  rather than one per issue with `addBlockedBy`
- Pipeline logic written as imperative prose in `run.md` — no
  `.mcx.yaml` + `.claude/phases/*.ts` (no `mcx phase run` calls)
- `references/` directory has 4-6 files (SKILL/plan/run/review/retro,
  maybe mcx-claude.md) — no `compaction-survival.md`, no
  `investigations.md`, no `introspection.md`
- `/sprint review` and `/sprint retro` are separate user invocations
  (no auto-chain mention in SKILL.md)
- One PR per issue, no long-lived `sprint-{N}` branch / container PR
- No quota-aware spawn gating
- Promoter checks "PR comments" but doesn't enumerate the four GitHub
  surfaces (issue comments / review bodies / inline review threads /
  REST inline comments)
- Spawned nerd-snipe / sub-agents via `Agent({subagent_type: "..."})`
  rather than `mcx claude spawn` with the persona inlined

If you see <30% of these, the skill is probably mid-evolution and a
targeted patch is fine. If you see >70%, do a staged migration in the
buckets below — fixing them piecemeal misses the *interactions* that
make them load-bearing together.

## The diagnostic walk

Before proposing changes, do these reads (≤15 min total):

```bash
# 1. The skill itself
ls .claude/skills/sprint/references/
cat .claude/skills/sprint/SKILL.md
wc -l .claude/skills/sprint/references/*.md

# 2. What the orchestrator actually consults
grep -l "mcx claude wait\|mcx claude ls\|mcx phase\|mcx track\|mcx monitor" \
  .claude/skills/sprint/references/*.md
grep -l "TaskCreate\|addBlockedBy\|TaskList" \
  .claude/skills/sprint/references/*.md

# 3. Pipeline implementation surface
ls .mcx.yaml .claude/phases/*.ts 2>/dev/null    # absent → no phase scripts
ls .claude/sprints/.active 2>/dev/null          # absent → no sentinel guard

# 4. PR shape — sprint-N container model in use?
git branch -a | grep -E 'sprint-[0-9]+'         # one long-lived branch per sprint?
ls .claude/worktrees/ 2>/dev/null               # sprint worktree convention?

# 5. Recent diary tone — anecdotes accreting in skill text?
ls .claude/diary/ 2>/dev/null | tail -5
# Read one. If it lists "we burned X because of Y" and the rule sheet
# also cites that incident by sprint number, anti-anecdote rule isn't
# being applied.

# 6. Recent retros — are they producing concrete skill edits?
# A healthy retro has a "Changes to sprint skill" section with checkboxes.
# If the skill files haven't changed in N sprints, the retro is too shallow.
```

Map findings against the buckets below. Present buckets to the user;
let them choose the staging.

## Bucket S — pure docs / skill text

No infrastructure changes. Cost: ~2-3h. Validates via the next sprint.

| # | Pattern | Add to / create |
|---|---------|-----------------|
| 1 | **Investigations gate** for flaky / recurring / unclear-mechanism issues. Nerd-snipe (or equivalent) must post root-cause comment + concrete fix plan to the issue *before* impl. Hard fail to `needs-attention` if it can't. Stops "fix → re-break" cycles. | `references/investigations.md` (new); referenced from `plan.md` Step 3 classification + `run.md` impl spawn |
| 2 | **Compaction survival** — what survives compaction, what strips, the 5-command recovery sequence (`mcx claude ls`, `mcx tracked --json`, quota, `gh pr list`, sprint plan), how to re-pair sessions to work items. | `references/compaction-survival.md` (new) |
| 3 | **Reviewer self-repair (micro-repair)** — when a reviewer flags 1-3 contained findings with file:line + concrete fix descriptions, `send` the reviewer back to fix its own findings instead of spawning a fresh repair. Saves a full opus respawn + worktree warm-up. | `run.md` Orchestrator-only nudges section |
| 4 | **4-surface PR comment audit** before merge gate. GitHub PR comments live on four surfaces: PR body / inline (REST) / reviews / linked issue. Phase agents commonly check only the body. List the four `gh` commands; require explicit Addressed / Dismissed status per thread. | `run.md` Orchestrator-only nudges section |
| 5 | **Hot-shared file watch** — at plan time, identify picks that touch known dispatch tables / routers / registries (`main.ts`, `case "..."`: handlers, feature-flag maps). Two PRs editing the same dispatch will git-merge cleanly but lint-fail on main. Either serialize across batches or flag for a targeted rebase broadcast. | `plan.md` Step 4 |
| 6 | **Sweeping main commits broadcast** — when a commit lands on main mid-sprint that affects every branch (`.gitignore`, `.git-hooks/`, shared config), `send` a rebase directive to all active impl sessions before they push. Otherwise every branch looks like it regresses the change. | `run.md` |
| 7 | **Auto-merge re-arm after force-push** — `gh pr view $PR --json autoMergeRequest`; if `null`, re-arm with `mcx pr merge $PR --squash --auto`. Force-push silently invalidates auto-merge on some configurations. | `run.md` (or `promote.md` equivalent) |
| 8 | **Anti-anecdote rule** — rule + Why + How to apply only in the rule sheet; sprint-Z incidents go in the diary. Closed-fix anecdotes ("we used to do X until #N taught us") get evicted from active skill text once the underlying fix shipped. Keeps `references/*.md` scannable instead of growing into folklore. | `retro.md` |
| 9 | **Promote applied memories into skill text** — when a memory file has been applied 2+ sprints in a row, copy the rule + Why + How to apply into the most-relevant `references/*.md`. Skill-text rules apply even when memory hasn't been loaded. Memory files persist as user-memory injection until the skill change merges. | `retro.md` |
| 10 | **`references/omitted.md`** — log items deliberately *not* lifted from upstream sprint-skill evolution, with one-line rationale. Without this, every audit re-debates the same omissions. (E.g., a small private-repo project might omit author-trust filtering on the survey, but should record *that decision* so the next audit doesn't re-flag it.) | `references/omitted.md` (new) |

## Bucket M — leverages existing `mcx` CLI, no new infra files

Cost: ~4-6h. Replaces polling with push, adopts work-item state.

| # | Change | What it replaces | Why |
|---|--------|------------------|-----|
| 11 | **Push-event orchestration via the `Monitor` tool** with `mcx monitor --subscribe session,work_item --json` (filtered to load-bearing event types). Each ndjson line lands as an in-conversation notification; orchestrator reacts, no polling. Fallback for harnesses without `Monitor`: `mcx monitor … --max-events 1 --timeout 60` per tick from Bash. | `mcx claude wait --timeout NNNNN` polling | Monitor producers attach `cost`, `turns`, `lastTool`, `resultPreview`, `cascadeHead`, `allGreen`, `conclusions` directly to events. Polling forces a 5-lookup hydration loop per event (`log` + `pr view` + `api comments` + `api reviews` + `issue view`). At 15 sessions/sprint that's ~60 redundant tool calls per turn vs ~1. |
| 12 | **Sprint container PR + long-lived `sprint-{N}` branch** in its own worktree. Plan, mid-sprint amendments, run-time edits (timestamps, Excluded section), Results, retro diary, release commit (if any) all accumulate on this branch. Single draft PR opened at plan time, converted to ready at retro. | One PR per issue + ad-hoc release branches | Single watchable PR per sprint. Orchestrator never pushes to main (which the autoapprover blocks). Auto-classifier / GHA reviewers see the full sprint as one unit. |
| 13 | **Task-per-issue with `addBlockedBy` edges** — one `TaskCreate` per tracked issue (not per batch). Dependencies in the plan's Batch Plan section translate directly to `addBlockedBy`. Hot-shared file serializations are also `addBlockedBy` edges. | One Task per batch (3 tasks blocking 1→2→3) | Idle slots auto-pull the next *unblocked* issue instead of waiting for a batch tail. Sprint 41 burned multi-minute stretches with one active session under the batch model; sprint 42 fixed it by going issue-granular. |
| 14 | **Auto-chain mode** as the default — `/sprint` runs plan→run→review→retro inline in the same session. `/sprint run` becomes the explicit "stop at wind-down" variant. | Separate `/sprint review` + `/sprint retro` user invocations | Each fresh `/sprint review` invocation pays a full ~300k cache miss to re-read the sprint context the orchestrator already has. Auto-chain preserves it. |
| 15 | **Quota gating** — `mcx call _metrics quota_status` per tick. ≥80% utilization = impl freeze (finish in-flight review/QA, don't spawn new impl). ≥95% = full pause until reset. Don't block the sprint on a monitoring failure (treat unavailable quota as "proceed normally"). | No quota awareness | Avoids burning the 5-hour quota on a sprint that quota-throttles 30 minutes in and starves the rest. |
| 16 | **Send-not-bye discipline** — explicit table of "not reasons to bye" (asking a question, waiting on a dependency, pausing between subtasks, producing an unexpected result, being stuck). Before `bye`, write a one-sentence justification of why this work is conclusively complete. If you can't, `send` instead. | "Worker is idle → bye" reflex | Spawned sessions are running team members, not function calls. Respawning costs the worktree warm-up + all accumulated context for what's almost always answerable with one `send`. |

## Bucket L — heavier, requires new infra files

Cost: ~1-2 days. Best done after running 1-2 sprints with M-bucket
changes to get ergonomic feedback first.

| # | Change | Notes |
|---|--------|-------|
| 17 | **Phase scripts** (`.claude/phases/*.ts` declared by `.mcx.yaml`). One handler per phase (`impl`, `triage`, `review`, `repair`, `qa`, `done`, `needs-attention`), typed Zod input/output. Pipeline logic becomes declarative — `mcx phase run <name> --work-item <id>` returns `{action, target}`. Round caps baked in. Inspectable via `mcx phase show`/`run --dry-run`. **Starting template**: copy mcp-cli's `.mcx.yaml` + `.claude/phases/`, then edit spawn commands / providers / round caps to match the target project; delete phases that don't apply. |
| 18 | **`mcx track` / `mcx tracked --json` / `_work_items` for work-item state**. Auto-tracked by the phase scripts (`work_items_update` is called from `triage`, `review`, etc.). Schema is durable across compaction. Replaces sprint-plan-file inline editing for live state. **Do this with phases (#17) — phases auto-populate the tracked state, manual `mcx track`/`work_items_update` calls in `run.md` are a transitional wart.** |
| 19 | **Sprint-active sentinel** — `.claude/sprints/.active` (gitignored) contains the current sprint number. Pre-commit hook on the main checkout rejects commits while the sentinel is present (requires `SPRINT_OVERRIDE=1` for orchestrator commits). Catches workers that escape their worktree and try to commit on main. Plan creates it; retro removes it. |
| 20 | **Meta-file discipline** — workers must not modify `.claude/skills/**`, `.claude/memory/**`, `CLAUDE.md`, `.gitignore`, phase scripts, or `.mcx.yaml` mid-sprint (orchestrator reads them live). Plan-time Step 1a reviews pending `meta`-labeled issues with the user; approved ones are applied via short-lived `meta/<descriptor>` branches *between* sprints. If a worker's PR needs a meta change, `send` the worker to revert and file a new `meta` issue. |
| 21 | **Introspection cadence** — sprints whose number ends in 7 spawn one Explore agent during retro for a code-first audit (mega-files, copy-paste duplicates, silent error swallowing, defensive workarounds, coverage gaps, stale skill text, half-wired features, latency hotspots, skill drift). Findings feed the *next* sprint's plan as Bucket-1 candidates. Caught structural drift mcp-cli's per-sprint review missed. |

## Skipped on purpose (project-specific)

These showed up in the audit but are *correctly* omitted depending on
project shape — don't push them as universal:

- **Multi-provider routing** (`Provider` column → `mcx copilot` / `mcx
  gemini` / `mcx acp`). Useful when you've actually qualified non-Claude
  providers for the project's worker shape; otherwise it's premature.
- **Versioned releases + tag-at-merged-sha**. If the project doesn't
  ship a versioned artifact (deployed app, internal tool, etc.), the
  release commit + tagging steps in `review.md` should be deleted, not
  carried forward as a no-op.
- **Author-trust filter** at survey time (`gh issue list --author
  <owner>`). Defends against attacker-controlled spawn prompts on
  public repos. Private repos with a trusted contributor set may
  reasonably skip this — but record the skip in `references/omitted.md`
  with the rationale (so the next audit doesn't re-flag it).
- **GHA bot routing in promoter** (Copilot / CodeRabbit / Codex). Only
  add the surfaces the project's CI actually uses.

## Presentation pattern

When auditing a target skill, present findings to the user as:

1. **Diagnostic summary** — which sprint era the skill looks like (~30,
   ~40, ~50), with 3-5 receipts from the diagnostic walk
2. **Bucket table** — S / M / L with item counts and "what each
   unlocks" in one line
3. **Recommended split** — which buckets to do in this PR vs follow-ups,
   with rationale
4. **Skipped-on-purpose candidates** — items the user should explicitly
   accept or reject, with the rationale that they go in
   `references/omitted.md` either way

Don't propose "fix everything in one PR" — the M and L buckets benefit
from sprint-cycle feedback before being further iterated. Don't propose
"start with bootstrap-sprint from scratch" either — a project with N
sprints of history has project-specific learnings baked in that a
fresh bootstrap would generic-ify away. Migration > rebuild.

## See also

- `references/discovery.md` — initial bootstrap discovery (different
  audience: writing a skill from scratch)
- `references/iteration.md` — the per-sprint feedback loop that is
  *supposed* to keep skills from drifting to sprint-30-era in the first
  place. If a project's skill drifted anyway, item #20 in Bucket L
  (meta-file discipline) and item #8 in Bucket S (anti-anecdote rule)
  are the load-bearing reasons; lift those first.
- `references/lessons.md` — generalized lessons from mcp-cli sprints
  1-22. Most still apply; the buckets here are the *additional* lessons
  from sprints 23-52.
