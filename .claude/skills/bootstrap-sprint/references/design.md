# Design

You've explored the project. You and the user are aligned on how it works. Now
design the sprint skill.

## The universal architecture

Every sprint skill has the same skeleton, regardless of project:

```
.claude/skills/sprint/
  SKILL.md                         # Router: dispatches /sprint variants;
                                   # /sprint auto-chains plan→run→review→retro
                                   # by default; /sprint run is run-only
  references/
    plan.md                        # Survey board, classify, batch, write sprint file
    run.md                         # Pre-flight + push-event orchestration loop
    review.md                      # Release: gather what shipped, cut version, tag
    retro.md                       # Diary: write retrospective, audit memory, prune
    mcx-claude.md                  # Session management command reference
    investigations.md              # Nerd-snipe gate for flaky / unclear-mechanism issues
    compaction-survival.md         # What survives compaction; recovery sequence
    introspection.md               # Sprints-ending-in-7: code-first audit cadence
```

This is the **standard set** — every project that runs more than a few sprints
needs all of it. The temptation is to start with the bare minimum (SKILL +
plan + run + review) and add the rest "when needed." Don't. The patterns the
extra files codify (compaction recovery, the nerd-snipe gate, the diary/release
split) were extracted from incidents that recur in every project, not from
mcp-cli specifics. Generating them up front costs ~30 minutes; rediscovering
them through outages costs sprints.

Optional additions: `gates.md` if the project has >3 distinct promotion gates
beyond CI/tests/review (rare). Strip pieces that genuinely don't apply (e.g.
delete the release-versioning steps in `review.md` if the project doesn't ship
versioned artifacts), but record the omission in `references/omitted.md` with
a one-line rationale so the next audit doesn't re-flag it.

## What varies between projects

### The pipeline shape

The pipeline is the sequence of phases an issue goes through from "selected" to "done."
It's the most important thing you'll design, and it's different for every project.

**Simple pipeline** (fast CI, Claude merges, low risk):
```
implement → verify tests pass → merge
```

**Medium pipeline** (CI + review, human merges):
```
implement → wait for CI → local review → push → wait for GHA review → fix findings → promote to ready → human merges
```

**Full pipeline** (high-risk deploy, multiple review rounds):
```
implement → triage complexity → adversarial review → repair → QA verification → promote → human merges → monitor deploy
```

Design the pipeline that matches the project's definition of done. Don't import
phases from other projects that don't apply. Don't skip phases that the project needs.

**The critical design question**: after the orchestrator spawns an implementation
session and it completes, what happens next? If the answer is "report to user and
wait" — the orchestrator will stall. There must be autonomous work between
implementation and the human gate. That's what keeps the sprint running.

### Core architectural primitives (not optional)

Three patterns are load-bearing across every sprint skill that ran past sprint 30
on this codebase. Bake them in from the start — they were "upgrade buckets" in the
legacy `references/upgrading-30-50.md` doc precisely because retrofitting them
costs more than designing them in.

**1. Push-event orchestration via `mcx monitor` (not `mcx claude wait` polling).**
The orchestrator opens a single long-lived event stream at sprint start via the
Claude Code `Monitor` tool:

```bash
mcx monitor --subscribe session,work_item --json
```

Each ndjson line lands as an in-conversation notification. Event payloads are
pre-enriched by the producers (`cost`, `turns`, `lastTool`, `resultPreview`,
`cascadeHead`, `allGreen`, per-check `conclusions`, etc.) so a tick rarely needs
a follow-up `mcx claude log` or `gh pr view`. Acting on `mcx claude wait` lines
forces a 5-lookup hydration loop per event; the monitor stream collapses that to
~1 lookup (the action). At 15 sessions/sprint this is the difference between
~60 redundant tool calls per turn and ~1.

`mcx claude wait` is **legacy** — keep it documented in `mcx-claude.md` for
one-off interactive human use, but the orchestrator's main loop must not call it.

**2. Sprint container PR + long-lived `sprint-{N}` branch.**
Every sprint opens one draft PR at plan time on a `sprint-{N}` branch in its own
worktree (`.claude/worktrees/sprint-{N}/`). All sprint-meta commits accumulate
on that branch: the plan, mid-sprint amendments, run-time edits (Started/Ended
timestamps, Excluded section), the Results table, the retro diary, and the
release commit (if any). At retro time the PR converts from draft to ready and
auto-merges as one squash commit. Tag the release at the merged sha.

This replaces the older "one PR per issue + ad-hoc `release/vX.Y.Z` branches"
shape. Benefits: one watchable PR per sprint, the orchestrator never pushes
directly to main (which `auto-approver`-style guards block), the auto-classifier
sees the full sprint as one unit, and post-merge sweep is a single delete-branch.

**3. Task-per-issue with `addBlockedBy` edges (not task-per-batch).**
When the planner groups N issues into M batches, the temptation is to mirror
that as M `TaskCreate` items with Batch 2 blocked by Batch 1. **Don't.** Create
one Task per *issue* with explicit `addBlockedBy` edges for cross-issue
dependencies (file conflicts, ordering requirements, hot-shared-file
serializations). Batch-level tasks serialize idle slots — the orchestrator
waits for "Batch 2 to finish before starting Batch 3" instead of pulling the
next unblocked issue. Issue-granular tasks let the dependency graph drain
naturally and peak concurrency stays high.

This rule lives in the generated `run.md`, not just in retro learnings, because
every sprint forgets it otherwise — the visual clarity of "3 batches" pulls the
orchestrator back toward the wrong abstraction unless the skill explicitly
forbids it.

### Quota gating (also not optional)

Claude's 5-hour usage quota throttles sessions when it fills up. A sprint that
saturates the quota 30 minutes in starves the rest. Bake in a per-tick check:

```bash
mcx call _metrics quota_status
```

| Utilization | Action |
|---|---|
| **< 80%** | Normal — spawn impl, review, QA freely |
| **≥ 80%** | **Impl freeze** — finish in-flight review/QA, don't spawn new impl |
| **≥ 95%** | **Full pause** — wait for reset |

If the call fails or `available: false`, proceed normally — don't block the
sprint on a monitoring failure.

### The declarative phase graph (`.mcx.yaml` + `.claude/phases/*.ts`)

The pipeline shape above is a concept. The *artifact* is the `.mcx.yaml` manifest
at the repo root plus one `defineAlias` script per phase under `.claude/phases/`.
This is the proven pattern — sprint 36 on mcp-cli ran entirely through this
format, and `docs/phases.md` in the mcp-cli repo is the authoritative schema
reference. Generate these files during bootstrap; don't leave the pipeline as
prose-only instructions in `run.md`.

**`.mcx.yaml`** declares phases and legal transitions:

```yaml
version: 1
runsOn: main
initial: impl
state:
  session_id: string?
  review_round: number?
  # ...declare per-work-item scratchpad keys here
phases:
  impl:
    source: ./.claude/phases/impl.ts
    next: [triage]
  triage:
    source: ./.claude/phases/triage.ts
    next: [review, qa]
  review:
    source: ./.claude/phases/review.ts
    next: [repair, qa]
  repair:
    source: ./.claude/phases/repair.ts
    next: [review, qa, needs-attention]
  qa:
    source: ./.claude/phases/qa.ts
    next: [done, repair, needs-attention]
  done:
    source: ./.claude/phases/done.ts
    next: []
  needs-attention:
    source: ./.claude/phases/needs-attention.ts
    next: []
```

**Each phase is a `defineAlias` script** with typed Zod input/output. The `fn`
handler runs when a work item enters the phase; its return shape depends on
what kind of phase it is. In mcp-cli's pipeline, phases fall into two
categories:

- **Session-driving phases** (impl, review, repair, qa) return a tagged
  `action` union that the orchestrator's main loop dispatches on:
  ```typescript
  { action: "spawn",     command: [...], prompt, model, ... }  // run the spawn
  { action: "in-flight", sessionId, ... }                       // session already running; do nothing
  { action: "wait",      reason }                               // back off; re-enter later
  { action: "goto",      target, reason }                       // transition to a neighbour phase
  ```
  `in-flight` is what a handler returns on re-entry when it already spawned a
  session and just hasn't observed its completion yet — treat it as
  equivalent to `wait` for loop control.
- **Compute / terminal phases** (triage, done, needs-attention) return
  **domain outputs** instead — the orchestrator special-cases them. Triage
  returns `{ scrutiny, decision, reasons, prNumber }` and the loop reads
  `decision` to pick the next phase. Done returns `{ merged, prNumber,
  error? }` and closes the work item. Needs-attention records escalation
  metadata and halts the item. None of these need the action union because
  they don't spawn sessions or re-enter themselves.

The action union is a convention for session-driving phases, not a contract
enforced by `mcx phase`. Design your phase's output schema for how the
orchestrator will consume it.

```typescript
// .claude/phases/impl.ts — a session-driving phase.
import { defineAlias, z } from "mcp-cli";

defineAlias({
  name: "phase-impl",
  description: "Sprint phase: spawn implementation session.",
  input: z.object({
    provider: z.enum(["claude", "copilot", "gemini"]).default("claude"),
    labels: z.array(z.string()).default([]),
  }),
  output: z.object({
    action: z.enum(["spawn", "in-flight"]),
    command: z.array(z.string()),
    prompt: z.string(),
    sessionId: z.string().optional(),
    // ...
  }),
  fn: async (input, ctx) => {
    const work = ctx.workItem;  // { id, issueNumber, prNumber, branch, phase }
    // If session_id already set → return { action: "in-flight", sessionId }
    // Else build spawn plan, write pending sentinel → return { action: "spawn", ... }
  },
});
```

**After authoring or editing phase scripts, run `mcx phase install`** to generate
`.mcx.lock`. The lock pins every source by content hash so the orchestrator can
detect drift between the committed graph and what's on disk. `mcx phase list`
and `mcx phase show <name>` validate that phases resolve cleanly before the
first sprint.

Starting template: copy `.mcx.yaml` and the seven scripts in `.claude/phases/`
from mcp-cli itself as the default graph, then edit the spawn commands to
match the target project's slash commands and provider list. Run `mcx phase
install` after edits. See `docs/phases.md` (in the mcp-cli repo) for the full
schema, source-URI formats, and the phase handler API.

**Why this matters.** A phase graph declared in YAML + TypeScript is
machine-readable: the orchestrator can ask "what transitions are legal from
`review`?" without re-reading a markdown file and guessing. Transitions are
logged to `.mcx/transitions.jsonl`. Rounds, scratchpad keys, and state
machines become code with types — not prose the orchestrator interprets. The
markdown `run.md` still exists, but its job shrinks: it documents how the
orchestrator *uses* the phase graph (pre-flight checks, the main loop, stop
conditions), not what the graph *is*.

### The planning phase

This varies based on issue quality:

- **Well-specified issues** (Claude-filed, acceptance criteria, bounded scope):
  Plan is just "pick and batch." Light touch.
- **Mixed quality** (some good, some vague):
  Plan needs a triage step — assess each issue, break down the vague ones using
  whatever story-refinement tool the project has.
- **Mostly vague** (human-filed feature requests, epics without subtasks):
  Plan needs to be aggressive — the planner is a product manager, not just a picker.
  It reads each issue, asks whether it's actionable, and breaks it down before
  including it. This may require back-and-forth with the user.

**Author trust filter (security).** The sprint pipeline spawns worker sessions
whose prompts are derived from issue bodies. On a public repo, issue bodies are
attacker-controllable — anyone with a GitHub account can file an issue with
embedded prompt-injection or social-engineering text. The planning phase must
filter on `author.login` at survey time, not at spawn time:

```bash
gh issue list --state open --author <trusted-owner> --json number,title,labels,body,author --limit 200
```

Issues filed by `Copilot`, agent personas, drive-by accounts, or anyone outside
the trusted set are **excluded** regardless of label or content. Bake this into
the generated `plan.md` for any project whose repo is public or accepts
external issue submissions. Private repos with a closed contributor set may
reasonably skip the filter — but record that decision in `references/omitted.md`
with the rationale, so the next audit doesn't re-flag it.

### The qualify phase

This is where projects diverge most. Map the project's actual quality gates:

| Gate | How to check | How to fix |
|------|-------------|-----------|
| CI passes | `gh pr checks` (or the `ci.finished` event's `allGreen`) | Spawn repair session |
| Tests pass | Project's test command | Spawn repair session |
| Screenshots (UI projects) | Check PR body for images | Spawn capture session |
| Code review (GHA bot) | Read review comments | Spawn fix session |
| Code review (human) | Can't automate — this is the human gate | |
| Security scan | Check CI status | Spawn fix session |
| Perf benchmark | Check CI status | Spawn fix or flag for human |

Only include gates that actually exist in the project. Don't invent gates.

**Enumerate every comment surface, not just the obvious one.** GitHub PRs
surface comments on **four** distinct API endpoints, and QA agents that check
only one routinely ship PRs with unresolved threads:

```bash
gh pr view $PR --comments                                     # 1: PR body
gh api repos/<o>/<r>/pulls/$PR/comments --jq '...'            # 2: inline file:line (Copilot lives here)
gh api repos/<o>/<r>/pulls/$PR/reviews  --jq '...'            # 3: review containers (APPROVED / CHANGES_REQUESTED)
gh issue view $ISSUE --comments                               # 4: linked issue
```

Before transitioning to `done`, every open thread on every surface must be
either **Addressed** (code/doc fix + a reply citing the fix commit) or
**Dismissed** (explicit out-of-scope reply). No silent skips. This belongs in
the generated `run.md`'s orchestrator-only nudges section — phase agents
shouldn't be relied on to do it.

### Concurrency

This is constrained by the project, not by ambition:

- **Worktree overhead**: git-crypt repos, large node_modules, DB copies all limit concurrency
- **Port conflicts**: web apps that bind fixed ports can't run multiple dev servers
- **CI runners**: some projects share limited CI resources
- **Cost**: more sessions = more spend

Start conservative. 3 slots for complex projects, 5 for simple ones. Increase if
sprint 1 shows headroom.

### The merge gate

Some projects let Claude merge. Most shouldn't, especially at first. The merge gate
determines whether the sprint can fully close issues autonomously or whether it parks
at "ready for review" and waits for a human.

If there's a human merge gate, the orchestrator needs a **monitor phase** — it
watches promoted PRs for new review comments and handles them. Without this, the
sprint produces draft PRs and then the orchestrator has nothing to do while
waiting for the human. That's how stalls happen.

**Use `mcx pr merge` as the canonical merge command** in phase scripts. It wraps
`gh pr merge` with the re-arm-after-force-push behaviour, surfaces failures to
the daemon's event stream as `pr.merge_state_changed`, and exposes the merge
outcome to the work-item state. `gh pr merge --auto` silently fails on some
branch-protection configurations and gives the orchestrator nothing to react to.

**Verify the merge actually fired.** `mcx pr merge --auto` queues the merge;
it does not perform it. Before transitioning a work item to `done`, poll
`gh pr view <n> --json state,mergedAt -q '.state + " " + (.mergedAt // "null")'`
until it returns `MERGED <iso-timestamp>`. The QA verdict is local; the merge
is remote. Sprints that ship 10+ PRs in parallel hit this routinely — sibling
rebases, branch protection re-evaluation, and label changes can all invalidate
a queued auto-merge between "queued" and "merged."

### Branch protection: avoid strict-up-to-date, lean on main-CI

Whatever branch protection / ruleset governs main, **strict-up-to-date must
be off**. On GitHub, that's `strict_required_status_checks_policy: false` on
the required-status-checks rule of the ruleset that targets main. The strict
policy creates an N² rebase cascade on any sprint that ships >5 parallel PRs:
each merge invalidates every other PR's up-to-date status, and the
orchestrator collapses into a serialized loop calling `update-branch` +
waiting for CI + merging, one PR at a time. Sprint 38 on mcp-cli paid for an
hour of that before flipping the rule; the 11 queued PRs merged in under a
minute after the flip.

What replaces strict-up-to-date:

1. **`addBlockedBy` edges on hot-shared files at planning time.** Picks that
   touch a dispatch table / router / registry / feature-flag map serialize
   through the dependency graph — second PR rebases naturally after the
   first merges. Most PRs don't need this; only the hot-shared subset does.
   See lesson #32 in `lessons.md` for the task-list shape.
2. **Main-CI as the post-merge canary.** If a merge cluster lands and main
   goes red, the release gate (explicit `/release` at sprint boundary,
   refusing to tag if main-CI is red) is the backstop.

Avoid the "mergemaster" anti-pattern. mcp-cli briefly ran a long-lived sonnet
session that polled `gh pr update-branch --rebase` + CI + auto-merge as PRs
hit `qa:pass`, on the theory that User-owned repos without merge queue
needed an orchestrator-side substitute. It worked, but it papered over the
underlying mistake — the strict policy itself. The agent was retired in
sprint 41 (commit `f952eae`, closes #1866) once the simpler fix was in
place. If you find yourself reaching for an orchestrator-side merge
shepherd, you're almost certainly fixing the wrong layer.

GitHub's native merge queue is **org-only** (Team or Enterprise Cloud) and
does not appear in the UI on User-owned repos at any tier. Check `gh api
users/<owner> --jq .type` during discovery. It's nice to have for very-high-
throughput orgs but not necessary — relaxed strict + planning-time
serialization-by-exception keeps throughput high without the dependency.

## What to produce

You're writing two things: **markdown** that instructs the Claude orchestrator
(SKILL.md + the 8 references listed in "The universal architecture" above) and
the **declarative phase graph** that formalises the pipeline (`.mcx.yaml` +
`.claude/phases/*.ts`). The markdown teaches intent; the phase graph is the
executable contract the orchestrator drives.

### The phase graph (`.mcx.yaml` + `.claude/phases/*.ts`)

See "The declarative phase graph" above for the schema. Concretely, generate:

- `.mcx.yaml` at the repo root declaring `version`, `runsOn`, `initial`,
  `state` keys, and the `phases` map with `source` + `next` per phase
- One TypeScript file per phase under `.claude/phases/` using `defineAlias`
  from `mcp-cli`, with typed Zod `input` / `output` schemas and a handler
  whose output matches what the orchestrator expects for that phase:
  session-driving phases typically return the `spawn | in-flight | wait |
  goto` action union; compute/terminal phases (triage, done,
  needs-attention) return domain outputs the orchestrator special-cases
- `.mcx.lock` generated by `mcx phase install` (never edit by hand; commit it)

The starting template is mcp-cli's own `.claude/phases/` directory —
copy the seven scripts (impl, triage, review, repair, qa, done,
needs-attention), edit the spawn commands to match the target project's slash
commands, adjust provider lists, and delete phases that don't apply. Then run
`mcx phase install` and `mcx phase list` to verify.

### The sprint router (SKILL.md)

Routes `/sprint`, `/sprint plan`, `/sprint run`, `/sprint review`, `/sprint
retro`, `/sprint <N>` (where `N` matches an existing sprint plan file), and
`/sprint <issue-numbers>` (ad-hoc issue runs). Auto-chains plan→run→review→
retro by default; `/sprint run` is the explicit "stop at wind-down" variant.
Auto-chain matters: each separate `/sprint review` invocation pays a full
~300k-token cache miss to re-read sprint context the orchestrator already has.

Include project-specific rules that apply to all phases (concurrency limit,
merge policy, cost threshold, "never implement directly").

### The plan reference (plan.md)

How to survey the backlog, assess issue quality, break down what needs breaking
down, batch issues to avoid conflicts, and write a sprint file. Include the
specific commands for this project's issue tracker and board.

### The run reference (run.md)

This is the big one. It contains:

1. **Pre-flight checks** — what to verify before spawning anything
2. **How the phase graph works** — summary of the `.mcx.yaml` pipeline and
   how to invoke it (`mcx phase run <name> --work-item "#N"`). The authoritative
   phase logic lives in `.claude/phases/*.ts`, not in this document.
3. **The main loop** — pseudocode for the orchestrator's event loop.
   Session-driving phases: dispatch on `action` (`spawn` runs the command;
   `in-flight` and `wait` leave the item idle; `goto` transitions to
   `target`). Compute / terminal phases (triage, done, needs-attention):
   read the domain output (`done.error`, `needs-attention.reason`, etc.)
   and take the special-cased next step rather than treating the output as
   an action. Record every transition, then iterate. (Triage was once an
   example of a `decision`-style domain output, but as of mcx #1832 it
   uses the standard `action`/`target` schema like other session-driving
   phases.)
4. **State tracking** — how and where to persist issue/session/PR state. Most
   per-work-item state lives in the phase scratchpad declared in `.mcx.yaml`
   under `state:` and accessed via `ctx.state`.
5. **Key rules** — the hard-won lessons (verify push before bye, don't restart
   daemon mid-batch, etc.)
6. **Stop conditions** — when to halt and report

Write the spawn commands verbatim inside the phase handlers, not in `run.md`.
The handler returns the exact `command`, `--allow` flags, model, and worktree
flags; the orchestrator executes them without interpretation. `run.md`
documents how to *drive* the graph, not what the graph *is*.

### The session management reference (mcx-claude.md)

The orchestrator leans heavily on `mcx claude` commands for session management.
The canonical reference is maintained at:
https://github.com/theshadow27/mcp-cli/blob/main/.claude/skills/sprint/references/mcx-claude.md

Fetch the latest version and adapt it for the target project. Strip commands that
don't apply (provider routing, ACP), add any project-specific flags or worktree
hooks. The orchestrator should never have to guess at command syntax — every spawn,
wait, bye, and ls command should be spelled out with exact flags.

**Always include the "Session Scoping" section** when generating an mcx-claude.md for a
new project. Session scoping is a non-obvious feature that trips up orchestrators running
concurrent sprints:

- `mcx claude ls` and `mcx claude wait` filter to the **current repo's git root** by default
- `--all` bypasses the filter and shows sessions from every repo
- Registered scopes (`mcx scope init`) take precedence over git root detection
- All sprint orchestrator commands must be run from within the project root — otherwise
  sessions appear missing even though they're actively running
- When two sprints run in parallel across different repos, each orchestrator only sees its
  own sessions; this is intentional isolation, not a bug

The generated mcx-claude.md should include the "Diagnosing 'missing' sessions" checklist
so orchestrators can self-diagnose when `mcx claude ls` shows nothing unexpected.

### The review reference (review.md)

The release phase. Gather what shipped (`git log <last-tag>..HEAD`), determine
the semver bump, write release notes, add the release commit to the sprint
container branch, append the Results section to the sprint plan file. The
actual merge + tag happens in `retro.md` after the diary lands — review.md
only stages the release commit on the sprint branch.

### The retro reference (retro.md)

The diary phase. Separate from review because diary writing benefits from
fresh context (just-shipped sprint), while release notes can ride on top of
existing run-time observation. retro.md covers:

1. Write the diary entry at `.claude/diary/yyyyMMdd.{N}.md` (project-specific
   path may differ) using the standard template (What was done / What worked /
   What didn't / Patterns established / Stats).
2. **Sweep uncommitted memory updates** from the orchestrator's main checkout
   into the sprint worktree — memory files routinely get written in the main
   checkout where the orchestrator runs, not the sprint worktree, and leak
   otherwise.
3. **Audit memory for staleness** via `mcx memory audit --json`; prune
   candidates the user agrees with.
4. **Promote applied memories into skill text** — when a memory file has been
   applied 2+ sprints in a row, copy the rule + Why + How-to-apply into the
   most-relevant `references/*.md`. Skill-text rules apply even when memory
   hasn't been loaded.
5. **Commit the diary on the sprint branch**, convert the sprint PR draft → ready,
   arm auto-merge, wait for `state == MERGED`, then tag the release at the
   merged sha (if a release was cut).
6. **Clear the sprint-active sentinel** (`.claude/sprints/.active`) and remove
   the sprint worktree.

The **anti-anecdote rule** lives here: every rule in the skill text has a
generalised Why + How-to-apply; incidents (sprint Z burned X because of Y) go
in the diary, not in the active rule sheet.

### The investigations reference (investigations.md)

The nerd-snipe gate for flaky tests, recurring bugs, deterministic failures
with unclear mechanism, perf regressions without an obvious patch, and security
findings. Required even for projects that "don't have flaky tests yet" —
they will, and the gate prevents the fix-then-rebreak cycle that swallows
sprints (mcp-cli's sprints 15-19, 47, 50, 51, 52 all hit it before the gate
was codified).

The gate is hard-fail: if the investigator can't produce both a root cause
and a concrete fix plan as a GitHub issue comment, the issue does **not**
proceed to implementation — it goes to `needs-attention`. No "spawn opus and
hope." Use `mcx claude spawn` with the persona inlined, **not** the Agent
tool / `subagent_type` — Agent-tool sub-contexts give the orchestrator no
progress visibility, and sprint 52 lost two slots before this was nailed down
(see #2009 in the mcp-cli repo).

### The compaction-survival reference (compaction-survival.md)

Sprints exceed 200k tokens routinely; compaction will fire. List what survives
(sprint plan file, `mcx tracked --json`, phase state, the Monitor task, TaskList
metadata, the sprint worktree, the sprint container PR, the sentinel), what
strips (per-session "what they're working on right now", deferred tool schemas,
recent unread gh output, session-name → owner mapping), and the 5-command
recovery sequence:

```bash
mcx claude ls --short
mcx tracked --json | jq 'map({id, issueNumber, prNumber, phase, prState, ciStatus, mergeStateStatus})'
mcx call _metrics quota_status
gh pr list --json number,title,labels,mergeStateStatus,headRefName
cat .claude/sprints/sprint-{N}.md
```

Include the schema reminders that bite every time (`mcx tracked --json` is an
array, items use `.id` not `.workItem`).

### The introspection reference (introspection.md)

Cadence for code-first introspection: sprints whose number ends in 7 (17, 27,
37, 47, 57, 67…). Spawn one Explore agent with a high-thoroughness prompt that
**does NOT trust** CLAUDE.md / README / skill docs / issue bodies / PR
descriptions — only the actual source, phase scripts, test files, coverage
config, and recent merged commits. Look for: mega-files, copy-paste duplicates,
silent error swallowing, defensive workarounds with "until X lands" comments,
coverage gaps, stale skill text, half-wired features, concurrency hazards,
latency hotspots, skill drift. Aim for 8-12 file:line-citable findings. The
round feeds the next sprint's plan as Bucket-1 anchor candidates.

### Worker skills

The orchestrator delegates to worker skills. You may need to create or adapt:

- **An implementation skill** — the autonomous "fetch issue, implement, PR" workflow.
  Many projects already have one. If it exists, check that it's truly autonomous
  (no "wait for user approval" steps). If not, create an auto-implement variant.
- **A fix/repair skill** — how to read review findings and address them. This might
  be as simple as "read the PR comments, fix what they say, push."
- **A QA/verify skill** — how to check that a PR meets all gates. Optional if the
  orchestrator handles this inline.

### Meta-file discipline

The orchestrator reads `.claude/skills/**`, `.claude/memory/**`, `CLAUDE.md`,
`.gitignore`, `.mcx.yaml`, and `.claude/phases/**` **live** while running.
Workers must not modify them during a sprint — the orchestrator would read
a mix of old/new definitions across concurrent sessions (sprint 32 burned
~20 minutes on exactly this when two PRs both edited `run.md`).

Bake into the generated `plan.md`:
- Step 1a reviews open `meta`-labelled issues with the user before the sprint
  starts. Approved ones are applied via short-lived `meta/<descriptor>` branches
  (orchestrator-authored, auto-merge PR) **between** sprints, not during one.
- Picks that modify meta-files are rejected — defer to retro or to a manual
  meta-fix pass.

Bake into the generated `run.md`:
- If a worker's PR needs a meta change, `send` it to revert the meta hunks
  and file a new `meta` issue referencing the PR.
- If the orchestrator's skill / phase definition is genuinely broken
  mid-sprint, **spike the sprint early.** Finish in-flight work, file the meta
  issue, replan. Don't limp along with a broken phase.

Don't create skills that duplicate what already exists. Prefer enhancing existing
skills over creating new ones. If the project has 15 commands and 8 skills, that's
probably too many — the sprint skill should unify, not add.

### Gate definitions (optional, for complex projects)

If the project has more than 2-3 promotion gates, a separate gates reference helps
the orchestrator check them systematically. List each gate, how to verify it, and
what to do if it fails.

## Memory persistence

Claude Code has a built-in memory system — files in `~/.claude/projects/<slug>/memory/`
that Claude can write to without permission prompts. This is by design: the training
encourages saving useful context (feedback, patterns, project facts) naturally during
conversations.

The problem: these files are machine-local. If a different machine runs the next sprint,
or the user reinstalls, all accumulated learnings are gone. Sprint retros capture
patterns in the diary, but feedback ("don't mock the database", "user prefers bundled
PRs") lives only in memory.

The fix: symlink `.claude/memory/` in the repo to the Claude Code memory path. This
preserves the auto-allowed write behavior (Claude writes to the symlinked path without
permission prompts) while making the files git-tracked. Memories get committed alongside
sprint files and diary entries, shared across machines via `git pull`.

```bash
mkdir -p .claude/memory
rm -rf ~/.claude/projects/<project-slug>/memory
ln -s <repo>/.claude/memory ~/.claude/projects/<project-slug>/memory
```

Strongly recommend setting this up during bootstrap. Without it, sprint learnings
accumulate on one machine and are invisible everywhere else — performance becomes
unpredictable depending on which machine (or which fresh checkout) runs the next sprint.
The setup is two commands and a one-line CLAUDE.md note. See `references/iteration.md`
for the full checklist item.

## The deprecation question

When introducing a sprint skill into a project with existing automation, some
commands become redundant. Handle this carefully:

- **Delete**: Commands that are genuinely replaced and will confuse the orchestrator
  if they coexist. Delete them outright — note the deletion in the commit message
  so it's discoverable, but don't leave stale files around. In a Claude-operated
  project, there's no muscle memory to preserve and legacy prefixes just create
  confusion about what's canonical.
- **Keep**: Commands that serve a different purpose (interactive vs. autonomous,
  standalone use vs. pipeline use)
- **Enhance**: Commands that are almost right but need a small addition (like
  a CI gate added to a fix-comments command)

## Write draft skill files, then iterate

Don't present an abstract design document and ask for approval — write the actual
skill files as a first draft. Working artifacts are easier to react to than
descriptions of artifacts. The user can read a draft `run.md` and say "this phase
is wrong" far more effectively than they can evaluate a bullet-point pipeline
diagram.

1. Write all the skill files (SKILL.md, plan.md, run.md, review.md, mcx-claude.md)
2. Walk the user through each one — explain the pipeline, the phases, the commands
3. Iterate based on feedback. The user may reorder phases, adjust concurrency,
   add gates, or cut phases entirely.
4. Commit when the user is satisfied

This is the design phase *and* the build phase. They're the same thing.

Proceed to `references/iteration.md`.
