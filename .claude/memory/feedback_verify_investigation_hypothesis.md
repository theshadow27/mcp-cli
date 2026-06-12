---
name: Verify an investigation's hypothesis reproduces before implementing its prescribed fix
description: When a linked investigation/go-no-go prescribes a fix, empirically reproduce the root cause first; if it doesn't reproduce, do the real root-cause fix and report the discrepancy with evidence
type: feedback
originSessionId: d1763d2e-c218-4295-bdcb-a87a9f349f12
---
When a task hands you an authoritative-sounding investigation (a long issue comment, a go/no-go verdict, a named "minimum item to land") that prescribes a specific fix in specific files, **reproduce the claimed root cause before implementing the prescription.**

**Why:** On #2740 the prescribed fix was "teardown-ordering race: `budget-watcher.spec.ts` (and other event-bus consumers) call `db.close()` while a subscribed consumer's `eventLog.append()` is still pending — unsubscribe before close." Empirically: `budget-watcher.spec.ts` never calls `db.close()` (only `unlinkSync`), its bus has no `EventLog`, and its `afterEach` already disposes the watcher first. Running the **entire** `packages/daemon` suite produced exactly **2** "Cannot use a closed database" errors — both from the *intentional* negative-path test at `event-bus.spec.ts:537` that closes the db and publishes twice on purpose. Since `EventBus`/`EventLog` live only in `packages/daemon`, that's conclusive: the cross-test race did not exist. The investigator had seen that intentional test's leaked `console.error` in the parallel log next to the real flaky failure and built a teardown-race hypothesis around it.

**How to apply:**
- Treat the prescription as a strong prior, not ground truth. Run the repro (`bun test <pkg>`, count the symptom, isolate by spec, exclude the obvious intentional source) before editing.
- If it doesn't reproduce, do **not** make a no-op/cargo-cult change to the named file just to comply. Find and fix the *actual* root cause, then report the discrepancy to the user with the evidence (counts, stack lines, which spec).
- Real fix on #2740's secondary: the intentional fallback test leaked expected stderr → capture it with `spyOn(console, "error").mockImplementation(...)` and assert the message, so it stops polluting the parallel log and misleading future investigators. This is *not* the forbidden "swallow the production append error" — the production try/catch fallback is the behavior under test.
- The user values this: they pushed back hard on a curt dismissal, but the resolution they accept is evidence, not compliance.
