# Compaction Survival Guide

Sprints run for hours and easily exceed 200k tokens before they finish.
Compaction summarizes everything before a checkpoint into a paragraph and
keeps recent turns + tool calls verbatim. The orchestrator survives
compaction reliably *if* it knows what compaction strips and how to
re-derive what it needs from durable state.

This guide assumes the orchestrator already loaded the `sprint` skill
(SKILL.md routed it to `run.md`) and the user said "pick back up" /
"continue" / sent another monitor event after compaction fired.

## What survives compaction

These are durable across compaction because they live outside the chat:

- **Sprint plan file** — `.claude/sprints/sprint-{N}.md`. The Issues table
  + Batch Plan + Hot-shared file watch + Pre-sprint meta-fixes + Retro
  notes are all there. Read it first if anything feels off.
- **Active sessions** — `mcx claude ls --short`. Source of truth for
  who's running, what model, and (idle/active) state. Names like
  Alice/Bob/Carol/etc. are display labels assigned at spawn — don't rely
  on them surviving (a bye + respawn rotates names).
- **Tracked work items** — `mcx tracked --json` returns the array of
  `{id, issueNumber, branch, prNumber, prState, ciStatus, mergeStateStatus,
  phase, ...}`. **Schema reminder: top-level is an array, items use `.id`
  ("#1922"), not `.workItem` or `.items[]`.** That `.id` form bites every
  time post-compaction; jq with the wrong field returns `[]` and you
  think nothing's tracked.
- **Phase state per work item** — `mcx call _work_items work_items_get
  '{"id":"#N"}'` and `mcx call _work_items phase_state_get
  '{"workItemId":"#N","key":"session_id"}'`. Phase scripts wrote
  `session_id`, `qa_session_id`, `review_session_id`, `repair_session_id`,
  `worktree_path` etc. there.
- **Monitor task** — the persistent `bkqklwlpx`-style task started at
  sprint open. `TaskList` shows it; new events keep arriving as
  notifications. Don't start a second one — duplicate streams burn cache
  with no gain.
- **TaskList** — TodoWrite items per issue, with metadata (impl_session,
  qa_session, pr, phase). Compaction does not strip TaskList state.
- **Sprint worktree** — `.claude/worktrees/sprint-{N}/`. All sprint-meta
  commits accumulated there. Plan amendments, retro notes, release
  commit if any.
- **Sprint container PR** — `gh pr list --search "sprint:{N} in:title"`.
  Draft until retro; carries every sprint-meta commit.
- **Sentinel** — `.claude/sprints/.active` contains the sprint number;
  retro removes it.
- **MEMORY.md + CLAUDE.md** — re-loaded on every turn anyway.
- **Open PRs + their CI/labels/comments** — `gh pr view <n> --json ...`.
  Cheap to re-derive any time.

## What compaction strips

These get summarized and may need re-derivation:

- **Per-session "what they're working on right now"** — the worker's last
  prompt, current sub-task, and intermediate findings. The session log
  has it (`mcx claude log <id> --tail 20`); the conversation does not.
- **Tool schemas you haven't used recently** — deferred tools' detailed
  schemas. `ToolSearch` re-fetches them. Common offenders post-compaction:
  `TaskUpdate`, `TaskGet`, `PushNotification`, `WebFetch`.
- **Recent gh/Bash output that hasn't been re-summarized** — e.g. a PR's
  comment thread you just read but didn't act on. Re-fetch before
  dispatching to a worker.
- **Worker session names → owner mapping**. Re-derive from
  `mcx claude ls --short`; the displayed name may have changed if a
  session was bye'd and respawned.

## Five-command recovery sequence

Run these the moment "pick back up" or post-compaction continuation lands:

```bash
# 1. What sessions are alive, and in what state?
mcx claude ls --short

# 2. What's tracked, what phase is each item in, what PRs?
mcx tracked --json | jq 'map({id, issueNumber, prNumber, phase, prState, ciStatus, mergeStateStatus})'

# 3. Quota check (note: this can be stale — see Diary 2026-04-30 #1)
mcx call _metrics quota_status

# 4. Open PRs at a glance
gh pr list --json number,title,labels,mergeStateStatus,headRefName --jq '[.[] | {n: .number, ms: .mergeStateStatus, labels: [.labels[].name], branch: .headRefName}]'

# 5. Sprint plan (truth for what was attempted)
cat .claude/sprints/sprint-{N}.md
```

Together these reconstruct the entire sprint state in ~5 seconds.

## Re-pairing sessions to work items

Compaction may erase the mental model of "session X owns work item #Y".
Two ways to recover:

- **TaskList metadata** — `TaskList` (TodoWrite list) entries have
  `metadata.impl_session`, `metadata.qa_session`, `metadata.review_session`.
  Cross-reference against `mcx claude ls`.
- **Phase state** — `mcx call _work_items phase_state_get '{"workItemId":"#N","key":"session_id"}'` returns the canonical session for the
  current phase. `qa_session_id` / `review_session_id` / `repair_session_id`
  for the side phases.

If both diverge, the **phase state is canonical** — it's what `mcx phase
run <phase>` consults. Update TaskList metadata to match.

## Re-pairing PRs to work items

`mcx tracked --json` already includes `prNumber`. If a new PR was opened
post-compaction and the work item still has `prNumber: null`:

```bash
# Search by branch or issue ref in title
gh pr list --search "1856 in:title" --json number,headRefName --limit 3
mcx call _work_items work_items_update '{"id":"#1856","prNumber":1957,"branch":"<branch>"}'
```

The phase scripts populate `branch` from `prNumber` if you omit it, but
passing both saves a network round-trip.

## Don't re-spawn what's already in flight

Before re-launching anything, **read the Monitor stream's recent events**
or pull the per-session log:

```bash
mcx claude log <session-id> --tail 5
```

A session that was idle when compaction hit may have been mid-fix; if
you re-spawn instead of `send`-ing, you waste the prior context and
likely produce a divergent fix. The runbook's "send not bye, when in
doubt" rule applies double post-compaction.

## Compaction-induced process violations to watch for

Each of these has bitten in past sprints; check yourself before acting:

- **Premature `bye`** on idle workers whose PR is still open / CI is still
  running / QA hasn't voted. Compaction may have stripped the mental note
  "this session needs to stay alive for the Copilot tail thread."
- **Re-spawning workers** instead of `send`-ing because you forgot the
  existing session's context.
- **Re-ticking impl** when the work item is already past impl, because
  `mcx phase run impl --work-item '#N'` returned `in-flight` and you
  thought "the previous orchestrator did this." Check `phase` field
  in `mcx tracked --json` first.
- **Skipping the worktree-is-modified safety net** when bye-ing a session
  whose worktree contains uncommitted work (often `.mcx.lock` regen, or
  staged copies of merged-elsewhere files). The bye command refuses; let
  it. Inspect with `git status -s`, then `git checkout -- <path>` or
  `git stash -u`, then bye again.

## Compaction itself: when to opt in

Mid-sprint compaction is a deliberate trade. The user invoked
`/compact` in sprint 50 around the 200k mark; cost was one schema
lookup (`mcx tracked --json` field name). Net positive — keep doing it
when context bloat starts impacting reasoning latency.

Don't compact:

- **Right after a PR merge** — phase state is in flux for ~30s while
  poller events settle. Wait for the resync to finish.
- **Mid-fix-dispatch** — a `send` to a worker whose Copilot finding you
  just read is the brittlest point; if compaction strips the comment
  text before the send goes out, you lose the diagnosis.
- **Right before a known-bursty event** (auto-merge expected within a
  minute, multiple PRs about to come back from Copilot at once).

Otherwise, opt in. The cost is low; the headroom is large.

## See also

- `references/run.md` — the orchestrator loop itself
- `.claude/memory/feedback_context_rot.md` — long-running orchestrators
  degrade at ~300k tokens; compaction is one of the answers, "verify
  done claims with a probe" is another
- Diary 2026-04-30 (sprint 50) — the trial run that motivated this guide
