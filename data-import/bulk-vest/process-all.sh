#!/bin/bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# © 2026 Michael Maurizi Jr.

# No set -e — background job management needs flexible error handling
# Individual states have set -e in process-state.sh

# Process all pending states from states.csv (one tileset per state, multi-year voting)
# Runs up to MAX_PARALLEL states concurrently.
# Usage: ./scripts/bulk-vest/process-all.sh [--state XX] [--dry-run] [--parallel N] [--update-only] [--no-publish]

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
CSV_FILE="$SCRIPT_DIR/states.csv"
DEV_DATA="$PROJECT_DIR/dev-data"

# Parse args
FILTER_STATE=""
DRY_RUN=false
MAX_PARALLEL=3
UPDATE_ONLY=false
NO_PUBLISH=false

# Largest states (by staging geojson size) — run one-at-a-time in phase 2
BIG_STATES=(TX CA)

is_big_state() {
  local s="$1"
  for big in "${BIG_STATES[@]}"; do
    [[ "$s" == "$big" ]] && return 0
  done
  return 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --state) FILTER_STATE="$2"; shift 2 ;;
    --dry-run) DRY_RUN=true; shift ;;
    --parallel) MAX_PARALLEL="$2"; shift 2 ;;
    --update-only) UPDATE_ONLY=true; shift ;;
    --no-publish) NO_PUBLISH=true; shift ;;
    *) echo "Unknown arg: $1"; exit 1 ;;
  esac
done

# In update-only mode we re-process states that have already been published
# (since we're refreshing votes on existing output dirs). Otherwise we only
# touch states with status=pending.
if $UPDATE_ONLY; then
  TARGET_STATUS="published"
else
  TARGET_STATUS="pending"
fi
export UPDATE_ONLY
export NO_PUBLISH

if $UPDATE_ONLY && $NO_PUBLISH; then
  echo "ERROR: --update-only and --no-publish are mutually exclusive"
  exit 1
fi

mkdir -p "$DEV_DATA/census-cache" "$DEV_DATA/staging" "$DEV_DATA/output"

# Build manage TypeScript and ensure Docker deps are installed
echo "Building manage..."
(cd "$PROJECT_DIR/src/manage" && npm run build 2>&1 | grep -v "JSONStream\|jsonstream\|The file is") || true
echo "Installing Docker dependencies..."
docker compose run --no-deps --rm manage yarn install --ignore-engines 2>&1 | tail -1

# Build work list
WORK_FILE=$(mktemp)
python3 -c "
import csv, json
with open('$CSV_FILE') as f:
    for row in csv.DictReader(f):
        print(json.dumps(row))
" > "$WORK_FILE"

# Collect rows to process, split into small (parallel) and big (sequential)
SMALL_ROWS=()
BIG_ROWS=()
NUM_ROWS=$(wc -l < "$WORK_FILE")
for i in $(seq 1 "$NUM_ROWS"); do
  ROW=$(sed -n "${i}p" "$WORK_FILE")

  # Parse just enough to filter
  eval $(python3 -c "
import json
row = json.loads('''$ROW''')
for k in ['state_abbr', 'status', 'vest_2020', 'precinct_field_2020']:
    v = row.get(k, '')
    print(f\"{k}='{v}'\")
")

  if [[ -n "$FILTER_STATE" && "$state_abbr" != "$FILTER_STATE" ]]; then continue; fi
  if [[ "$status" != "$TARGET_STATUS" ]]; then
    echo "SKIP $state_abbr: status=$status (need $TARGET_STATUS)"
    continue
  fi
  if [[ -z "$vest_2020" || -z "$precinct_field_2020" || "$precinct_field_2020" == "UNKNOWN" ]]; then
    echo "SKIP $state_abbr: missing 2020 VEST or precinct field"
    continue
  fi

  if is_big_state "$state_abbr"; then
    GROUP="big"
  else
    GROUP="small"
  fi

  if $DRY_RUN; then
    echo "[DRY RUN] Would process $state_abbr ($GROUP)"
    continue
  fi

  if [[ "$GROUP" == "big" ]]; then
    BIG_ROWS+=("$ROW")
  else
    SMALL_ROWS+=("$ROW")
  fi
done

rm -f "$WORK_FILE"

if $DRY_RUN; then
  echo "Done (dry run)"
  exit 0
fi

echo ""
echo "Phase 1: ${#SMALL_ROWS[@]} small states with max $MAX_PARALLEL parallel jobs"
echo "Phase 2: ${#BIG_ROWS[@]} big states one-at-a-time (${BIG_STATES[*]})"
echo ""

# Process with job pool
RUNNING_PIDS=()
RUNNING_STATES=()
FAILED_STATES=()

cleanup_finished_jobs() {
  NEW_PIDS=()
  NEW_STATES=()
  for idx in "${!RUNNING_PIDS[@]}"; do
    if kill -0 "${RUNNING_PIDS[$idx]}" 2>/dev/null; then
      NEW_PIDS+=("${RUNNING_PIDS[$idx]}")
      NEW_STATES+=("${RUNNING_STATES[$idx]}")
    else
      wait "${RUNNING_PIDS[$idx]}" 2>/dev/null
      EXIT_CODE=$?
      if [[ $EXIT_CODE -ne 0 ]]; then
        echo "FAILED: ${RUNNING_STATES[$idx]} (exit $EXIT_CODE)"
        FAILED_STATES+=("${RUNNING_STATES[$idx]}")
      fi
    fi
  done
  RUNNING_PIDS=("${NEW_PIDS[@]}")
  RUNNING_STATES=("${NEW_STATES[@]}")
}

# Phase 1: small states in parallel
if [[ ${#SMALL_ROWS[@]} -gt 0 ]]; then
  echo "=== Phase 1: small states (parallel x$MAX_PARALLEL) ==="
fi
for ROW in "${SMALL_ROWS[@]}"; do
  # Always clean up finished jobs before checking capacity
  cleanup_finished_jobs

  # Wait if we're at max capacity
  while [[ ${#RUNNING_PIDS[@]} -ge $MAX_PARALLEL ]]; do
    sleep 2
    cleanup_finished_jobs
  done

  # Get state abbr for logging
  STATE=$(echo "$ROW" | python3 -c "import json,sys; print(json.loads(sys.stdin.readline())['state_abbr'])")

  # Launch state processing in background
  echo "Starting $STATE ($(( ${#RUNNING_PIDS[@]} + 1 ))/$MAX_PARALLEL slots used)"
  "$SCRIPT_DIR/process-state.sh" "$ROW" > "$DEV_DATA/${STATE}.log" 2>&1 &
  RUNNING_PIDS+=($!)
  RUNNING_STATES+=("$STATE")
done

# Wait for all phase 1 jobs to drain
for idx in "${!RUNNING_PIDS[@]}"; do
  wait "${RUNNING_PIDS[$idx]}" 2>/dev/null
  EXIT_CODE=$?
  if [[ $EXIT_CODE -ne 0 ]]; then
    echo "FAILED: ${RUNNING_STATES[$idx]} (exit $EXIT_CODE)"
    FAILED_STATES+=("${RUNNING_STATES[$idx]}")
  fi
done
RUNNING_PIDS=()
RUNNING_STATES=()

# Phase 2: big states one-at-a-time
if [[ ${#BIG_ROWS[@]} -gt 0 ]]; then
  echo ""
  echo "=== Phase 2: big states (sequential) ==="
fi
for ROW in "${BIG_ROWS[@]}"; do
  STATE=$(echo "$ROW" | python3 -c "import json,sys; print(json.loads(sys.stdin.readline())['state_abbr'])")
  echo "Starting $STATE (sequential)"
  "$SCRIPT_DIR/process-state.sh" "$ROW" > "$DEV_DATA/${STATE}.log" 2>&1
  EXIT_CODE=$?
  if [[ $EXIT_CODE -ne 0 ]]; then
    echo "FAILED: $STATE (exit $EXIT_CODE)"
    FAILED_STATES+=("$STATE")
  fi
done

echo ""
echo "=========================================="
python3 -c "
import csv
r = list(csv.DictReader(open('$CSV_FILE')))
pub = [x['state_abbr'] for x in r if x['status'] == 'published']
pend = [x['state_abbr'] for x in r if x['status'] == 'pending']
print(f'Published ({len(pub)}): {\" \".join(sorted(pub))}')
if pend: print(f'Pending ({len(pend)}): {\" \".join(sorted(pend))}')
"
if [[ ${#FAILED_STATES[@]} -gt 0 ]]; then
  echo "Failed: ${FAILED_STATES[*]}"
fi
echo "=========================================="
echo "Per-state logs in: $DEV_DATA/*.log"
echo "All done!"
