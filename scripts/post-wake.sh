#!/usr/bin/env bash
# post-wake.sh — Run IMMEDIATELY after opening the laptop lid.
# Compares daemon state against pre-sleep snapshot.
set -euo pipefail

OUT=/tmp/mcpd-sleep-diag

if [ ! -d "$OUT" ]; then
  echo "ERROR: No pre-sleep data at $OUT — run pre-sleep.sh first"
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MCX="$SCRIPT_DIR/../dist/mcx"

echo "=== Post-wake capture: $(date -Iseconds) ==="
echo ""

BEFORE_PID=$(cat "$OUT/daemon-pid.txt" 2>/dev/null || echo "unknown")
BEFORE_ID=$(cat "$OUT/daemon-id.txt" 2>/dev/null || echo "unknown")
BEFORE_TS=$(head -1 "$OUT/timestamp-before.txt" 2>/dev/null || echo "0")
NOW_TS=$(date +%s)
ELAPSED=$(( NOW_TS - BEFORE_TS ))

echo "Sleep duration: ~${ELAPSED}s (~$(( ELAPSED / 60 ))m)"
echo "Pre-sleep daemon PID: $BEFORE_PID"
echo "Pre-sleep daemon ID:  $BEFORE_ID"
echo ""

# 1. Is the old process still alive?
echo "--- Process check ---"
if kill -0 "$BEFORE_PID" 2>/dev/null; then
  echo "ALIVE: Process $BEFORE_PID still running"
  PROCESS_ALIVE=true
else
  echo "DEAD: Process $BEFORE_PID is gone"
  PROCESS_ALIVE=false
fi

# 2. Does the PID file still exist? Same daemon?
echo ""
echo "--- PID file check ---"
if [ -f ~/.mcp-cli/mcpd.pid ]; then
  cp ~/.mcp-cli/mcpd.pid "$OUT/pid-after.json"
  AFTER_PID=$(cat ~/.mcp-cli/mcpd.pid | python3 -c "import sys,json; print(json.load(sys.stdin)['pid'])" 2>/dev/null || echo "parse-error")
  AFTER_ID=$(cat ~/.mcp-cli/mcpd.pid | python3 -c "import sys,json; print(json.load(sys.stdin).get('daemonId','unknown'))" 2>/dev/null || echo "parse-error")
  echo "PID file exists: pid=$AFTER_PID daemonId=$AFTER_ID"
  if [ "$AFTER_ID" = "$BEFORE_ID" ]; then
    echo "SAME daemon instance"
  else
    echo "DIFFERENT daemon instance (restarted!)"
  fi
else
  echo "PID file MISSING"
  AFTER_PID="none"
  AFTER_ID="none"
fi

# 3. Daemon log — extract entries AFTER the pre-sleep snapshot
echo ""
echo "--- Daemon log (new entries since pre-sleep) ---"
BEFORE_LINES=$(cat "$OUT/log-linecount-before.txt" 2>/dev/null || echo "0")
if [ -f ~/.mcp-cli/mcpd.log ]; then
  AFTER_LINES=$(wc -l < ~/.mcp-cli/mcpd.log)
  NEW_LINES=$(( AFTER_LINES - BEFORE_LINES ))
  if [ "$NEW_LINES" -gt 0 ]; then
    tail -n "$NEW_LINES" ~/.mcp-cli/mcpd.log > "$OUT/log-new-entries.txt"
    echo "$NEW_LINES new log lines:"
    cat "$OUT/log-new-entries.txt"
  else
    echo "No new log entries (daemon may have been killed without logging)"
  fi
else
  echo "Log file missing!"
fi

# 4. Try to get metrics from daemon (may fail if dead)
echo ""
echo "--- Metrics (post-wake) ---"
if $MCX metrics -j > "$OUT/metrics-after.json" 2>/dev/null; then
  echo "Metrics captured from daemon"
  # Compare active_sessions
  python3 -c "
import json, sys
try:
    before = json.load(open('$OUT/metrics-before.json'))
    after = json.load(open('$OUT/metrics-after.json'))
    def find_gauge(data, name):
        for g in data.get('gauges', []):
            if g['name'] == name:
                return g['value']
        return None

    for name in ['mcpd_active_sessions', 'mcpd_uptime_seconds', 'mcpd_servers_total']:
        b = find_gauge(before, name)
        a = find_gauge(after, name)
        print(f'  {name}: {b} → {a}')

    before_id = before.get('daemonId', 'unknown')
    after_id = after.get('daemonId', 'unknown')
    if before_id != after_id:
        print(f'  WARNING: daemonId changed: {before_id} → {after_id}')
except Exception as e:
    print(f'  Error comparing metrics: {e}')
" 2>/dev/null || echo "  (comparison failed)"
else
  echo "Cannot reach daemon (dead or not responding)"
fi

# 5. Session list
echo ""
echo "--- Sessions (post-wake) ---"
$MCX claude ls 2>/dev/null > "$OUT/sessions-after.txt" && cat "$OUT/sessions-after.txt" || echo "Cannot reach daemon"

# 6. Diagnosis
echo ""
echo "============================================"
echo "=== DIAGNOSIS ==="
echo "============================================"

# Check log for shutdown reason
if [ -f "$OUT/log-new-entries.txt" ]; then
  if grep -q "Idle timeout reached, shutting down" "$OUT/log-new-entries.txt"; then
    echo ""
    echo ">>> SCENARIO A: Idle timeout killed daemon <<<"
    echo "WS connections dropped during sleep, hasActiveSessions() returned false,"
    echo "and the idle timer shut down the daemon."
    if grep -q "active WebSocket session" "$OUT/log-new-entries.txt"; then
      echo ""
      echo "Timeline:"
      grep "Idle timeout\|active WebSocket\|Shutting down\|Worker crash" "$OUT/log-new-entries.txt" || true
    fi
  elif grep -q "Worker crash" "$OUT/log-new-entries.txt"; then
    echo ""
    echo ">>> SCENARIO B: Worker crash during sleep <<<"
    grep "Worker crash\|Restarting\|Failed to restart" "$OUT/log-new-entries.txt" || true
  elif grep -q "Shutting down" "$OUT/log-new-entries.txt" && ! grep -q "Idle timeout" "$OUT/log-new-entries.txt"; then
    echo ""
    echo ">>> SCENARIO C: SIGTERM/SIGINT killed daemon <<<"
    echo "Daemon received a signal (not idle timeout)."
  else
    echo ""
    echo ">>> Log entries exist but no clear shutdown pattern <<<"
  fi
elif [ "$PROCESS_ALIVE" = "false" ]; then
  echo ""
  echo ">>> SCENARIO D: Process killed without logging <<<"
  echo "No new log entries and process is dead — OS killed the process"
  echo "(OOM, SIGKILL, etc.)"
else
  echo ""
  echo ">>> Daemon survived sleep! <<<"
  echo "Process is still alive. Check if sessions reconnected."
fi

echo ""
echo "Full data saved to $OUT/"
echo "Files: $(ls $OUT/)"
