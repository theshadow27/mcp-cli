#!/usr/bin/env bash
# pre-sleep.sh — Run BEFORE closing the laptop lid.
# Captures daemon state so we can compare after wake.
set -euo pipefail

OUT=/tmp/mcpd-sleep-diag
rm -rf "$OUT"
mkdir -p "$OUT"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MCX="$SCRIPT_DIR/../dist/mcx"

echo "=== Pre-sleep capture: $(date -Iseconds) ==="

# 1. PID file
if [ -f ~/.mcp-cli/mcpd.pid ]; then
  cp ~/.mcp-cli/mcpd.pid "$OUT/pid-before.json"
  PID=$(cat ~/.mcp-cli/mcpd.pid | python3 -c "import sys,json; print(json.load(sys.stdin)['pid'])")
  DAEMON_ID=$(cat ~/.mcp-cli/mcpd.pid | python3 -c "import sys,json; print(json.load(sys.stdin).get('daemonId','unknown'))")
  echo "Daemon PID: $PID"
  echo "Daemon ID:  $DAEMON_ID"
  echo "$PID" > "$OUT/daemon-pid.txt"
  echo "$DAEMON_ID" > "$OUT/daemon-id.txt"
else
  echo "ERROR: No PID file — daemon not running?"
  exit 1
fi

# 2. Metrics snapshot
$MCX metrics -j > "$OUT/metrics-before.json" 2>/dev/null && echo "Metrics captured" || echo "WARN: metrics failed"

# 3. Status snapshot
$MCX status -j > "$OUT/status-before.json" 2>/dev/null && echo "Status captured" || echo "WARN: status failed"

# 4. Session list
$MCX claude ls 2>/dev/null > "$OUT/sessions-before.txt" && echo "Sessions captured" || echo "WARN: sessions failed"

# 5. Daemon log tail (last 100 lines)
tail -100 ~/.mcp-cli/mcpd.log > "$OUT/log-tail-before.txt" 2>/dev/null && echo "Log tail captured" || echo "WARN: log tail failed"

# 6. Record log file size for post-wake diff
wc -l < ~/.mcp-cli/mcpd.log > "$OUT/log-linecount-before.txt" 2>/dev/null

# 7. Timestamp
date +%s > "$OUT/timestamp-before.txt"
date -Iseconds >> "$OUT/timestamp-before.txt"

echo ""
echo "Saved to $OUT/"
echo "Active sessions gauge:"
cat "$OUT/metrics-before.json" | python3 -c "
import sys, json
data = json.load(sys.stdin)
for g in data.get('gauges', []):
    if 'session' in g['name'].lower():
        print(f\"  {g['name']} = {g['value']}\")
found = any('session' in g['name'].lower() for g in data.get('gauges', []))
if not found:
    print('  (no session gauges — spawn a session first!)')
" 2>/dev/null || true

echo ""
echo "Now close the laptop lid. After wake, run:"
echo "  bash scripts/post-wake.sh"
