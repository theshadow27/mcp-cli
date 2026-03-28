# Discovery

Before you design anything, you need to understand the target project. This is the
most important phase. A sprint skill built on assumptions will fail on sprint 1 and
erode trust. A sprint skill built on observation will succeed and compound.

Explore the target project thoroughly. Read files. Run commands. Understand what's
there before deciding what to build.

## What to find out

### 1. Definition of Done

This is the single most important question. "Done" varies wildly:

| Project type | "Done" might mean |
|-------------|-------------------|
| CLI tool | Tests pass, binary compiles, PR merged |
| Web app (auto-deploy) | Tests pass, CI green, screenshots attached, human reviews and merges, deploy succeeds |
| Library | Tests pass, docs updated, changelog entry, PR merged, release cut |
| Monorepo service | Tests pass, integration tests pass, deploy canary, human approves rollout |

**Find out:**
- What CI checks must pass? (`gh workflow list`, read `.github/workflows/`)
- Who merges? (Claude autonomously? Human required? Approval count?)
- What happens after merge? (Auto-deploy? Manual release? Nothing?)
- Are there quality gates beyond CI? (Screenshots? Security review? Perf benchmarks?)
- Is there a review process? (GHA bots? Human reviewers? Both?)

### 2. Testing and validation

- What's the test command? (`npm test`, `bun test`, `pytest`, `go test`, etc.)
- Is there a "am I done?" gate? (A single command that validates everything)
- How long do tests take? (Seconds? Minutes? This affects the feedback loop)
- Are there flaky tests? (Check recent CI failures, ask the maintainer)
- Is there a coverage requirement? (Ratchet? Threshold? None?)
- Are there integration tests that need external services?

### 3. Codebase and tooling

- What's the tech stack? (Language, framework, build tool, package manager)
- How is the repo structured? (Monorepo? Single package? Workspace?)
- Read `CLAUDE.md` if it exists — this is the constitution
- Read `.claude/settings.json` and `.claude/settings.local.json` — what's already configured?
- What skills/commands already exist? (`ls .claude/skills/ .claude/commands/`)
- Is there a project board? (GitHub Projects? Linear? Jira?)
- How are issues labeled and prioritized?

### 4. Worktree feasibility

Git worktrees are how the orchestrator isolates concurrent work. But not all projects
work cleanly in worktrees:

- **git-crypt**: Do files need decrypting? Worktrees may need setup hooks.
- **Database**: Does the project use a local DB? Each worktree may need its own.
- **Ports**: Does the dev server bind a fixed port? Concurrent worktrees will collide.
- **Build artifacts**: Are there generated files that get confused across worktrees?
- **Environment files**: `.env` files may need copying or symlinking.

Check for `.mcx-worktree.json` or similar worktree hooks. If none exist, you may
need to create worktree setup/teardown scripts.

**Test it**: Create a worktree manually, try to run the test suite. If it fails,
understand why before proceeding.

### 5. Issue quality

This determines how aggressive the planning phase needs to be:

- Read 10 recent open issues. Are they well-specified? Do they have acceptance criteria?
- Read 10 recently closed issues + their PRs. Did the implementation match the ask?
- Are issues filed by humans (vague, aspirational) or by Claude (precise, scoped)?
- Is there a pattern of issues being too large for a single session?
- Are there dependency chains between issues?

If issues are well-specified, the planning phase can be light — just pick and batch.
If issues are vague, the planning phase needs to break them down before implementation.

### 6. Review and merge workflow

- Does CI include automated code review? (Copilot, CodeRabbit, Claude GHA action?)
- Are there PR templates? Required sections?
- Is there a screenshot requirement for UI changes?
- How do review comments get resolved? (Who fixes them? How many rounds?)
- Is there a draft PR → ready-for-review → merge flow?
- Can Claude mark PRs as ready, or must a human do it?

### 7. Existing automation and commands

Survey what already exists — don't rebuild what's there:

- Are there implementation commands? (`/implement`, `/auto-implement`, etc.)
- Review commands? (`/adversarial-review`, `/code-review`, etc.)
- QA commands? (`/qa`, `/verify`, etc.)
- PR management? (`/lgtm`, `/fix-pr-comments`, etc.)
- Board management? (`/pm`, board scripts, etc.)
- Story breakdown? (`/gh-refine`, `/speckit`, etc.)

Categorize each as: **keep as-is**, **enhance**, **integrate into sprint**, or **deprecated/redundant**.

### 8. Constraints and risk

- **Concurrency limit**: How many parallel sessions can the project handle? Consider
  worktree overhead, port conflicts, DB connections, CI runner limits.
- **Cost sensitivity**: What's the per-session budget? ($15? $30? $50?)
- **Deploy risk**: Does a bad merge affect users immediately? Or is there a release gate?
- **Secrets and auth**: Are there API keys, tokens, or credentials that sessions need?
- **Rate limits**: GitHub API quotas, CI minutes, external service limits.

## How to explore

Use the Explore agent for thorough codebase analysis. Read broadly:

```
CLAUDE.md
.claude/settings.json, settings.local.json
.claude/skills/*/SKILL.md
.claude/commands/*.md
.github/workflows/*.yml
package.json (or equivalent)
Test files (sample a few)
Recent PRs (gh pr list --state merged --limit 10)
Recent issues (gh issue list --state open --limit 20)
```

Talk to the project. Run its test suite. Try creating a worktree. Read its CI output.
Understand its rhythms before imposing structure.

## Build shared confidence

Discovery is not a solo activity. You will find things in the codebase, but the
user carries context that no amount of exploration can surface — why a workflow
exists, what burned them last quarter, which CI checks are load-bearing vs. legacy,
what the team actually cares about vs. what's written down.

**Ask questions. As many as it takes.** Not a single dump of 20 questions — that's
overwhelming and gets shallow answers. Ask in focused rounds:

1. After your initial exploration, present what you found and what you're unsure about.
   Ask 3-5 targeted questions about the gaps.
2. After the user answers, dig deeper on anything that surprised you or where the
   answer raised more questions.
3. Keep going until you can explain the full sprint lifecycle back to the user and
   they say "yes, that's right."

**The goal is mutual confidence.** By the end of discovery:

- **You** should be confident you understand what "done" means, what the pipeline
  looks like, and what will go wrong first.
- **The user** should be confident that you understand their project well enough to
  design automation they can trust. A hesitant user — one who doesn't fully understand
  what the sprint will do or doesn't believe it will work — will have a difficult time
  trusting the system when it inevitably hits a rough edge on sprint 1.

The user's confidence matters as much as the technical design. They are going to watch
Claude spawn sessions and push code. If they don't understand the pipeline, they'll
intervene at the wrong moments, or fail to intervene at the right ones. The discovery
conversation is where that understanding is built.

**Don't rush this.** A 20-minute conversation now saves hours of debugging a sprint
skill that was built on wrong assumptions.

## Prerequisites and honest assessment

Auto-sprint is not magic. It works because of a tight feedback loop: implement,
validate, fix, validate again. That loop requires infrastructure. If the
infrastructure isn't there, the sprint will break things faster than they can be
recovered.

**Be honest with the user during this phase.** A successful auto-sprint is
predicated on trust, and trust starts with an honest assessment of readiness.
If the project isn't ready, say so clearly and explain what needs to change.

### Hard prerequisites

These must exist before auto-sprint is viable:

- **Test suite that runs in under 10 minutes.** Rapid iteration requires fast
  feedback. If the test suite takes 20+ minutes, each fix-push-check cycle becomes
  a bottleneck — you'll get fractional sprints per day. Skipping tests to go faster
  is counterproductive; it just moves the breakage downstream. If the suite is slow,
  explore whether it can be improved (parallelized, split into fast/slow tiers,
  redundant tests removed). But be honest: if it can't be made fast enough, auto-sprint
  may not be a good fit for this project right now.

- **Static analysis (types, lint, format).** LLMs generate code that compiles and
  looks reasonable but may violate project conventions, introduce type errors, or
  break formatting. Without automated static analysis catching these, review burden
  increases and quality degrades across sprints.

- **CI safety net.** Some form of automated validation that runs on every push.
  Doesn't need to be sophisticated — even `typecheck && lint && test` in a GitHub
  Action is enough. Without it, there's no automated gate, and bad merges compound.

- **Issue tracking.** The orchestrator needs a backlog to plan from, PR linking for
  traceability, and automated close-on-merge. GitHub Issues is the minimum.

- **CLAUDE.md or equivalent.** The project's conventions, architecture, and rules
  need to be written down. Worker sessions start fresh — if the knowledge isn't in
  a file they can read, they'll make decisions that conflict with the project's norms.

### What if prerequisites aren't met?

If discovery reveals missing prerequisites, recommend addressing them first.
Depending on the project's state, there are three paths:

1. **Incremental**: The project is mostly ready, just missing one or two pieces
   (e.g., needs a CI pipeline, or CLAUDE.md needs writing). Propose these as
   concrete tasks. They can be the first issues in the sprint backlog, or done
   manually before the first sprint.

2. **Foundation-first**: The project has significant gaps (no tests, no CI, no
   conventions). Recommend a focused effort to build the foundation — test harness,
   CI pipeline, CLAUDE.md, issue triage — before attempting auto-sprint. This might
   take a few manual sessions.

3. **Reconsider the approach**: In some cases, the existing codebase may be so
   poorly structured that adding automation on top would be building on sand. The
   real value of a codebase is not the code itself — it's the domain knowledge and
   requirements the code encodes. It may be more effective to extract that knowledge
   and rebuild (entirely or in chunks) with proper conventions from the start. This
   is a hard conversation to have, but it's better to have it during discovery than
   after sprint 3 fails.

The goal is not to gatekeep auto-sprint. The goal is to set it up for success.
If the prerequisites aren't met, the sprint will produce PRs that break things,
erode the user's trust, and make the second attempt harder. Better to be honest now.

## Output

After discovery, write a summary of findings organized by the 8 categories above.
Walk through it with the user. Confirm every section. If the user corrects something,
update your understanding and re-confirm.

Only proceed to design when the user says they're confident in the picture.

If `--explore-only` was passed, stop here.

Proceed to `references/design.md`.
