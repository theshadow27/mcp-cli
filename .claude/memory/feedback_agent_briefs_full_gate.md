---
name: feedback_agent_briefs_full_gate
description: "When briefing agents to edit code, tell them to run the full am-i-done gate, not a hand-picked subset of checks"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: dbb5c82e-1515-4d5f-a989-0c11c9732fbf
---

When dispatching agents to make code edits, instruct them to run `bun run am-i-done` (the full local gate) before reporting — NOT a hand-picked subset like "run tsc + tests."

**Why:** In sprint-62 remediation (#2344) I briefed no-raw-spawn agents to run `tsc` + tests but omitted `lint:check`. The commit then failed pre-commit with 15 biome errors (non-null assertions, formatting). This is the *same* failure mode as the bug being fixed: an incomplete oracle. An agent told to run a subset has an incomplete definition of done and will leave gate-failing work behind.

**How to apply:** Agent briefs that edit code end with "run `bun run am-i-done` and confirm it passes (exit 0)" — am-i-done is the single source of truth ([[feedback_trust_gate_exit_code]]). Also: when partitioning a multi-file fix across parallel agents, enumerate ALL packages — I partitioned into command/daemon/control/core/acp/opencode and silently missed `codex`/`clone`/`permissions`, leaving a straggler violation.
