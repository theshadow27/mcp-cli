---
name: 5-minute prompt cache TTL — never wait ≥ 5 minutes
description: Claude Code's prompt cache has a 5-minute TTL. Any blocking tool call ≥ 300s blows the cache and incurs full input-token cost on the next turn. Hard cap all blocking waits at 270s (4:30).
type: user
originSessionId: 44800ee9-7f9e-4576-9ba9-0f8f61034d82
---
**Hard rule: max 270s (4:30) for any blocking tool call.** Never 300s or above.

**Why:** Anthropic/Claude's prompt cache has a default 5-minute TTL. Every cache hit resets the timer (free). If more than ~5 minutes pass between messages, the cache expires and the next turn pays full input-token price to re-process the entire context (often 100k–300k+ tokens). On an orchestration session with lots of accumulated context, a single cache-miss can cost dollars that would have been fractions of a cent with a warm cache.

**Applies to:**
- `mcx claude wait --timeout N` — never ≥ 300000
- Bash tool `timeout` param — never ≥ 300000 unless no cache-relevant text comes back from the call
- Any run_in_background poll cycle — always cap the sleep at 270s
- Any `ScheduleWakeup delaySeconds` — stay under 270 if you need the cache warm; otherwise commit to 1200+ and accept the miss

**How to apply:**
- Default `mcx claude wait --timeout 270000` (4:30)
- For event-driven waits that might return quickly anyway, 270000 costs nothing if an event fires at second 10 — the cap just prevents worst-case stalls
- If genuinely nothing-is-happening and you need to wait longer, break into multiple 270s waits with a cheap no-op in between to keep the cache warm (each wait counts as a turn and refreshes the TTL)
