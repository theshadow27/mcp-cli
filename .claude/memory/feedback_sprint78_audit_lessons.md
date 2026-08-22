---
name: feedback_sprint78_audit_lessons
description: sprint 78 audit — the rework is one repeating defect class, stalls drop sequenced-but-unspawned issues, and nobody supervises the orchestrator
metadata:
  type: feedback
---

An independent auditor measured sprint 78 (11h21m): **66.8% active work, 31% unattended
stall, 64% of code commits were rework.** The PR that passed review first time landed in
35 minutes; the ones that did not averaged 4h14m of active time. Rework is a ~7x
multiplier and 9 of 10 PRs needed it.

**1. The rework is ONE class, not scattered.** #1510, #935 and #3034 all failed round 1
on the same shape: *a safety invariant applied at some call sites but not all, or a
failure path that falls open instead of closed.* Three issues, three authors, ~6 of 18
rounds. Put this in every impl brief:

> Name the invariant your change enforces. Enumerate **every** call site that must uphold
> it and show the check at each one — not the ones you added, all of them. If a path can
> fail, state whether it fails open or closed and why that is right. A guard at four of
> five call sites is not a guard.

Cf. [[feedback_verify_investigation_hypothesis]] — and Bob's #3168 rule, which silently
passed on four of five workers and was only caught because he enumerated instead of
asserting. **A rule is not evidence until you have watched it fail.**

**2. A stall drops sequenced-but-unspawned work.** #3038 was sequenced ~08:25, did not
survive the 09:52-13:20 quota gap, and was never picked back up — no branch, no PR, no
mention. The resume prompt is written from what is *visible*, and an issue sequenced but
not yet spawned is invisible. **After any stall, diff what was in flight before against
what the resume prompt names.**

**3. Nobody supervises the orchestrator.** Worker supervision is good (a frozen worker was
caught in ~5 min). The orchestrator has no watchdog, so 2h20m elapsed after quota had
already reset. `resetsAt` was in the payload the whole time and nothing fires on rollover
— filed as #3182 (`quota.window_reset`). Cf. [[feedback_halt_needs_durable_artifact]].

**4. Freeze scope at round 1; cap fillers at 2 repair rounds.** #3127 (scrutiny `low`, a
filler) took 5 rounds and 10h46m — more rounds than the foundation epic — partly because
`guardInterrupts` was requested mid-repair and then withdrawn. Scope arriving after work
is underway is the most expensive thing an orchestrator does to a worker. If a filler
needs a third round it is not a filler.

**5. Read git times as UTC explicitly.** `git log --date=format:...` renders the
*committer's* offset. I read `11:19:37-04:00` as UTC and told the user main had been
frozen 5h+; it was 1h27m. Use `TZ=UTC git log --format=%cI` before characterizing a
drought to anyone.

**6. The day's dominant defect: a test or rule that asserts a MENTION, not the BEHAVIOUR.**
Three instances on 2026-08-22, from three different angles:
- a `doing-it-wrong` rule whose brace matcher landed on the `{` of a return-type
  annotation, so it silently passed on four of five workers — inside the rule written to
  catch silent passes;
- my requested fix for the `domain rename` bug, whose obvious test
  (`domainSnapshotEquals(base, {...base, name:"renamed"}) === false`) passes identically
  before and after the fix, leaving the real invariant (`sync()` does not drop the worker)
  untested;
- a rule asserting that `handleWait` *mentions* the domain filter rather than *honours*
  it — green on all five workers while four lost events on the replay path.

**A test or rule that passes while the thing it names is broken is not evidence.** Same
family as my #3034 acceptance criteria requiring the `domain_id` column to exist rather
than a writer and a reader (#3155). Put it in every impl brief: exercise the guard against
a known violation, and assert on the seam that would actually regress.

**7. My own orchestrator watchdog reproduced the bug it was built to prevent — twice.**
v1 keyed on `rateLimited` flipping false; that flag is **sticky** (#3104) and never flipped,
so the quota arm never fired. v2 added an idle arm but shared one 30-minute nudge gap with
it, so a **67-minute** stall logged "held" seven times and nobody came. Meanwhile the
session's own last message said `You've hit your session limit · resets 9:10pm (UTC)` — the
resume time was sitting in plain text the whole hour.

**Do not build a watchdog on a status flag.** Watch the two things that cannot lie — *is
the turn over* and *did the token count move* — and **re-nudge on a short cadence (10 min)
for as long as both stay true**. A redundant nudge costs a few hundred tokens; a missed one
costs an hour of sprint. Escalate loudly after ~4 unanswered nudges rather than going quiet.
Cf. [[feedback_dont_end_on_passive_wait]], [[feedback_quota_status_staleness]].
