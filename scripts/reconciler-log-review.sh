#!/bin/bash
# Transient-404 guard log review.
#
# Scans nanoclaw logs for the reconciler's 'missing once → deferred'
# and 'missing twice → resolved' traces. Run 48h after deploying the
# guard to confirm it's firing in prod and actually catching transient
# 404s (vs resolving on every first-miss).
#
# Usage: ./scripts/reconciler-log-review.sh
set -euo pipefail

LOG="${NANOCLAW_LOG:-/Users/topcoder1/dev/nanoclaw/logs/nanoclaw.log}"

[[ -f "$LOG" ]] || { echo "log not found: $LOG" >&2; exit 1; }

echo "=== Transient-404 guard observations ==="
echo "Log: $LOG ($(wc -l < "$LOG" | tr -d ' ') lines)"
echo

deferred=$(grep -c "missing once → deferred" "$LOG" || true)
resolved=$(grep -c "missing twice in a row → resolved" "$LOG" || true)
check_fail=$(grep -c "Gmail reconciler: thread check failed" "$LOG" || true)
timeout_hits=$(grep -cE "timeout after [0-9]+ms: getThreadInboxStatus" "$LOG" || true)
empty_skips=$(grep -c "previous tick still in flight" "$LOG" || true)

printf '  Deferred (seen missing once):        %s\n' "$deferred"
printf '  Resolved after 2x missing:           %s\n' "$resolved"
printf '  Thread-check failures (any cause):   %s\n' "$check_fail"
printf '  Per-call timeouts:                   %s\n' "$timeout_hits"
printf '  In-flight tick skips:                %s\n' "$empty_skips"
echo

echo "=== Last 20 deferred/resolved events ==="
grep -E "missing once → deferred|missing twice in a row → resolved" "$LOG" | tail -20 || true
echo

echo "=== Last 10 timeouts ==="
grep -E "timeout after [0-9]+ms: getThreadInboxStatus" "$LOG" | tail -10 || true

echo
echo "Interpretation:"
echo "  Deferred>0 & Resolved>0 : guard working (some transient, some real)."
echo "  Deferred>0 & Resolved=0 : every first-miss was transient — great catch."
echo "  Deferred=0              : queue stayed clean; guard never triggered."
echo "  Timeouts>0              : per-call timeout saved us from hangs."
