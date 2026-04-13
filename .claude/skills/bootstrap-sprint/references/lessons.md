# Lessons from 30 Sprints

These lessons were extracted from retrospectives across 30 autonomous sprints that
shipped over 1,000 issues. They are general-purpose — not about any specific
technology, but about how autonomous sprint systems behave in practice.

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

**30. Check repo ownership early — merge queue is org-only on GitHub.**
Sprints that ship 15 PRs in parallel create an N² rebase cascade: each
merge invalidates the others, so every auto-merge blocks on `BEHIND`.
GitHub's merge queue solves this natively — but **only for
Organization-owned repos on Team or Enterprise Cloud plans.** User-owned
repos (personal accounts) cannot enable merge queue at any tier, and the
option simply does not appear in the UI. During discovery, check
`gh api users/<owner> --jq .type` — if it returns `User`, merge queue is
off the table. The substitute is a long-lived sonnet "mergemaster"
session (no worktree, only `gh pr update-branch --rebase` + poll CI +
let auto-merge fire), started at sprint kickoff and fed PRs as they hit
`qa:pass`. Document this trade-off explicitly in the generated sprint
skill so the next operator knows *why* the workflow uses an agent
instead of the native feature. Many consumers of this skill will be on
orgs and should prefer the native queue; individual maintainers often
migrate single-project repos into a personal org specifically to unlock
merge queue and other collaboration-scale features (team-level
CODEOWNERS, per-team runner groups, IP allowlisting, SSO). Mention both
paths in the generated skill's pre-flight section.
