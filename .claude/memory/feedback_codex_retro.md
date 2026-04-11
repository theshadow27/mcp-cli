---
name: codex retro learnings
description: Process feedback from Codex self-repair session on #851 — stale binaries, partial branches, protocol drift
type: feedback
---

From Codex retro on #851 (Sprint 17):

**Stale dist/ binaries trap agents.** After source changes, agents assume the runtime reflects current code but dist/mcpd may be old. Always rebuild + restart daemon after merging code changes. Filed #864 for automated warning.

**Why:** Codex spent significant time debugging because the daemon was running a stale binary while source had the fix. Agents trust local code shape until forced to test the live path.

**How to apply:** After any sprint wind-down that merges daemon/codex/command changes, rebuild and restart before any further testing. Add "rebuild + restart" as explicit pre-flight step, not just a suggestion.

**Partial branches need status markers.** When preserving WIP to a branch, note in the issue/PR: "partial / untested / blocked by env." The `fix/codex-threadid-851` branch looked like a complete fix but was only a mitigation.

**How to apply:** When stashing agent work to a branch, always comment on the issue with the branch status.

**Protocol schemas drift from external tools.** Hand-written schemas in `packages/codex/src/schemas.ts` drifted from the real codex app-server contract. Need generated or verified schema sync.

**How to apply:** For agent providers (Codex, ACP, OpenCode), require spike-derived contract snapshots before implementation. Don't hand-write protocol types — derive from the actual tool.
