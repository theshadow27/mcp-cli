---
name: flaky test fix policy
description: Flaky/CI-instability issues require a nerd-snipe root-cause investigation BEFORE implementation; opus impl + adversarial review only after the trail is documented on the issue
type: feedback
---

Flaky test (and CI-instability) issues require a nerd-snipe planning pass
**before** implementation, then opus implementation + adversarial review.

**Why:** Sprint 15-19 saw "fix → re-break" cycles where flaky tests were
patched with longer timeouts or retry loops that papered over the race.
Sprint 47 repeated the pattern at a higher altitude: a deterministic
post-#1835 coverage crash was misdiagnosed as a Bun upstream segfault
(filed under #1004) and the response was a CI retry workaround — which the
same retro acknowledged "hits on every sprint PR." The actual root cause
was a `claude --version` probe added by #1835 that the test mock didn't
handle, plus `process.exit()` truncating a 500 KB stderr write at the
kernel pipe buffer (#1870, found 2026-04-29 by nerd-snipe). Skipping the
root-cause step was what made both eras of failures recur.

**How to apply:** When the sprint plan has a flaky / CI-instability issue
(title contains "flaky", label `flaky`, or symptom is "CI fails
intermittently / deterministically without a clear test-code error"):

1. **Pre-implementation gate — nerd-snipe first.** Spawn the
   `nerd-snipe` agent on opus with the repro, the suspected commit
   range, and any prior bad diagnoses. Its job is to identify the actual
   root cause and a concrete fix plan.
2. **Trail goes on the issue.** nerd-snipe must post its findings as a
   comment on the GitHub issue (timeline, bisect log, mechanism, the fix
   plan). The trail being on the issue — not in an ephemeral session
   transcript — is what stops the next sprint from re-running the same
   misdiagnosis.
3. **Hard gate.** If nerd-snipe cannot find both root cause AND a
   concrete solution, the issue does NOT proceed to implementation. Add
   the `needs-attention` label and stop. The orchestrator surfaces it
   for manual review at next sprint review. Do not let an unresolved
   investigation slide into "spawn opus impl and hope."
4. **Then implement on opus** (never sonnet) using the fix plan from
   the issue comment as the spec.
5. **Always adversarial review.** Reviewer verifies the implementation
   matches the documented root cause — not just "tests pass now."
   Reject fixes that increase timeouts, add retries, or otherwise mask
   the symptom without addressing the mechanism in nerd-snipe's writeup.
