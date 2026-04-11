---
name: Workers are conversations, not batch jobs
description: Orchestrator must interact with spawned sessions via send — answer questions, approve plans, redirect mistakes — not just bye and respawn
type: feedback
---

Spawned sessions are full Claude sessions, not fire-and-forget scripts. They can ask questions, request plan approval, get stuck, or go off track — just like you do with the user.

**Why:** Sprint 30 — session `ab5433ee` (#1168) asked "Shall I proceed with this plan?" and the orchestrator bye'd and respawned instead of sending "Yes, proceed." Cost: $0.44 wasted + slot delay + fresh session cost. The orchestrator also closed PR #1199 (125k deletions) without first sending the worker guidance about the corrupted worktree state.

**How to apply:** When `wait` returns a completed session with low cost (<$0.50) or few turns (<15), always `mcx claude log <id>` before bye-ing. If the worker asked a question or is waiting for approval, respond via `mcx claude send <id> "<answer>"`. Respawning discards all worker context — a single `send` is almost always cheaper. Ask: what additional context would allow this task to complete as intended? Send that.
