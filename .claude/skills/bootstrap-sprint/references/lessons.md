# Lessons from 49 Sprints

These lessons were extracted from retrospectives across 49 numbered autonomous
sprints (plus ~9 unnumbered prelude sprints) that shipped 917 PRs in ~11 weeks.
They are general-purpose — not about any specific technology, but about how
autonomous sprint systems behave in practice.

Read these before your first sprint. Re-read them after your first retro. You'll
understand them differently with experience.

---

## On planning

**1. Measure after implementation, not before.**
Pre-implementation complexity estimation is fundamentally noisy — research showed
29.7% accuracy regardless of approach. It's far more effective to implement first
(with the strongest model), then triage based on the actual diff to decide validation
depth. The implementation itself is the best signal for how much review it needs.

**2. Eliminate unknowns with spikes before committing to implementation.**
When an issue involves an unfamiliar protocol, API, or integration, run a throwaway
spike first. Validate that the transport works, the handshake succeeds, and basic
flows complete. Spike findings become implementation issue comments — the implementer
reads concrete evidence, not speculation. A $6 spike prevents a $50 failed session.

**3. Always have backfill work ready.**
Front-load dependency chains in batch 1, then saturate remaining slots with
independent work. When batch 1 issues block on review or CI, backfill issues keep
capacity utilized. Idle slots are wasted money. The orchestrator should never be
waiting with nothing to spawn.

**4. Document why you excluded an issue, not just what you included.**
Every sprint plan should note issues that were considered and rejected, with reasons.
This prevents the same issue from being re-evaluated every sprint and makes priority
decisions visible to future planners.

---

## On orchestration

**5. The orchestrator must have work between spawning and merging.**
This is the single most common failure mode. If the orchestrator spawns an
implementation session and has nothing to do until the human merges, it will stall.
Design at least 2-3 autonomous phases between "implementation complete" and "human
gate" — CI verification, review, screenshot capture, comment resolution. The
orchestrator stays busy by managing these phases, not by waiting.

**6. Event-driven waiting beats polling. Always.**
Use `mcx claude wait --timeout` (or equivalent blocking call), never `sleep` loops.
Sleep is uninterruptible and wastes time. Event-driven waiting responds immediately
when a session completes and can be interrupted by the user. This single pattern
change can cut sprint wall-time by 30%.

**7. Verify push before ending a session.**
Unpushed work is unrecoverable after a daemon restart, laptop sleep, or crash. Before
calling `bye` on any session, verify the branch was pushed to the remote. This rule
exists because it was learned the hard way — multiple times.

**8. Stale background services cause silent failures.**
After rebuilding code that changes the daemon or any background service, restart it
before spawning new sessions. Stale versions don't crash — they silently misbehave.
Version-check your daemon at pre-flight. If the running version doesn't match the
built version, restart before proceeding.

---

## On quality

**9. Two sequential reviews catch what one misses.**
For high-scrutiny changes (large rewrites, protocol changes, security-sensitive code),
run two independent adversarial review rounds. The first round catches obvious issues.
Critically, the second round catches bugs *introduced by the first round's fixes*.
Rework introduces new bugs — sequential review is the only way to catch them.

**10. Repair sessions need full review history, not just the latest findings.**
When sending a repair session to fix review findings, include the complete history of
what was already tried and rejected. Without this, the repairer re-explores dead ends.
The PR comment thread is the ideal medium — it's durable, ordered, and readable by
any session.

**11. When you find one bug in a pattern, audit the whole pattern.**
A Zod parse failure at one protocol boundary means there are probably parse failures
at every protocol boundary. A missing error handler in one worker means every worker
is probably missing it. One instance justifies a subsystem audit. Bugs cluster.

---

## On failure prevention

**12. Autonomous systems need circuit breakers.**
Without cost caps, sessions can enter retry loops (pre-commit failures, CI flakes,
rate limits) and burn money indefinitely. One incident burned $2,700 overnight from
sessions retrying a pre-commit hook that failed due to system load. Set a per-session
cost threshold. When exceeded: interrupt, end the session, file an issue about what
went wrong. $30 is a reasonable starting threshold for small issues.

**13. CI gates must fail on code problems, not environmental variance.**
A test that times out because the machine is under load is not a code bug. If your
CI gates hard-fail on absolute thresholds (test runtime, memory usage), they will
cause false failures during concurrent work. Use relative change detection — flag
when a specific test gets slower than its own baseline, not when it exceeds a fixed
number.

**14. Worktree isolation must be explicit, not assumed.**
If a session runs without worktree isolation, it modifies the main repo's working
tree — branch checkouts, file changes, everything. Never spawn a review, QA, or
repair session without explicit isolation (`--worktree` or `--cwd`). "It'll probably
be fine" is how you corrupt your working tree at 2 AM.

---

## On improvement

**15. The retro is not optional. It's where the system learns.**
Every sprint must end with a retrospective that produces at least one concrete change
to the sprint skill files. If the retro didn't change anything, either the sprint was
perfect (it wasn't) or the retro was shallow. The retro is the mechanism by which
sprint N+1 is better than sprint N. Skip it and the system stagnates.

**16. Three consecutive clean sprints signal pipeline maturity.**
Before that threshold, stay conservative — smaller batches, more oversight, quicker
intervention. After three clean sprints, the pipeline has proven itself. Increase
batch sizes, reduce manual checkpoints, trust the process. Use demonstrated
performance to calibrate ambition, not hopes.

**17. Incidents are pre-flight checklist items.**
Every operational incident (stale daemon, orphaned worktree, zombie session) should
produce a new pre-flight check. The checklist grows organically from experience.
After 10 sprints, the pre-flight catches most recurring problems before they happen.

**18. File every problem with reproduction data.**
"The daemon crashed" is not an issue. "Ran `mcx claude spawn`, got ECONNREFUSED,
daemon PID 12345 was running but socket at ~/.mcp-cli/mcpd.sock was missing, logs
show [timestamp] [error]" is an issue. Bare descriptions get reopened for more info.
Detailed reports get fixed.

---

## On collaboration

**19. Route work to the strongest model for the task.**
Implementation benefits from the best reasoning model (highest cost tier). Review
and QA work well on cheaper, faster models. This isn't just cost optimization — it's
capability matching. The strongest model writes better code (fewer repair rounds),
and the cheaper model catches most review issues. Concentrate expensive capability
where it has the highest leverage.

**20. Some exploration is better done by humans.**
Spikes involving unfamiliar protocols, manual UI testing, and "does this feel right?"
judgments benefit from human intuition. Once findings are validated, agents can code
the implementation cleanly from concrete evidence. Don't force agents to explore when
a human with a terminal would be faster.

---

## The meta-lesson

**21. The sprint skill is a living document. The goal is to clear the backlog.**
The sprint skill files and MEMORY.md (visible to all spawned workers) together form
the basis of repeatable operation. They are not documentation — they are executable
instructions that directly determine how well the next sprint runs.

A retro that doesn't produce at least one adjustment to the skill files is ceremony
for its own sake. After every sprint, the orchestrator should propose concrete
improvements: tighter spawn commands, better gate definitions, new pre-flight checks,
adjusted cost thresholds, refined phase transitions. The user decides what to accept,
but the model should always offer. Every sprint should be more efficient than the last.

The measure of success is not sprint velocity or PR count. It's this: **is the
backlog getting cleared?** If yes, the system is working. If no, the retro should
figure out why and the skill files should change. Everything else is noise.

**22. Measure before assuming.**
When diagnosing a slow pipeline step, time each component individually. The assumed
bottleneck is often wrong. In one case, the orchestrator assumed `bun install` (64ms)
was the problem when the actual bottleneck was daemon integration tests (136s). The
fix was obvious once measured — but unmeasured, three wrong fixes would have shipped.
This applies to any optimization work: profile first, then fix what the data shows.

**23. Delegate mechanical edits to the cheapest capable model.**
Renumbering lists, reformatting tables, fixing indentation, updating version strings
across files — these are tasks where the strongest model adds no value over the
cheapest. Opus spending 5 minutes on sequential find-and-replace edits is a waste of
both tokens and the operator's patience. Spawn a haiku for mechanical work, save opus
for reasoning.

**24. Workers are conversations, not batch jobs.**
Spawned sessions are full Claude sessions with the same tools and capabilities as the
orchestrator. They can ask questions, request plan approval, get confused, or go off
track. When a worker stops early or behaves unexpectedly, the orchestrator's first
response should be `mcx claude log <id>` — not `bye`. A worker that asked "Shall I
proceed with this plan?" needs `mcx claude send <id> "Yes, proceed"`, not a respawn.
A worker producing a 125k-deletion PR needs `send "Stop — your worktree is corrupted"`,
not a silent close. Respawning discards all context and costs money. A single `send`
is almost always cheaper and faster. Before responding, ask: what additional context
would allow this task to complete as intended? Send that.

**25. Persist memories across machines via git-tracked symlink.**
Claude Code's memory system (`~/.claude/projects/<slug>/memory/`) accumulates useful
context — feedback, patterns, project facts — without permission prompts. But it's
machine-local. Sprint learnings saved as memories on one machine are invisible to
sessions on another. The fix: symlink `.claude/memory/` in the repo to the Claude Code
memory path. Memories stay auto-writable (Claude writes to the symlinked path without
prompts) but become git-tracked and shared via `git pull`. Without this, performance
varies unpredictably between machines as some have accumulated context and others don't.

**26. Enforce CI-green-before-merge mechanically, not just by convention.**
A "no merge without green CI" rule written into the QA skill is not enough.
QA sessions rationalize local-tests-pass as "qa:pass" even when CI is red —
especially when CI is red due to a sibling PR's unmerged change. The only
reliable enforcement is repo-level branch protection: require the CI
status checks (`check`, `coverage`, `build`, whatever your repo uses) to
be SUCCESS before `gh pr merge` can succeed. Combine with an explicit
pre-merge check in the orchestrator loop (`gh pr view <N> --json
statusCheckRollup`) for defense in depth. Sprint 33 merged a dozen PRs
through red main CI before adding protection; the resulting recovery
work swamped the protection cost.

**27. Cap blocking waits below the prompt-cache TTL.**
Claude Code's prompt cache has a 5-minute TTL. Any `wait` / `sleep` /
`poll` that blocks ≥ 300 seconds causes the next turn to re-process the
entire session context at full input-token price instead of cache-read
price. On a session with accumulated context (100k+ tokens, normal for
orchestrators), a single cache miss costs dollars that would have been
fractions of a cent. Hard cap all blocking waits at ~270s (4:30). If you
genuinely need longer, break into multiple short waits with a cheap
no-op between to keep the cache warm, or accept the miss and commit to
15+ minutes (so the cost amortizes across the idle period).

**28. Match repair cost to fix complexity — reviewers can fix their own
findings.**
The default "review flags issues → spawn fresh opus to repair → re-review"
cycle is right for complex fixes but wasteful for trivial ones. If the
reviewer's findings are 1–3 contained edits with exact line-level
diagnosis already in the comment, `send` the reviewer back to fix them
in-place. The reviewer has Read/Edit/Write/Bash and full PR context;
fixing its own flagged typo or missing try/catch costs ~$0.20 vs ~$3–5
for a fresh opus session + worktree + re-review. Let reviewers
self-select: "if contained, fix and push; if architectural, reply
'needs opus repair'." Reserves opus judgment for cases that actually
need it.

**29. Leave QA sessions idle, don't bye-and-respawn, on upstream blockers.**
When QA's CI is red because of a known upstream PR that hasn't merged
yet (e.g., the sprint's CI-unblock PR), leaving the QA session idle
preserves its accumulated PR context. When the upstream lands, `send`
"rebase onto origin/main and re-run your QA." Respawning forces a fresh
session to re-learn the PR from scratch, discarding typed analysis
(diff review, edge cases checked, coverage notes). Rule of thumb: a
session's verdict that depends on a resolvable external state should
stay idle until the state resolves. Sessions are colleagues, not
function calls.

**30. Don't use strict-up-to-date branch protection — let main-CI be the gate.**
Sprints that ship 10+ PRs in parallel against a strict-up-to-date rule
(`strict_required_status_checks_policy: true` on GitHub, or any
equivalent "branches must be up to date with base before merge" policy)
collapse into an N² rebase cascade: each merge invalidates every other
PR's "up to date" status, so the orchestrator is reduced to a serialized
loop calling `update-branch` on the next PR, waiting for CI to re-run,
merging, repeating. For a 10-PR tail that's an hour of a high-capability
model acting as a retry-loop shepherd — the single most depressing
pattern in autonomous work, and the velocity hit is severe (sprint 38's
mid-sprint policy flip merged 11 queued PRs in under a minute once the
rule came off).

The fix is to *relax the constraint*, not to engineer around it:

1. **Set strict to false** on whatever branch protection / ruleset
   governs main. On GitHub: `gh api -X PUT
   /repos/<owner>/<repo>/rulesets/<id>` with `strict: false` on the
   required-status-checks rule. Branches do *not* need to be up-to-date
   before merge; main's own post-merge CI catches any conflict that
   slipped through.
2. **Avoid logical conflicts at planning time.** Identify picks that
   touch known hot-shared files (dispatch tables, routers, registries,
   feature-flag maps) and serialize them via `addBlockedBy` edges, so
   the second PR rebases after the first merges. See lesson #32 for the
   task-list shape that makes this work.
3. **Single-thread by exception, not by default.** Most PRs can merge
   in any order; only the hot-shared subset needs serialization. The
   planner identifies which is which.
4. **Trust main-CI as the post-merge canary.** If a merge cluster lands
   and main goes red, the release gate (an explicit `/release` at sprint
   boundary, refusing to tag if main-CI is red) is the backstop.

This is *better than native merge queue*, not just a substitute. Merge
queue solves the same N² cascade but at the cost of serialized merges
through a remote queue; relaxing strict + planning-time
serialization-by-exception keeps throughput high and avoids depending
on a feature that's org-only on GitHub (User-owned repos can't enable
merge queue at any tier; check `gh api users/<owner> --jq .type` during
discovery).

**Anti-pattern recorded for posterity: "mergemaster."** mcp-cli briefly
tried a long-lived sonnet session that ran `gh pr update-branch --rebase`
+ poll CI + let auto-merge fire, on the theory that User-owned repos
without merge queue needed a substitute. It worked, but it papered over
the underlying mistake — the strict policy itself. The agent was retired
in sprint 41 (commit `f952eae`, closes #1866) once the simpler fix was
in place. If you find yourself reaching for an orchestrator-side merge
shepherd, you're almost certainly fixing the wrong layer.

**31. Enumerate every comment/review surface per platform — not just the
obvious one.** GitHub PRs surface comments on four distinct API endpoints:
PR-body comments, inline file:line comments (where Copilot code review
lives), review containers (APPROVED / CHANGES_REQUESTED / COMMENTED), and
linked-issue comments. Phase agents that only check the PR-body surface
ship PRs with unresolved review threads. Before transitioning a PR to
`done`, enumerate **all** surfaces and demand each open thread be
addressed (with a reply citing the fix commit) or dismissed (with an
explicit out-of-scope reply). No silent skips. The principle generalizes:
every collaboration platform has more "where comments live" than the
default UI shows; an autonomous merger that doesn't enumerate them all
will leak unresolved threads into main.

**32. Task lists track issues, not batches.** When the planner groups
N issues into M batches, it's tempting to mirror the structure as M
TaskCreate items where Batch 2 is blocked-by Batch 1. Don't. Create one
Task per *issue* with `addBlockedBy` edges for explicit cross-issue
dependencies (file conflicts, ordering requirements). Batch-level tasks
serialize idle slots — the orchestrator waits for "Batch 2 to finish
before starting Batch 3" instead of pulling the next unblocked issue.
Issue-granular tasks let the dependency graph drain naturally and peak
concurrency stays high. This rule lives in the skill's run.md, not in
retro learnings, because every sprint forgets it otherwise — the visual
clarity of "3 batches" pulls the orchestrator back toward the wrong
abstraction unless the skill explicitly forbids it.

**33. Verify the merge actually fired — `qa:pass + auto-merge queued ≠
merged`.** GitHub's auto-merge can fail silently after `gh pr merge
--auto`: branch protection re-evaluates, a CI check flips to required,
a sibling PR's rebase invalidates the queue. The QA verdict is local;
the merge is remote. Before marking a work item `done` and untracking
it, poll `gh pr view <n> --json state,mergedAt -q '.state'` until it
returns `MERGED` *and* `mergedAt != null`. Don't conflate "I queued the
merge" with "the merge happened." Sprints that ship 10+ PRs in parallel
hit this routinely — the difference between "queued" and "merged" is
where the cascade actually drains.

**34. Worktrees inherit absolute `core.hooksPath` from the base repo,
silently breaking pre-commit hooks.** Many repos store their pre-commit
hooks in `.git-hooks/` (or similar) and set `core.hooksPath` to that
path. If the value in the base repo's local config is *absolute*, every
worktree created from it inherits the same absolute path — which points
back at the base repo's `.git-hooks/`. On a fresh worktree checkout
the path resolves but the hooks may use relative paths from the
worktree's CWD, silently no-op'ing or running against the wrong tree.
Fix at worktree creation: `git -C <worktree> config core.hooksPath
.git-hooks` (relative path) or remove the inherited override. Verify
during bootstrap discovery; bake into the per-worktree spawn script.

**35. Label hygiene matters when merging on flaky-CI reruns.** When QA
returns `qa:fail` because of flaky CI (unrelated test failures, not the
PR's code) and a `gh run rerun --failed` clears green, the orchestrator
may reasonably skip a fresh QA round — re-spawning sonnet QA to flip a
label is wasteful. But the **PR label must be flipped from `qa:fail` to
`qa:pass` (with a comment) before arming auto-merge.** A `qa:fail`-
labelled PR landing on main makes the audit trail misleading: branch
protection, retro tooling, and any future workflow keyed on the literal
label sees a failure that wasn't one. The shortcut is fine; the
misleading record is not. Cost of the label fix is one `gh pr edit`
command. Cost of a misleading audit trail compounds.

**36. Pipeline logic belongs in code, not markdown.** A sprint skill
written entirely as prose in `run.md` ("now spawn a review session…
then if findings exist, spawn a repair session…") becomes
unmaintainable around sprint 20: the prose grows, transitions diverge
across reviewers, and the orchestrator interprets the same text two
different ways. The fix is a declarative phase graph
(`.mcx.yaml` + `.claude/phases/*.ts` in this project's shape, but the
principle generalizes): phases declare their transitions, handlers
return tagged actions, transitions are logged. The markdown documents
how to *drive* the graph (pre-flight, the loop, stop conditions); the
graph itself is the executable contract. Round caps, scratchpad keys,
spawn commands, model selection — all live in typed code, not prose.
mcp-cli's phase-graph migration was sprint 36; every sprint since has
been an order of magnitude easier to reason about during incidents.

**37. Don't cargo-cult DRY — the maintainer changed.** DRY optimizes for
human constraints (can't hold N call sites in working memory; editing N
sites by hand is error-prone) that mostly don't bind a Claude maintainer,
who can grep and edit all mirrors in one pass and even regenerate a file
wholesale from spec + tests. Meanwhile abstraction's cost — lost locality,
cross-file traversal to reassemble behavior — is exactly what burns a
context window. The robust seam is **abstract the nouns (shared data
contracts), duplicate the verbs (behavior)**, and the decision rule is
**abstract what changes together, duplicate what changes independently** —
which you can mine straight from git history (does a commit touch all
mirror-siblings together, or one at a time?). The one thing duplication
lacks vs. abstraction is enforcement of the invariant, so add that at the
*process* layer: a review check that asks "this fix has mirror-siblings —
did you replay it?" (the failure mode is a security/correctness fix landing
in 7 of 8 siblings), not a type-layer abstraction that re-introduces
coupling. Crucially, this constrains your lint rules: a rule must mechanize
an invariant, never enforce DRY for its own sake. (mcp-cli writeup:
`docs/architecture/duplication.md`.)

**38. A small pre-existing gate failure on `main` becomes a duplicate
cluster under parallel work.** When every fresh worktree runs the same
whole-repo pre-merge gate (coverage ratchet, lint, `am-i-done`), a small
*pre-existing* failure on `main` gets hit independently by every parallel
session — and each one redundantly (a) files an issue for it and (b) bundles
its own fix. Sprint 65 produced **five duplicate issues and three conflicting
fix-PRs** for one 66.7%-coverage shortfall; the fixes then collided on the
shared file. Two mechanizations: **workers** must search existing issues
before filing and treat a failure that reproduces on clean `main` as a
*shared gap to flag*, not a per-PR fix to bundle; the **orchestrator** must
de-bundle the shared gap to a single fast-track owner the moment a *second*
worktree hits it (one PR carries the fix, the rest rebase and drop their
copies) instead of letting it sprawl. When bootstrapping a sprint skill,
detect this risk by checking whether the project's pre-push gate is
**whole-repo (vs diff-scoped)** and whether `main` is currently green under
it — a whole-repo gate plus a near-threshold file is the setup for the
cluster. (Related: the gate may also be *masked* — if the ratchet runs after
a flaky-crash-prone step, a teardown segfault can abort the run before the
gate executes, letting the under-covered file slip onto `main` in the first
place.)

**39. The phase state machine's writes are the source of truth — never run
it preview-only in the live loop.** If the orchestration engine persists
phase state and a transition log (so later steps can infer "from" state),
running its decision step in dry-run/preview mode in the actual loop skips
those writes, and a subsequent transition fails with an "illegal/unapproved
transition" error because the prior state was never recorded. Preview modes
are for inspection, not for driving the pipeline. When bootstrapping, make
the per-tick loop call the real (writing) command and reserve any
`--dry-run` for ad-hoc inspection only.

**40. Threshold gates are for the early/middle of a budget window — near
reset, fire for effect.** A "freeze new work at ≥80% quota" rule protects
*mid-window* sessions from running dry mid-task. It is wrong at the end of
the window: if the budget resets in a few minutes and the pending work is
small, holding it just wastes the carryover. Gate on time-to-reset, not
utilization alone — spawn small work when the window is about to roll, and
respect the freeze only when there's enough of the window left to strand a
session.
