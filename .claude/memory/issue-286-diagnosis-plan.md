# Issue #286 Diagnosis Plan — Idle Timeout Kills Daemon During Sleep

## Problem Statement

When a laptop sleeps, the daemon shuts down and sessions are lost. The *assumed* mechanism is: sleep → WS disconnects → `hasActiveSessions()` returns false → idle timer fires → shutdown. But we don't have proof that WS disconnect is the actual trigger. Metrics (#70) and tracing (#293) are now landed — use them to diagnose before fixing.

## Prerequisites (already landed)

- **#70** — Prometheus metrics: `mcpd_active_sessions` gauge, `mcpd_ipc_requests_total`, tool call metrics, `GET /metrics` endpoint, `mcx metrics` command
- **#293** — W3C trace context: `daemon_id` in PID file and metrics snapshot, `worker_id` per worker, `trace_id` per operation, all persisted to `usage_stats`

## Diagnosis Steps

### Step 1: Capture baseline state before sleep

```bash
# Snapshot current metrics
mcx metrics -j > /tmp/metrics-before.json

# Record daemon_id from PID file
cat ~/.mcp-cli/mcpd.pid | jq .

# Note active sessions
mcx claude ls
mcx status -j > /tmp/status-before.json
```

### Step 2: Reproduce the bug

1. Spawn a Claude session: `mcx claude spawn --task "wait for instructions"`
2. Verify `mcx metrics -j | jq '.gauges[] | select(.name == "mcpd_active_sessions")'` shows value 1
3. Close laptop lid (sleep) for 2-3 minutes
4. Open laptop lid (wake)
5. Immediately run: `mcx status` — does it fail? Does it auto-start a new daemon?

### Step 3: Post-mortem analysis

If daemon died:
```bash
# Check if daemon restarted (different PID / daemon_id)
cat ~/.mcp-cli/mcpd.pid | jq .

# Check daemon logs for the shutdown sequence
mcx logs mcpd --lines 50

# Look for the specific idle timeout message
# Expected: "[mcpd] Idle timeout reached, shutting down"
# vs: "[mcpd] Shutting down..." (SIGTERM/explicit)

# Check usage_stats for the old daemon_id to see last activity
# The daemon_id from before sleep should show what happened
```

If daemon survived:
```bash
# Check if sessions reconnected
mcx claude ls
mcx metrics -j > /tmp/metrics-after.json

# Compare active_sessions gauge before/after
# Did it drop to 0 and come back? Or stayed at 1?
```

### Step 4: Identify the actual failure mode

The diagnosis will reveal one of these scenarios:

**Scenario A: WS disconnect → hasActiveSessions() false → idle timeout**
- Daemon logs show: `[mcpd] Idle timeout reached, shutting down`
- `mcpd_active_sessions` dropped to 0 during sleep
- Fix: Add grace period (`hasRecentSessions(graceMs)`)

**Scenario B: Worker crash during sleep → crash recovery fails**
- Daemon logs show: `[claude-server] Worker crash detected`
- Fix: Ensure crash recovery handles sleep/wake properly

**Scenario C: SIGTERM/SIGINT from OS during sleep**
- Daemon logs show: `[mcpd] Shutting down...` without idle timeout message
- Fix: Different — may need to handle OS sleep signals

**Scenario D: Bun process killed by OS (OOM, etc.)**
- No daemon logs at all (process was killed)
- PID file still exists but PID is dead
- Fix: Needs investigation into Bun's behavior during sleep

### Step 5: Implement the fix (depends on diagnosis)

**If Scenario A (most likely):**

Files to modify:
- `packages/daemon/src/claude-server.ts` — add `lastSessionSeenAt` timestamp updated on every `db:upsert` and `db:end`. Add `hasRecentSessions(graceMs): boolean` that returns true if active sessions exist OR `Date.now() - lastSessionSeenAt < graceMs`
- `packages/daemon/src/index.ts` — replace `claudeServer.hasActiveSessions()` with `claudeServer.hasRecentSessions(sessionGraceMs)` where `sessionGraceMs = Number(process.env.MCP_SESSION_GRACE_MS) || 10 * 60 * 1000`
- `packages/daemon/src/claude-server.spec.ts` — test `hasRecentSessions()`: returns false with no sessions ever, returns true within grace period after end, returns false after grace expires, returns true with active sessions regardless

**If another scenario:** File a new issue with findings.

## Key Files Reference

- `packages/daemon/src/index.ts:118-134` — idle timer logic
- `packages/daemon/src/claude-server.ts:160-162` — `hasActiveSessions()`
- `packages/daemon/src/claude-session/ws-server.ts` — WS connection lifecycle
- `packages/daemon/src/claude-session/session-state.ts` — session state machine
- `~/.mcp-cli/mcpd.pid` — PID file with daemon_id
- `~/.mcp-cli/state.db` — SQLite with usage_stats (now has daemon_id, trace_id)
