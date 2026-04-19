#!/bin/bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# © 2026 Michael Maurizi Jr.

set -e

# Process a single state. Called by process-all.sh.
# Usage: process-state.sh <json-row>
# Reads all config from the JSON row passed as $1.
#
# Set UPDATE_ONLY=true to skip the geometry pipeline (prepare-dev-data +
# process-geojson) and just refresh votes via update-voting-data on the
# existing dev-data/output/<state> directory. Useful when the only change
# is the disaggregation methodology or new VEST data.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
CSV_FILE="$SCRIPT_DIR/states.csv"
DATA_DIR="/run/user/1000/gvfs/smb-share:server=as6704t-fe65.local,share=mike/Data"
DEV_DATA="$PROJECT_DIR/dev-data"
UPDATE_ONLY=${UPDATE_ONLY:-false}

# Parse JSON row into shell variables
eval $(echo "$1" | python3 -c "
import json, sys
row = json.loads(sys.stdin.readline())
for k, v in row.items():
    safe = v.replace(\"'\", \"'\\\\''\")
    print(f\"{k}='{safe}'\")
")

echo ""
echo "=========================================="
echo "Processing $state_abbr ($state_name)"
echo "  2024: ${vest_2024:-none} (${precinct_field_2024:-n/a})"
echo "  2022: ${vest_2022:-none} (${precinct_field_2022:-n/a})"
echo "  2020: $vest_2020 ($precinct_field_2020)"
echo "  2018: ${vest_2018:-none} (${precinct_field_2018:-n/a})"
echo "  2016: ${vest_2016:-none} (${precinct_field_2016:-n/a})"
echo "=========================================="

GEOJSON_REL="dev-data/staging/${state_abbr}.geojson"
GEOJSON_HOST="$DEV_DATA/staging/${state_abbr}.geojson"

# UPDATE_ONLY mode: skip the whole prepare/process pipeline, just refresh votes
# on the existing output dir and push to S3. Requires dev-data/output/<state>/
# to already exist.
if [[ "$UPDATE_ONLY" == "true" ]]; then
  if [[ ! -d "$DEV_DATA/output/${state_abbr}" ]]; then
    echo "  [$state_abbr] UPDATE_ONLY: no output dir at dev-data/output/${state_abbr}, skipping"
    exit 0
  fi

  echo "  [$state_abbr] UPDATE_ONLY: copying election zips..."
  for v in "$vest_2020" "$vest_2018" "$vest_2016" "$vest_2022" "$vest_2024"; do
    [[ -n "$v" ]] && cp "$DATA_DIR/$v" "$DEV_DATA/staging/"
  done

  # Build matching --vest / --precinctField arg pairs in the same year order.
  VEST_ARGS=()
  add_vest() {
    local zip=$1 field=$2
    if [[ -n "$zip" && -n "$field" && "$field" != "UNKNOWN" ]]; then
      VEST_ARGS+=(-v "dev-data/staging/$zip" -p "$field")
    fi
  }
  add_vest "$vest_2020" "$precinct_field_2020"
  add_vest "$vest_2018" "$precinct_field_2018"
  add_vest "$vest_2016" "$precinct_field_2016"
  add_vest "$vest_2022" "$precinct_field_2022"
  add_vest "$vest_2024" "$precinct_field_2024"

  if [[ ${#VEST_ARGS[@]} -eq 0 ]]; then
    echo "  [$state_abbr] UPDATE_ONLY: no usable VEST zips, skipping"
    exit 0
  fi

  echo "  [$state_abbr] Running update-voting-data..."
  cd "$PROJECT_DIR"
  ./scripts/manage update-voting-data "dev-data/output/${state_abbr}" "${VEST_ARGS[@]}"

  echo "  [$state_abbr] Deleting zips..."
  for v in "$vest_2020" "$vest_2018" "$vest_2016" "$vest_2022" "$vest_2024"; do
    [[ -n "$v" ]] && rm -f "$DEV_DATA/staging/$v"
  done

  # Push refreshed buf/tile/metadata files to S3 in-place.
  S3_BUCKET="districtbuilder-dev-238046523378"
  S3_PREFIX="s3://${S3_BUCKET}/regions/US/${state_abbr}/"
  LATEST_VERSION=$(AWS_PROFILE=district-builder aws s3 ls "$S3_PREFIX" | tail -1 | awk '{print $2}')
  if [[ -z "$LATEST_VERSION" ]]; then
    echo "  [$state_abbr] UPDATE_ONLY: no S3 version found at $S3_PREFIX, skipping upload"
  else
    echo "  [$state_abbr] Updating S3 in-place at ${S3_PREFIX}${LATEST_VERSION}..."
    ./scripts/manage update-region "dev-data/output/${state_abbr}" "${S3_PREFIX}${LATEST_VERSION}"
  fi

  echo "  [$state_abbr] Done!"
  exit 0
fi

# Step 1: Prepare data (skip if geojson already exists)
if [[ -f "$GEOJSON_HOST" ]]; then
  echo "  [$state_abbr] GeoJSON already exists, skipping prepare-dev-data"
else
  echo "  [$state_abbr] Copying election zips..."
  cp "$DATA_DIR/$vest_2020" "$DEV_DATA/staging/"
  [[ -n "$vest_2018" ]] && cp "$DATA_DIR/$vest_2018" "$DEV_DATA/staging/"
  [[ -n "$vest_2016" ]] && cp "$DATA_DIR/$vest_2016" "$DEV_DATA/staging/"
  [[ -n "$vest_2022" ]] && cp "$DATA_DIR/$vest_2022" "$DEV_DATA/staging/"
  [[ -n "$vest_2024" ]] && cp "$DATA_DIR/$vest_2024" "$DEV_DATA/staging/"

  ADDITIONAL=""
  append_year() {
    local zip=$1 field=$2
    if [[ -n "$zip" && -n "$field" && "$field" != "UNKNOWN" ]]; then
      if [[ -n "$ADDITIONAL" ]]; then ADDITIONAL="${ADDITIONAL},"; fi
      ADDITIONAL="${ADDITIONAL}${field}:dev-data/staging/${zip}"
    fi
  }
  append_year "$vest_2016" "$precinct_field_2016"
  append_year "$vest_2018" "$precinct_field_2018"
  append_year "$vest_2022" "$precinct_field_2022"
  append_year "$vest_2024" "$precinct_field_2024"

  echo "  [$state_abbr] Running prepare-dev-data..."
  cd "$PROJECT_DIR"
  SIMPLIFY_ARG=""
  if [[ -n "$simplify_precincts" && "$simplify_precincts" != "0" ]]; then
    SIMPLIFY_ARG="--simplifyPrecincts $simplify_precincts"
  fi

  ADJ_DIR_ARG=""
  if [[ -d "dev-data/adjusted-pl" && -f "dev-data/adjusted-pl/${state_abbr}.csv" ]]; then
    ADJ_DIR_ARG="--adjDir dev-data/adjusted-pl"
  fi

  ./scripts/manage prepare-dev-data "$state_fips" "$state_abbr" \
    -v "dev-data/staging/$vest_2020" \
    -p "$precinct_field_2020" \
    -c "dev-data/census-cache/${state_abbr}.geojson" \
    --befDir dev-data/befs \
    ${ADDITIONAL:+--additionalVest "$ADDITIONAL"} \
    $SIMPLIFY_ARG \
    $ADJ_DIR_ARG \
    -o "$GEOJSON_REL"

  echo "  [$state_abbr] Deleting zips..."
  rm -f "$DEV_DATA/staging/$vest_2020"
  [[ -n "$vest_2018" ]] && rm -f "$DEV_DATA/staging/$vest_2018"
  [[ -n "$vest_2016" ]] && rm -f "$DEV_DATA/staging/$vest_2016"
  [[ -n "$vest_2022" ]] && rm -f "$DEV_DATA/staging/$vest_2022"
  [[ -n "$vest_2024" ]] && rm -f "$DEV_DATA/staging/$vest_2024"
fi

# Step 2: Run process-geojson
echo "  [$state_abbr] Running process-geojson..."
mkdir -p "$DEV_DATA/output/${state_abbr}"

BIG_ARG=""
if [[ "$big_flag" == "true" ]]; then
  BIG_ARG="-b"
fi

S3_BUCKET="districtbuilder-dev-238046523378"
S3_PREFIX="s3://${S3_BUCKET}/regions/US/${state_abbr}/"
LATEST_VERSION=$(AWS_PROFILE=district-builder aws s3 ls "$S3_PREFIX" | tail -1 | awk '{print $2}')
INPUT_S3_DIR_FLAG=""
if [[ -n "$LATEST_VERSION" ]]; then
  INPUT_S3_DIR_FLAG="--inputS3Dir ${S3_PREFIX}${LATEST_VERSION}"
else
  echo "  [$state_abbr] WARNING: No existing S3 version found, proceeding without --inputS3Dir"
fi

VOTING_COLS=$(cd "$PROJECT_DIR" && python3 -c "
import json, re
with open('$GEOJSON_REL') as f:
  data = json.load(f)
if data['features']:
  props = data['features'][0]['properties']
  # Matches bare (e.g. democrat20) and office-prefixed (e.g. USS_democrat20)
  # voting columns for any 2-digit year.
  pat = re.compile(r'(?:^|_)(?:democrat|republican|other)\d{2}\$')
  vote_cols = [k for k in props if pat.search(k)]
  print(','.join(sorted(vote_cols)))
" 2>/dev/null || echo "")
VOTING_FLAGS=""
if [[ -n "$VOTING_COLS" ]]; then
  VOTING_FLAGS="-v $VOTING_COLS"
fi

# Detect adjusted population columns in the GeoJSON
ADJ_DEMO_FLAGS=""
ADJ_COLS=$(cd "$PROJECT_DIR" && python3 -c "
import json
with open('$GEOJSON_REL') as f:
  data = json.load(f)
if data['features']:
  props = data['features'][0]['properties']
  adj = [k for k in ['adj_population','adj_white','adj_black','adj_asian','adj_hispanic','adj_other'] if k in props]
  if adj:
    print(','.join(adj))
" 2>/dev/null || echo "")
if [[ -n "$ADJ_COLS" ]]; then
  ADJ_DEMO_FLAGS="-d $ADJ_COLS"
  echo "  [$state_abbr] Adjusted population columns: $ADJ_COLS"
fi

cd "$PROJECT_DIR"
./scripts/manage process-geojson "$GEOJSON_REL" \
  -l block,precinct,county \
  -n "$min_zoom" \
  -x "$max_zoom" \
  -d population,white,black,asian,hispanic,other \
  $ADJ_DEMO_FLAGS \
  -d "VAP,VAP White,VAP Black,VAP Asian,VAP Hispanic,VAP Other" \
  -d "CVAP,CVAP White,CVAP Black,CVAP Asian,CVAP Hispanic,CVAP Other" \
  $VOTING_FLAGS \
  -s "$simplification" \
  -q "$quantization" \
  -t "$max_tile_bytes" \
  $BIG_ARG \
  $INPUT_S3_DIR_FLAG \
  -o "dev-data/output/${state_abbr}"

# Step 3: Publish or update region depending on whether it already exists locally
REGION_EXISTS=$(docker compose exec -T database psql -U districtbuilder -tAc \
  "SELECT 1 FROM region_config WHERE region_code = '${state_abbr}' LIMIT 1;" 2>/dev/null | tr -d '[:space:]')

if [[ "$REGION_EXISTS" == "1" ]]; then
  if [[ -z "$LATEST_VERSION" ]]; then
    echo "  [$state_abbr] ERROR: Region exists in DB but no S3 version found. Skipping update."
    exit 1
  fi
  echo "  [$state_abbr] Updating region in-place at ${S3_PREFIX}${LATEST_VERSION}..."
  # Update the existing S3 path in-place so both prod and local DBs (which point
  # to this path) immediately see the new data. No DB update needed.
  ./scripts/manage update-region "dev-data/output/${state_abbr}" "${S3_PREFIX}${LATEST_VERSION}"
else
  echo "  [$state_abbr] Region not in local DB, running publish-region..."
  ./scripts/manage publish-region "dev-data/output/${state_abbr}" US "$state_abbr" "$state_name" \
    -b "$S3_BUCKET"
fi

# Step 4: Update CSV status (with file lock for concurrent access)
echo "  [$state_abbr] Updating CSV status..."
LOCK_FILE="$DEV_DATA/.csv.lock"
while ! mkdir "$LOCK_FILE" 2>/dev/null; do sleep 0.1; done
python3 -c "
import csv
rows = []
with open('$CSV_FILE') as f:
    reader = csv.DictReader(f)
    fieldnames = reader.fieldnames
    for row in reader:
        if row['state_abbr'] == '$state_abbr' and row['status'] == 'pending':
            row['status'] = 'published'
        rows.append(row)
with open('$CSV_FILE', 'w', newline='') as f:
    writer = csv.DictWriter(f, fieldnames=fieldnames)
    writer.writeheader()
    writer.writerows(rows)
"
rmdir "$LOCK_FILE" 2>/dev/null

# Step 5: Cleanup
# echo "  [$state_abbr] Cleaning up..."
# if [[ -n "$state_abbr" ]]; then
#   rm -rf "$DEV_DATA/output/${state_abbr}"
#   rm -f "$GEOJSON_HOST"
# else
#   echo "  WARNING: state_abbr is empty, skipping cleanup to avoid deleting everything"
# fi

echo "  [$state_abbr] Done!"
