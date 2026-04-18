# Design

You've explored the project. You and the user are aligned on how it works. Now
design the sprint skill.

## The universal architecture

Every sprint skill has the same skeleton, regardless of project:

```
.claude/skills/sprint/
  SKILL.md              # Router: dispatches /sprint, /sprint plan, /sprint review, /sprint retro
  references/
    plan.md             # How to select and prepare issues for a sprint
    run.md              # The main loop: spawn, monitor, qualify, promote
    review.md           # Wrap up: record results, extract learnings
    mcx-claude.md       # Session management command reference
```

This is the minimum. Some projects need more (a `gates.md` for complex promotion
criteria, a `retro.md` if review and retro are separate phases). Some projects need
less (if there's no review process, there's no review phase). Adapt.

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

### The qualify phase

This is where projects diverge most. Map the project's actual quality gates:

| Gate | How to check | How to fix |
|------|-------------|-----------|
| CI passes | `gh pr checks` | Spawn repair session |
| Tests pass | Project's test command | Spawn repair session |
| Screenshots (UI projects) | Check PR body for images | Spawn capture session |
| Code review (GHA bot) | Read review comments | Spawn fix session |
| Code review (human) | Can't automate — this is the human gate | |
| Security scan | Check CI status | Spawn fix session |
| Perf benchmark | Check CI status | Spawn fix or flag for human |

Only include gates that actually exist in the project. Don't invent gates.

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

## What to produce

You're writing two things: **markdown** that instructs the Claude orchestrator
(SKILL.md, plan.md, run.md, review.md, mcx-claude.md) and the **declarative
phase graph** that formalises the pipeline (`.mcx.yaml` + `.claude/phases/*.ts`).
The markdown teaches intent; the phase graph is the executable contract the
orchestrator drives.

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

Routes `/sprint plan`, `/sprint`, `/sprint review`, `/sprint retro` to the right
reference document. Include project-specific rules that apply to all phases
(concurrency limit, merge policy, cost threshold, "never implement directly").

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
   read the domain output (`triage.decision`, `done.error`, etc.) and take
   the special-cased next step rather than treating the output as an
   action. Record every transition, then iterate.
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

How to wrap up: gather what shipped, record results in the sprint file, extract
learnings, identify simplification opportunities, and prepare for the next sprint.

### Worker skills

The orchestrator delegates to worker skills. You may need to create or adapt:

- **An implementation skill** — the autonomous "fetch issue, implement, PR" workflow.
  Many projects already have one. If it exists, check that it's truly autonomous
  (no "wait for user approval" steps). If not, create an auto-implement variant.
- **A fix/repair skill** — how to read review findings and address them. This might
  be as simple as "read the PR comments, fix what they say, push."
- **A QA/verify skill** — how to check that a PR meets all gates. Optional if the
  orchestrator handles this inline.

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
