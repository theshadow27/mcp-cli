---
name: feedback_trust_gate_exit_code
description: "Verify \"is it clean?\" via the gate's exit code, not an ad-hoc grep of its output"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: dbb5c82e-1515-4d5f-a989-0c11c9732fbf
---

To check whether a gate (sweep, tests, lint) is clean, use its **exit code**, not a grep of its stdout.

**Why:** During #2344 I checked `bun run doing-it-wrong` cleanliness with `grep -E "violations across"` — but a single violation prints `"1 violation across 1 rule"` (singular "violation"), which my plural pattern missed, so I read a dirty tree as clean and committed past a real straggler (codex-process.ts). The `am-i-done` gate later caught it via exit code. The ad-hoc grep was itself an incomplete oracle — the recurring theme of this whole effort.

**How to apply:** `cmd > /dev/null 2>&1 && echo CLEAN || echo DIRTY`, or run the real gate (`am-i-done`) and read its exit status. Reserve output-grepping for *locating* findings, never for the pass/fail decision.
