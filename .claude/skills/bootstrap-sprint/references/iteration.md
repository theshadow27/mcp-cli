# Iteration

Sprint 1 will not be perfect. That's expected and fine.

The mcp-cli project — which now sustains 13–14 merged PRs per sprint and peaked at
21 in one sprint — took ~20 sprints to ship v1.0 and is on v1.10.x at sprint 59.
The first sprints were messy. Sessions got stuck in retry loops. Worktrees
collided. The orchestrator lost track of state. A single bad pre-commit hook
burned $2,700 overnight. These are not failures of the approach — they're the
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

`references/lessons.md` collects 36 general-purpose lessons distilled from 49+
sprints of operational experience. After your first retro, re-read them. You'll
recognize patterns you hit. After your third retro, you'll have your own lessons
to add. The lessons file is a living document — update it with project-specific
learnings that are general enough to apply elsewhere.

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
that keep breaking. If the project has a rules extraction skill (like `/rule-author harvest`
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
    - SKILL.md (router with auto-chain routing for /sprint and explicit
      /sprint run, /sprint review, /sprint retro entry points)
    - references/plan.md
    - references/run.md
    - references/review.md (release / changelog phase)
    - references/retro.md (diary phase — separate from review, even if
      the user invokes them together via auto-chain)
    - references/mcx-claude.md (session management reference; include
      the "Session Scoping" + "Diagnosing missing sessions" sections
      verbatim)
    - references/investigations.md (nerd-snipe gate for flaky / recurring
      / unclear-mechanism issues — required even for projects that
      think they don't have flaky tests yet)
    - references/compaction-survival.md (what survives compaction, the
      5-command recovery sequence, re-pairing sessions to work items)
    - references/introspection.md (sprints-ending-in-7 cadence for
      code-first audits; the round feeds the next sprint's plan)
    - Optional: references/gates.md (only if the project has >3
      distinct promotion gates beyond CI/tests/review)

[ ] Phase graph scaffolded and installed
    - .mcx.yaml at repo root declares phases + transitions (see docs/phases.md)
    - .claude/phases/*.ts: one defineAlias handler per phase, with typed
      Zod input/output. Output shape depends on phase kind:
      session-driving phases (impl, review, repair, qa) conventionally
      return an action union ({action: "spawn"|"in-flight"|"wait"|"goto"});
      compute/terminal phases (triage, done, needs-attention) return
      domain outputs the orchestrator special-cases.
    - Run `mcx phase install` to generate .mcx.lock (commit the lock)
    - Run `mcx phase list` to confirm all phases resolve cleanly
    - Run `mcx phase show <name>` on each phase to verify source + schema
    - Starting template: copy mcp-cli's .mcx.yaml + .claude/phases/, then
      edit spawn commands / providers / round caps to match the target
      project; delete phases that don't apply

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
    - mcx daemon is running (`mcx status` reports a healthy daemon)
    - Worktrees can be created and tests run in them
    - **Worktree `core.hooksPath` inheritance**: if the base repo has
      `core.hooksPath` set to an absolute path, every worktree inherits
      it and pre-commit hooks may silently no-op. Either set the value
      to a *relative* path in the base repo (e.g. `.git-hooks`), or
      script the per-worktree fix: `git -C <worktree> config
      core.hooksPath .git-hooks` after each `git worktree add`.
      Verify by creating a throwaway worktree and committing a known-
      bad change; the hook must reject it.
    - gh CLI is authenticated and can create PRs/issues
    - CI pipeline is functional
    - **Sprint-active sentinel** — add `.claude/sprints/.active` to
      `.gitignore` (one line). The sprint skill writes the current
      sprint number to it at run start and removes it at retro;
      pre-commit hooks on the main checkout reject commits while it
      exists (orchestrator commits use `SPRINT_OVERRIDE=1`).
    - **`mcx pr merge` (not `gh pr merge --auto`)** as the canonical
      merge command in phase scripts and prose. `mcx pr merge`
      handles re-arming after force-push and surfaces failures to the
      event stream; `gh pr merge --auto` silently fails on some
      branch-protection configurations.

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
