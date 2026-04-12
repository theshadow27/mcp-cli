# Iteration

Sprint 1 will not be perfect. That's expected and fine.

The mcp-cli project — which now runs 14-PR sprints like clockwork — took 20 sprints
to get to v1.0. The first sprints were messy. Sessions got stuck in retry loops.
Worktrees collided. The orchestrator lost track of state. A single bad pre-commit
hook burned $2,700 overnight. These are not failures of the approach — they're the
normal cost of building a system that learns.

What matters is not perfection on sprint 1. What matters is that sprint 2 is better
than sprint 1, and sprint 3 is better than sprint 2. The retro is where that happens.

## Measuring success

### Sprint 1: did it run?

The bar for sprint 1 is low and should be. Ask:

- Did the orchestrator spawn implementation sessions successfully?
- Did any sessions produce a PR? (Even one is a win.)
- Did the orchestrator stay busy, or did it stall and need prompting?
- Were there any unrecoverable failures? (Data loss, corrupted state, etc.)

**Sprint 1 success = "it ran, we learned things, nothing caught fire."**

Don't judge the sprint by throughput. Judge it by whether the pipeline moved
forward without human intervention at each step. Even if only 2 out of 5 issues
produced PRs, that's proof the system works. The other 3 are debugging data.

### Sprint 2-3: is it improving?

By sprint 3, look for:

- **Fewer manual interventions** — the orchestrator handles more edge cases
- **Faster cycle time** — less time between "issue selected" and "PR ready"
- **Better issue conversion** — more issues produce PRs, fewer failures
- **Smaller retros** — fewer surprises, more routine

### Sprint 5+: is it autonomous?

A mature sprint should:

- Run without prompting between plan and review
- Handle common failures (CI failures, review comments, stale worktrees)
- Track and report state without losing track of sessions
- Produce PRs that meet all quality gates before requesting human review
- Generate useful retros that feed into the next sprint

## How to improve

### The retro is mandatory

Every sprint must end with a retrospective. Not optional. Not "if there's time."
The retro is where the system learns.

A good retro captures:

1. **What worked** — so you keep doing it
2. **What didn't work** — so you fix the skill files
3. **Operational friction** — the things that slowed the orchestrator down
4. **Surprising discoveries** — things the skill files didn't anticipate
5. **Concrete changes** — specific edits to make to the sprint skill

The retro should produce at least one edit to the sprint skill. If nothing changed,
either the sprint was perfect (unlikely) or the retro was shallow.

### Common sprint 1 problems and their fixes

| Problem | Likely cause | Fix |
|---------|-------------|-----|
| Orchestrator stalls after spawning | No post-implementation work defined | Add qualify/promote/monitor phases to run.md |
| Sessions fail to push | Auth issues, branch conflicts | Add pre-flight git health checks |
| Worktree spawn failures | Stale worktrees from previous runs | Add cleanup to pre-flight and per-issue spawn |
| CI failures not caught | No CI watching step | Add `gh pr checks --watch` to qualify phase |
| Orchestrator loses track of sessions | No state persistence | Add sprint-state.json writes to loop body |
| Sessions burn excessive cost | Retry loops (pre-commit, CI, tests) | Add cost threshold + kill rule to loop body |
| Wrong sessions get managed | Multiple projects sharing daemon | Use session IDs explicitly, filter by project |
| Human doesn't know what to review | No promotion step | Add "report ready PRs" to promote phase |

### Re-read the lessons after every retro

`references/lessons.md` contains 20 lessons from 22 sprints. After your first retro,
re-read them. You'll recognize patterns you hit. After your third retro, you'll have
your own lessons to add. The lessons file is a living document — update it with
project-specific learnings that are general enough to apply elsewhere.

### The skill files are living documents

After every retro, update the sprint skill files. Add the rule that would have
prevented the problem. Remove the instruction that caused confusion. Tighten the
spawn commands. Adjust the concurrency limit.

The sprint skill is not a specification you write once. It's a codebase — it evolves
with every sprint, shaped by what actually happened. Treat retro findings as bugs
in the skill files and fix them.

### Rules extraction

After several sprints, patterns emerge — coding conventions that reviewers keep
flagging, architectural decisions that keep causing merge conflicts, test patterns
that keep breaking. If the project has a rules extraction skill (like `/harvest-rules`
or `/mine-rules`), run it during the review phase. The rules it finds should flow
back into CLAUDE.md or the project's linting configuration, preventing the same
review comments from recurring.

### Simplification

Each sprint adds code. Code accumulates complexity. During every review phase, look
at the codebase with fresh eyes and identify one thing to simplify — dead code to
remove, an overabstraction to flatten, a stale pattern to modernize. Propose it to
the user as a candidate for the next sprint. This keeps entropy in check.

## Kickoff checklist

After writing the sprint skill files, walk the user through this checklist. Each
item should be confirmed before proceeding to the next.

```
[ ] Sprint skill files written and committed
    - SKILL.md (router)
    - references/plan.md
    - references/run.md
    - references/review.md (or combined review+retro)
    - references/mcx-claude.md
    - Any additional references (gates.md, etc.)

[ ] Worker skills verified
    - Implementation skill exists and is autonomous (no "wait for user" steps)
    - Fix/repair workflow is documented (even if inline in run.md)
    - Any project-specific skills (screenshot capture, etc.) are working

[ ] Deprecated commands deleted
    - Commands replaced by the sprint pipeline are removed (noted in commit message)
    - Commands that serve different purposes (interactive use) are kept

[ ] Memory persistence configured
    - Create .claude/memory/ in the repo (git-tracked)
    - Symlink it to the Claude Code memory path:
      rm -rf ~/.claude/projects/<project-slug>/memory
      ln -s <repo>/.claude/memory ~/.claude/projects/<project-slug>/memory
    - This preserves Claude's auto-allowed memory writes (no permission prompts)
      while making memories git-tracked and shared across machines
    - Without this, memories accumulate locally and are invisible to other
      machines/sessions. Sprint learnings, feedback, and patterns get lost
      on reinstall or when a different machine runs the next sprint.
    - Add a note to CLAUDE.md: "Memory files in .claude/memory/ must be
      committed and pushed when changed."

[ ] GitHub labels created
    - The sprint skill uses a few repo labels as control-plane signals.
      Create them once at bootstrap so the skill files can reference them
      without inline setup (skills assume labels exist):

      gh label create qa:pass --color 0e8a16 \
        --description "QA verified — orchestrator may merge" 2>/dev/null || true
      gh label create qa:fail --color d93f0b \
        --description "QA found gaps — implementation needs rework" 2>/dev/null || true
      gh label create meta --color 5319e7 \
        --description "Orchestrator meta-files (skills, memory, CLAUDE.md, .gitignore) — applied at retro/plan, not during sprint" 2>/dev/null || true
      gh label create needs-clarification --color fbca04 \
        --description "Sprint orchestrator rejected — spec is ambiguous" 2>/dev/null || true
      gh label create flaky --color e99695 \
        --description "Flaky test — root-cause fix required (no timeout bumps)" 2>/dev/null || true

    - If any of these don't apply to your project's workflow, omit them
      and remove the corresponding references from the sprint skill files.

[ ] Infrastructure verified
    - mcx daemon is running
    - Worktrees can be created and tests run in them
    - gh CLI is authenticated and can create PRs/issues
    - CI pipeline is functional

[ ] Sprint 1 planned
    - Run /sprint plan
    - Select 3-5 small, well-specified issues (not 15 — start small)
    - User has reviewed and approved the plan

[ ] Sprint 1 executed
    - Run /sprint
    - Observe. Take notes. Don't intervene unless something is broken.
    - Let it finish (or fail gracefully)

[ ] Sprint 1 retro written
    - What worked?
    - What didn't?
    - What changes to the sprint skill?
    - Commit the retro and skill updates

[ ] Sprint 2 planned
    - Apply retro learnings to the skill files FIRST
    - Then plan sprint 2 with slightly more ambition (5-7 issues)
```
