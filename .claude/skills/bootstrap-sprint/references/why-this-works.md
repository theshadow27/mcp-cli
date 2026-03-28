# Why This Works

The mcp-cli project — the one you're reading this from — was built almost entirely
by Claude orchestrating other Claudes. Over 1,075 GitHub issues resolved. 22 sprints
completed. No humans touching the code. The software ships, is used daily, and is
partially used to improve itself. Sprint 15 landed 14 PRs in a single automated run.

Phoenix-octovalve, a Next.js dance school portal with a completely different tech
stack, workflow, and definition of done, is running its first automated sprints using
the same pattern — adapted, not copied.

## What you're doing

You are going to explore a project, understand its workflows, and build a sprint
skill that lets a Claude orchestrator run parallel implementation sessions
autonomously. The orchestrator will:

- Plan sprints by surveying the backlog and breaking down vague issues
- Spawn worker sessions in isolated git worktrees
- Monitor progress, check CI, handle review comments, capture screenshots
- Push issues through a qualify/promote/monitor pipeline until they're merge-ready
- Track state, manage costs, and report results
- Write retrospectives so the next sprint is better than the last

You will produce skill files — markdown documents that tell a future Claude exactly
how to do all of this for the target project. Not scripts. Not automation frameworks.
Clear instructions with enough context that a Claude session can follow them
autonomously without asking for help.

## Why markdown instructions work

Claude doesn't need a state machine or an orchestration framework. It needs to
understand the *why* behind each step, and it needs concrete commands to execute.
A well-written reference document with clear procedures and explicit decision points
is more robust than a brittle script, because Claude can adapt when things go sideways
— as long as it understands the intent.

The individual skills are pedestrian. `/implement` is just "fetch issue, branch,
code, test, commit, push, PR." `/qa` is just "check the PR, verify tests, post
findings." There is nothing clever about any single piece. The breakthrough is the
assembly — that together, orchestrated by a Claude that understands the pipeline,
they produce a system that autonomously clears a sprint. The whole is dramatically
more than the sum of the parts.

## Session isolation, not subagents

Sprint orchestration requires session-level isolation: each issue gets its own
independent Claude session with its own context window, working directory, and
lifecycle. The orchestrator interacts with sessions through a management interface
(spawn, wait, check, send, end) — not by receiving their full output.

This is distinct from Claude Code's built-in subagent model (Agent tool, background
agents, swarms), where worker output flows back into the parent context. That model
works well for decomposing a single complex task, but breaks down at sprint scale —
10+ parallel issues across multiple phases will exhaust the orchestrator's context
window with implementation details it doesn't need and can't usefully act on.

mcx provides this isolation today via `mcx claude` commands. The essential capability
is: spawn an isolated session with a mandate, wait for it without ingesting its
output, check its result, and clean up. Any tool providing these primitives can
substitute.

## Your job

You are not copying mcp-cli's sprint skill. You are understanding the *pattern*
and adapting it to a project with different constraints, different testing, different
review workflows, different issue quality, and different risk profiles.

The pattern is:
1. Explore the project deeply
2. Identify what "done" means for this project
3. Design a pipeline that pushes issues toward "done"
4. Give the orchestrator enough work to stay busy between spawning and merging
5. Make it better every sprint

That's it. The rest is details. Important details, but details.

Before you proceed, read `references/lessons.md` — 20 general-purpose lessons
extracted from 22 sprints of operational experience. These will save you from
repeating mistakes that have already been made and paid for.

Proceed to `references/discovery.md`.
