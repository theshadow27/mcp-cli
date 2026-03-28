# Lessons from 22 Sprints

These lessons were extracted from retrospectives across 22 autonomous sprints that
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
