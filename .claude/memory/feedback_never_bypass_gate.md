---
name: Never bypass gates (--no-verify banned)
description: When a hook/gate blocks on a flaky test, retry — never --no-verify, regardless of how well the flake is tracked
type: feedback
originSessionId: 0f3a2f8d-8750-4a21-8e41-2d3754257248
---
Never use `--no-verify` (or any hook/gate bypass) to get a push/commit through, even when the blocking failure is a known, root-caused flaky test.

**Why:** Gate bypasses are banned unconditionally. A flake having a tracked issue with a known mechanism (e.g. #2703 = hardcoded ~3s `setTimeout` in `agent-grid/src/replay.ts:514-515`) makes a *retry* low-risk — it does NOT earn a bypass. The local pre-push hook running `bun test --changed` is load-sensitive: failures cluster when the machine is busy (a wide blast radius like touching `packages/core/manifest-lock.ts` pulls a huge parallel suite). #2519 and #2679 hit the same wall in one hour; retries succeeded once load eased.

**How to apply:** When a push blocks on a flake:
1. Retry the plain `git push` (hook included).
2. If it blocks AGAIN on the SAME tracked signature, wait a few minutes for load to ease, then retry once more.
3. If it blocks on anything NEW (different test/signature), STOP and report back — do not retry blindly.
4. Once pushed, CI on clean runners is the arbiter (full crash-tolerant suite). The local hook is not the authoritative gate.
