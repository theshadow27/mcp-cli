#!/bin/bash
# Segfault reproduction test — runs the worker-heavy test subset N times
# and counts crashes. Captures stderr for crashed runs to a per-label
# directory so bun.report URLs are preserved.
#
# Usage: ./segfault-test-v2.sh <bun-binary> <runs> <label>

BUN="${1:-bun}"
RUNS="${2:-100}"
LABEL="${3:-$BUN}"
TEST_FILES="packages/daemon/src test/cli-orchestration.spec.ts test/daemon-integration.spec.ts test/stress.spec.ts test/transport-errors.spec.ts"
LOGFILE="/tmp/segfault-${LABEL// /-}.log"
CRASHDIR="/tmp/segfault-${LABEL// /-}.crashes"
mkdir -p "$CRASHDIR"

crashes=0
passes=0
other_failures=0

log() {
    echo "$1"
    echo "$1" >> "$LOGFILE"
}

log "[$LABEL] Starting $RUNS runs with $($BUN --revision 2>/dev/null || $BUN --version)"
log "[$LABEL] Test files: $TEST_FILES"
log "[$LABEL] Crash output dir: $CRASHDIR"
log ""

for i in $(seq 1 $RUNS); do
    output=$(/opt/homebrew/bin/timeout 300 $BUN test $TEST_FILES 2>&1)
    exit_code=$?

    if [ $exit_code -eq 124 ]; then
        other_failures=$((other_failures + 1))
        printf -v runtag "run-%03d-timeout" "$i"
        echo "$output" > "$CRASHDIR/$runtag.log"
        msg=$(printf "[$LABEL] Run %3d: TIMEOUT (5m)" "$i")
        log "$msg"
        continue
    fi

    if echo "$output" | grep -q "Segmentation fault\|panic.*Segmentation\|bun.report"; then
        crashes=$((crashes + 1))
        printf -v runtag "run-%03d-segfault" "$i"
        echo "$output" > "$CRASHDIR/$runtag.log"
        url=$(echo "$output" | grep -oE 'https://bun.report/[^ )]+' | head -1)
        msg=$(printf "[$LABEL] Run %3d: SEGFAULT (total: %d/%d = %.0f%%) %s" "$i" "$crashes" "$i" "$(echo "scale=0; $crashes * 100 / $i" | bc)" "$url")
        log "$msg"
    elif [ $exit_code -ne 0 ]; then
        other_failures=$((other_failures + 1))
        printf -v runtag "run-%03d-fail-%d" "$i" "$exit_code"
        echo "$output" > "$CRASHDIR/$runtag.log"
        msg=$(printf "[$LABEL] Run %3d: FAIL (exit %d)" "$i" "$exit_code")
        log "$msg"
    else
        passes=$((passes + 1))
        if [ $((i % 10)) -eq 0 ]; then
            msg=$(printf "[$LABEL] Run %3d: ok (crashes so far: %d/%d = %.0f%%)" "$i" "$crashes" "$i" "$(echo "scale=0; $crashes * 100 / $i" | bc)")
            log "$msg"
        fi
    fi
done

log ""
log "=== [$LABEL] RESULTS ==="
log "  Runs:           $RUNS"
log "  Passes:         $passes"
log "  Segfaults:      $crashes"
log "  Other failures: $other_failures"
if [ $RUNS -gt 0 ]; then
    log "  Segfault rate:  $(echo "scale=1; $crashes * 100 / $RUNS" | bc)%"
fi
log "========================"
log ""
log "Unique crash URLs:"
grep -horE 'https://bun.report/[^ )]+' "$CRASHDIR" 2>/dev/null | sort | uniq -c | sort -rn | while read line; do log "  $line"; done
