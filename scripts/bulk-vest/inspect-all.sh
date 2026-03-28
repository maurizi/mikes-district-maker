#!/bin/bash
set -e

# Run visual inspection for all published states
# Usage: ./scripts/bulk-vest/inspect-all.sh [--state XX]

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CSV_FILE="$SCRIPT_DIR/states.csv"

FILTER_STATE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --state) FILTER_STATE="$2"; shift 2 ;;
    *) echo "Unknown arg: $1"; exit 1 ;;
  esac
done

# Get published states from CSV
python3 -c "
import csv
with open('$CSV_FILE') as f:
    reader = csv.DictReader(f)
    seen = set()
    for row in reader:
        state = row['state_abbr']
        year = row['year']
        status = row['status']
        if status == 'published' and state not in seen:
            if '$FILTER_STATE' and state != '$FILTER_STATE':
                continue
            seen.add(state)
            print(f'{state}\t{year}')
" | while IFS=$'\t' read -r state year; do
  echo "=== Inspecting $state ==="
  npx ts-node "$SCRIPT_DIR/visual-inspect.ts" --state "$state" --year "$year" || {
    echo "FAILED: $state"
    continue
  }
done

echo ""
echo "All inspections complete. Review screenshots in: $SCRIPT_DIR/screenshots/"
