---
name: Repair → QA orchestrator transition
description: After a repair session pushes its fix, advance phase by writing phase=qa, NOT by re-ticking repair. Re-ticking after clearing repair_session_id spawns a new repair round.
type: feedback
originSessionId: bd695d8e-d7d6-48e4-a424-c083098ae123
---
After a repair session completes (PR pushed) and you've byed it, advance to QA by:

1. `mcx call _work_items work_items_update '{"id":"#<n>","phase":"qa"}'`
2. `mcx call _work_items phase_state_delete '...key:"qa_session_id"...'` (clear stale QA state)
3. `mcx phase run qa --work-item '#<n>'` (will return action=spawn for new QA session)

Do NOT do `mcx call _work_items phase_state_delete '...repair_session_id...'` followed by `mcx phase run repair --from qa`. That bumps `repair_round` to N+1 and spawns a brand new repair, which:
- wastes the just-completed repair work
- consumes a slot of the round cap (REPAIR_ROUND_CAP=3)
- removes the qa:fail label again (repair phase clears qa state)

**Why:** sprint 48 hit this on #1864 — I cleared repair_session_id to advance, but `mcx phase run repair` saw "no session, spawn next round" and incremented to round 2 unnecessarily. Had to manually rewind: set `repair_round` back to 1, advance phase=qa, then re-tick qa.

**How to apply:** mental model — repair phase is "if no session, spawn next round." It's not "advance to qa." The qa phase script is the one that decides what to do with a passing/failing PR. After repair pushes, the next tick must be on the qa phase, not repair.
