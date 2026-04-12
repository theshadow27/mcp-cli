---
name: Workers with background tasks DO get notified — don't micromanage
description: When a worker session reports "waiting for the notification" on a background bash task, the Claude Code harness does send a completion notification. Ask how long it's been running rather than telling the worker to poll manually.
type: feedback
originSessionId: 44800ee9-7f9e-4576-9ba9-0f8f61034d82
---
Workers running background bash jobs get automatic completion notifications from the Claude Code harness. "I'll wait for the notification" is correct behavior, not a stall.

**Why:** Sprint 33 #1294 session idled with "I'll wait for the notification" after launching a full test suite in background. I assumed she was stalled and told her to poll with BashOutput in a loop. User corrected: the harness DOES notify on background-task completion — she was just waiting for a long-running test suite. Micromanaging her into polling both wastes tokens and is technically wrong for how the harness works.

**How to apply:**
- If a worker says "waiting for the notification" or similar, don't push polling instructions.
- If the wait feels too long, ask: `mcx claude send <id> "How long has your background task been running? Is it actually progressing, or hung?"` — that lets the worker self-diagnose.
- Only intervene when you have evidence the background task is actually stuck (e.g. the worker has been idle far longer than the test suite's known runtime).
- Remember: the orchestrator usually doesn't know what background task the worker launched. Asking > prescribing.
