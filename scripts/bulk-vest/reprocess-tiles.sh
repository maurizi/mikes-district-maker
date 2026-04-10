#!/bin/bash
set -e

# Fast tile-only reprocessing: skips prepare-dev-data, only runs process-geojson + publish.
# Downloads input.geojson from S3 if not available locally.
#
# Use this when you've changed simplification, quantization, zoom, or max_tile_bytes in states.csv
# or when process-geojson code has changed but the underlying GeoJSON hasn't.
#
# Usage:
#   ./scripts/bulk-vest/reprocess-tiles.sh --state DE
#   ./scripts/bulk-vest/reprocess-tiles.sh --state DE --state CA  # multiple states
#   ./scripts/bulk-vest/reprocess-tiles.sh --all                  # all published states
#   ./scripts/bulk-vest/reprocess-tiles.sh --state DE --dry-run

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
CSV_FILE="$SCRIPT_DIR/states.csv"
DEV_DATA="$PROJECT_DIR/dev-data"
S3_BUCKET="districtbuilder-dev-238046523378"

STATES=()
DRY_RUN=false
ALL=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --state) STATES+=("$(echo "$2" | tr '[:lower:]' '[:upper:]')"); shift 2 ;;
    --all) ALL=true; shift ;;
    --dry-run) DRY_RUN=true; shift ;;
    *) echo "Unknown arg: $1"; exit 1 ;;
  esac
done

if $ALL; then
  STATES=($(python3 -c "
import csv
with open('$CSV_FILE') as f:
    for row in csv.DictReader(f):
        if row['status'] == 'published':
            print(row['state_abbr'])
"))
fi

if [[ ${#STATES[@]} -eq 0 ]]; then
  echo "Usage: reprocess-tiles.sh --state XX [--state YY] | --all [--dry-run] [--parallel N]"
  exit 1
fi

echo "Reprocessing tiles for ${#STATES[@]} state(s): ${STATES[*]}"

# Ensure dev-data dirs exist
mkdir -p "$DEV_DATA/staging" "$DEV_DATA/output"

process_state() {
  local state="$1"

  # Read config from CSV
  eval $(python3 -c "
import csv
with open('$CSV_FILE') as f:
    for row in csv.DictReader(f):
        if row['state_abbr'] == '$state':
            for k, v in row.items():
                safe = v.replace(\"'\", \"'\\\\\\''\")
                print(f\"{k}='{safe}'\")
            break
    else:
        print('echo \"State $state not found in CSV\"; exit 1')
")

  echo ""
  echo "=========================================="
  echo "Reprocessing $state_abbr ($state_name)"
  echo "  Simplification: $simplification"
  echo "  Quantization:   $quantization"
  echo "  Min zoom:       $min_zoom"
  echo "  Max zoom:       $max_zoom"
  echo "  Max tile bytes: $max_tile_bytes"
  echo "=========================================="

  # Find the GeoJSON source — check local first, then download from S3
  GEOJSON_HOST="$DEV_DATA/staging/${state_abbr}.geojson"
  GEOJSON_REL="dev-data/staging/${state_abbr}.geojson"

  if [[ ! -f "$GEOJSON_HOST" ]]; then
    # Check output dir backup
    if [[ -f "$DEV_DATA/output/${state_abbr}/input.geojson" ]]; then
      GEOJSON_HOST="$DEV_DATA/output/${state_abbr}/input.geojson"
      GEOJSON_REL="dev-data/output/${state_abbr}/input.geojson"
    else
      # Download from S3
      echo "  [$state_abbr] Downloading input.geojson from S3..."
      S3_PREFIX="s3://${S3_BUCKET}/regions/US/${state_abbr}/"
      LATEST_VERSION=$(aws s3 ls "$S3_PREFIX" | tail -1 | awk '{print $2}')
      if [[ -z "$LATEST_VERSION" ]]; then
        echo "  [$state_abbr] ERROR: No data found on S3 at $S3_PREFIX"
        return 1
      fi
      S3_GEOJSON="${S3_PREFIX}${LATEST_VERSION}input.geojson"
      aws s3 cp "$S3_GEOJSON" "$GEOJSON_HOST" || {
        echo "  [$state_abbr] ERROR: Failed to download $S3_GEOJSON"
        return 1
      }
      echo "  [$state_abbr] Downloaded to $GEOJSON_HOST"
    fi
  fi

  echo "  [$state_abbr] Using GeoJSON: $GEOJSON_REL"

  if $DRY_RUN; then
    echo "  [$state_abbr] DRY RUN — would reprocess with above settings"
    return 0
  fi

  # Detect voting columns and available demographics from the GeoJSON
  read -r VOTING_COLS HAS_VAP HAS_CVAP < <(cd "$PROJECT_DIR" && python3 -c "
import json
with open('$GEOJSON_REL') as f:
  # Read first 20KB to get first feature's properties
  chunk = f.read(20000)
idx = chunk.find('\"properties\"')
start = chunk.index('{', idx)
depth = 0
for i in range(start, len(chunk)):
  if chunk[i] == '{': depth += 1
  elif chunk[i] == '}': depth -= 1
  if depth == 0:
    props = json.loads(chunk[start:i+1])
    vote_cols = [k for k in props if any(k.endswith(p) for p in ['democrat16','republican16','other16','democrat18','republican18','other18','democrat20','republican20','other20'])]
    has_vap = 'yes' if 'VAP' in props else 'no'
    has_cvap = 'yes' if 'CVAP' in props else 'no'
    print(','.join(sorted(vote_cols)), has_vap, has_cvap)
    break
" 2>/dev/null || echo " no no")
  VOTING_FLAGS=""
  if [[ -n "$VOTING_COLS" ]]; then
    VOTING_FLAGS="-v $VOTING_COLS"
  fi
  DEMO_FLAGS="-d population,white,black,asian,hispanic,other"
  if [[ "$HAS_VAP" == "yes" ]]; then
    DEMO_FLAGS="$DEMO_FLAGS -d 'VAP,VAP White,VAP Black,VAP Asian,VAP Hispanic,VAP Other'"
  else
    echo "  [$state_abbr] WARNING: No VAP data, skipping VAP demographics"
  fi
  if [[ "$HAS_CVAP" == "yes" ]]; then
    DEMO_FLAGS="$DEMO_FLAGS -d 'CVAP,CVAP White,CVAP Black,CVAP Asian,CVAP Hispanic,CVAP Other'"
  else
    echo "  [$state_abbr] WARNING: No CVAP data, skipping CVAP demographics"
  fi

  BIG_ARG=""
  if [[ "$big_flag" == "true" ]]; then
    BIG_ARG="-b"
  fi

  # Run process-geojson
  echo "  [$state_abbr] Running process-geojson..."
  mkdir -p "$DEV_DATA/output/${state_abbr}"

  cd "$PROJECT_DIR"
  ./scripts/manage process-geojson "$GEOJSON_REL" \
    -l block,precinct,county \
    -n "$min_zoom" \
    -x "$max_zoom" \
    $DEMO_FLAGS \
    $VOTING_FLAGS \
    -s "$simplification" \
    -q "$quantization" \
    -t "$max_tile_bytes" \
    $BIG_ARG \
    -o "dev-data/output/${state_abbr}"

  # Publish/update region
  echo "  [$state_abbr] Publishing region..."
  S3_URI="s3://${S3_BUCKET}/regions/US/${state_abbr}/$(date -u +%Y-%m-%dT%H:%M:%S.000Z)/"
  if ! ./scripts/manage publish-region \
    -b "$S3_BUCKET" \
    "dev-data/output/${state_abbr}" US "$state_abbr" "$state_name" 2>&1; then
    echo "  [$state_abbr] Region exists, updating in-place..."
    ./scripts/manage update-region "dev-data/output/${state_abbr}" "$S3_URI"
    # Update the DB record to point to the new S3 path
    docker compose exec -T database psql -U districtbuilder -c \
      "UPDATE region_config SET s3_uri = '${S3_URI}', version = '$(date -u +%Y-%m-%dT%H:%M:%S.000Z)' WHERE region_code = '${state_abbr}';" \
      > /dev/null 2>&1 || echo "  [$state_abbr] WARNING: Could not update DB record"
  fi

  # Cleanup output to save disk (keep the downloaded GeoJSON for potential re-runs)
  echo "  [$state_abbr] Cleaning up output..."
  rm -rf "$DEV_DATA/output/${state_abbr}"

  echo "  [$state_abbr] Done!"
}

# Process states sequentially (docker compose run doesn't parallelize well)
FAILED=()

for state in "${STATES[@]}"; do
  set +e
  process_state "$state" 2>&1 | tee -a "$DEV_DATA/${state}.log"
  if [[ ${PIPESTATUS[0]} -ne 0 ]]; then
    FAILED+=("$state")
  fi
  set -e
done

echo ""
echo "=========================================="
echo "Reprocessing complete for ${#STATES[@]} state(s)"
if [[ ${#FAILED[@]} -gt 0 ]]; then
  echo "FAILED (${#FAILED[@]}): ${FAILED[*]}"
else
  echo "All states succeeded!"
fi
