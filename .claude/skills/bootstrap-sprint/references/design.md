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

You're writing markdown files that instruct a Claude orchestrator. Not code. Not
templates. Instructions with context.

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
2. **The pipeline** — phase-by-phase instructions with exact spawn commands
3. **The main loop** — pseudocode for the orchestrator's event loop
4. **State tracking** — how and where to persist issue/session/PR state
5. **Key rules** — the hard-won lessons (verify push before bye, don't restart
   daemon mid-batch, etc.)
6. **Stop conditions** — when to halt and report

Write the spawn commands verbatim. The orchestrator should be able to copy-paste
them. Include the `--allow` flags, the model selection, the worktree flags. Don't
make the orchestrator figure these out at runtime.

### The session management reference (mcx-claude.md)

The orchestrator leans heavily on `mcx claude` commands for session management.
The canonical reference is maintained at:
https://github.com/theshadow27/mcp-cli/blob/main/.claude/skills/sprint/references/mcx-claude.md

Fetch the latest version and adapt it for the target project. Strip commands that
don't apply (provider routing, ACP), add any project-specific flags or worktree
hooks. The orchestrator should never have to guess at command syntax — every spawn,
wait, bye, and ls command should be spelled out with exact flags.

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
