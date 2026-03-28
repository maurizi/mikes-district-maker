#!/bin/bash
# No set -e — background job management needs flexible error handling
# Individual states have set -e in process-state.sh

# Process all pending states from states.csv (one tileset per state, multi-year voting)
# Runs up to MAX_PARALLEL states concurrently.
# Usage: ./scripts/bulk-vest/process-all.sh [--state XX] [--dry-run] [--parallel N]

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
CSV_FILE="$SCRIPT_DIR/states.csv"
DEV_DATA="$PROJECT_DIR/dev-data"

# Parse args
FILTER_STATE=""
DRY_RUN=false
MAX_PARALLEL=2

while [[ $# -gt 0 ]]; do
  case "$1" in
    --state) FILTER_STATE="$2"; shift 2 ;;
    --dry-run) DRY_RUN=true; shift ;;
    --parallel) MAX_PARALLEL="$2"; shift 2 ;;
    *) echo "Unknown arg: $1"; exit 1 ;;
  esac
done

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

# Collect rows to process
ROWS_TO_PROCESS=()
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
  if [[ "$status" != "pending" ]]; then
    echo "SKIP $state_abbr: status=$status"
    continue
  fi
  if [[ -z "$vest_2020" || -z "$precinct_field_2020" || "$precinct_field_2020" == "UNKNOWN" ]]; then
    echo "SKIP $state_abbr: missing 2020 VEST or precinct field"
    continue
  fi

  if $DRY_RUN; then
    echo "[DRY RUN] Would process $state_abbr"
    continue
  fi

  ROWS_TO_PROCESS+=("$ROW")
done

rm -f "$WORK_FILE"

if $DRY_RUN; then
  echo "Done (dry run)"
  exit 0
fi

echo ""
echo "Processing ${#ROWS_TO_PROCESS[@]} states with max $MAX_PARALLEL parallel jobs"
echo ""

# Process with job pool
RUNNING_PIDS=()
RUNNING_STATES=()
FAILED_STATES=()

for ROW in "${ROWS_TO_PROCESS[@]}"; do
  # Wait if we're at max capacity
  while [[ ${#RUNNING_PIDS[@]} -ge $MAX_PARALLEL ]]; do
    # Wait for any one job to finish
    wait -n 2>/dev/null || true
    # Clean up finished jobs
    NEW_PIDS=()
    NEW_STATES=()
    for idx in "${!RUNNING_PIDS[@]}"; do
      if kill -0 "${RUNNING_PIDS[$idx]}" 2>/dev/null; then
        NEW_PIDS+=("${RUNNING_PIDS[$idx]}")
        NEW_STATES+=("${RUNNING_STATES[$idx]}")
      else
        # Check exit status
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
  done

  # Get state abbr for logging
  STATE=$(echo "$ROW" | python3 -c "import json,sys; print(json.loads(sys.stdin.readline())['state_abbr'])")

  # Launch state processing in background
  echo "Starting $STATE ($(( ${#RUNNING_PIDS[@]} + 1 ))/$MAX_PARALLEL slots used)"
  "$SCRIPT_DIR/process-state.sh" "$ROW" > "$DEV_DATA/${STATE}.log" 2>&1 &
  RUNNING_PIDS+=($!)
  RUNNING_STATES+=("$STATE")
done

# Wait for all remaining jobs
for idx in "${!RUNNING_PIDS[@]}"; do
  wait "${RUNNING_PIDS[$idx]}" 2>/dev/null
  EXIT_CODE=$?
  if [[ $EXIT_CODE -ne 0 ]]; then
    echo "FAILED: ${RUNNING_STATES[$idx]} (exit $EXIT_CODE)"
    FAILED_STATES+=("${RUNNING_STATES[$idx]}")
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
