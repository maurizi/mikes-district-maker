#!/bin/bash
set -e

# Process a single state. Called by process-all.sh.
# Usage: process-state.sh <json-row>
# Reads all config from the JSON row passed as $1

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
CSV_FILE="$SCRIPT_DIR/states.csv"
DATA_DIR="/run/user/1000/gvfs/smb-share:server=as6704t-fe65.local,share=mike/Data"
DEV_DATA="$PROJECT_DIR/dev-data"

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

  ./scripts/manage prepare-dev-data "$state_fips" "$state_abbr" \
    -v "dev-data/staging/$vest_2020" \
    -p "$precinct_field_2020" \
    -c "dev-data/census-cache/${state_abbr}.geojson" \
    ${ADDITIONAL:+--additionalVest "$ADDITIONAL"} \
    $SIMPLIFY_ARG \
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

cd "$PROJECT_DIR"
./scripts/manage process-geojson "$GEOJSON_REL" \
  -l block,precinct,county \
  -n "$min_zoom" \
  -x "$max_zoom" \
  -d population,white,black,asian,hispanic,other \
  -d "VAP,VAP White,VAP Black,VAP Asian,VAP Hispanic,VAP Other" \
  -d "CVAP,CVAP White,CVAP Black,CVAP Asian,CVAP Hispanic,CVAP Other" \
  $VOTING_FLAGS \
  -s "$simplification" \
  -q "$quantization" \
  -t "$max_tile_bytes" \
  $BIG_ARG \
  $INPUT_S3_DIR_FLAG \
  -o "dev-data/output/${state_abbr}"

# Step 3: Update region
echo "  [$state_abbr] Updating region..."
S3_URI="s3://${S3_BUCKET}/regions/US/${state_abbr}/$(date -u +%Y-%m-%dT%H:%M:%S.000Z)/"
./scripts/manage update-region "dev-data/output/${state_abbr}" "$S3_URI"
docker compose exec -T database psql -U districtbuilder -c \
  "UPDATE region_config SET s3_uri = '${S3_URI}', version = '$(date -u +%Y-%m-%dT%H:%M:%S.000Z)' WHERE region_code = '${state_abbr}';" \
  > /dev/null 2>&1 || echo "  [$state_abbr] WARNING: Could not update DB record"

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
