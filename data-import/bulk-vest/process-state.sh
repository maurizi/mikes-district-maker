#!/bin/bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# © 2026 Michael Maurizi Jr.

set -e

# Process a single state. Called by process-all.sh.
# Usage: process-state.sh <json-row>
# Reads all config from the JSON row passed as $1.
#
# Set UPDATE_ONLY=true to skip the geometry pipeline (prepare-region-data +
# process-geojson) and just refresh votes via update-voting-data on the
# existing dev-data/output/<state> directory. Useful when the only change
# is the disaggregation methodology or new VEST data.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
CSV_FILE="$SCRIPT_DIR/states.csv"
DATA_DIR="/run/user/1000/gvfs/smb-share:server=as6704t-fe65.local,share=mike/Data"
DEV_DATA="$PROJECT_DIR/dev-data"
UPDATE_ONLY=${UPDATE_ONLY:-false}
NO_PUBLISH=${NO_PUBLISH:-false}

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
  echo "  [$state_abbr] GeoJSON already exists, skipping prepare-region-data"
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

  echo "  [$state_abbr] Running prepare-region-data..."
  cd "$PROJECT_DIR"

  # simplify_precincts was consumed by prepare-dev-data's precinct geometry
  # simplification pass. prepare-region-data doesn't have a separate precinct
  # layer (precincts are dissolved from blocks in process-geojson), so that
  # knob has no analog here; arc simplification still happens via process-
  # geojson's -s flag below.

  ADJ_DIR_ARG=""
  if [[ -d "dev-data/adjusted-pl" && -f "dev-data/adjusted-pl/${state_abbr}.csv" ]]; then
    ADJ_DIR_ARG="--adj-dir dev-data/adjusted-pl"
  fi

  ./scripts/manage-py prepare-region-data "$state_fips" "$state_abbr" \
    -v "dev-data/staging/$vest_2020" \
    -p "$precinct_field_2020" \
    -c "dev-data/census-cache/${state_abbr}.geojson" \
    --bef-dir dev-data/befs \
    ${ADDITIONAL:+--additional-vest "$ADDITIONAL"} \
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
# Sort source is the prefix prod is currently serving (from states.csv,
# populated from region_config in DSQL) — falling back to the latest S3
# version if the column is blank (new state not yet published). Without
# this the `aws s3 ls | tail -1` lookup picks up post-prod test prefixes
# (e.g. TX has 2026-05-06 test uploads sitting on top of the
# 2026-04-26 prod prefix), causing block ordering to diverge from
# prod's geounit-hierarchy.json.
INPUT_S3_DIR=""
if [[ -n "${prod_key_prefix:-}" ]]; then
  INPUT_S3_DIR="s3://${S3_BUCKET}/${prod_key_prefix}"
elif [[ -n "$LATEST_VERSION" ]]; then
  INPUT_S3_DIR="${S3_PREFIX}${LATEST_VERSION}"
fi
INPUT_S3_DIR_FLAG=""
# SKIP_INPUT_S3=1 forces a fresh sort instead of reading the previous
# version's block ordering off S3 — needed when the .ctopo format on
# S3 is incompatible with the current encoder (e.g. an in-flight
# format change). Stable arc-id ordering across rebuilds is lost for
# this run; subsequent rebuilds re-establish it from the new file.
if [[ -n "$INPUT_S3_DIR" && "${SKIP_INPUT_S3:-}" != "1" ]]; then
  INPUT_S3_DIR_FLAG="--inputS3Dir ${INPUT_S3_DIR}"
  echo "  [$state_abbr] Sorting against ${INPUT_S3_DIR}"
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
# SKIP_TILES=1 skips the multi-minute tippecanoe pass — useful only
# when iterating on the .ctopo encoder. Tiles aren't regenerated, so
# the existing tiles.pmtiles in the output dir is left in place.
SKIP_TILES_FLAG=""
if [[ "${SKIP_TILES:-}" == "1" || "${SKIP_TILES:-}" == "true" ]]; then
  SKIP_TILES_FLAG="--skipTiles"
  echo "  [$state_abbr] SKIP_TILES set, will pass --skipTiles to process-geojson"
fi
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
  $SKIP_TILES_FLAG \
  -o "dev-data/output/${state_abbr}"

if [[ "$NO_PUBLISH" == "true" ]]; then
  echo "  [$state_abbr] NO_PUBLISH set, skipping publish/update and CSV status update. Done!"
  exit 0
fi

# TODO(ctopo-deploy): one-shot path used to roll the new ctopo format
# into prod by uploading *only* `region.ctopo` to the row's
# `prod_key_prefix` from states.csv (i.e. the prefix the production
# DSQL region_config row currently points at). Skips update-region so
# the legacy static-metadata.json / geounit-hierarchy.json /
# tiles.pmtiles already on prod are not overwritten — the new client
# reads region.ctopo and ignores the legacy sidecars, while any
# straggler old client tab still sees the original sidecars it
# expects. Remove this branch once prod has been migrated and we go
# back to full update-region / publish-region flows.
if [[ "${CTOPO_ONLY_TO_PROD:-}" == "1" ]]; then
  if [[ -z "${prod_key_prefix:-}" ]]; then
    echo "  [$state_abbr] CTOPO_ONLY_TO_PROD: prod_key_prefix is empty in CSV, skipping"
    exit 0
  fi
  CTOPO_LOCAL="dev-data/output/${state_abbr}/region.ctopo"
  if [[ ! -f "$CTOPO_LOCAL" ]]; then
    echo "  [$state_abbr] CTOPO_ONLY_TO_PROD: $CTOPO_LOCAL missing, skipping"
    exit 1
  fi
  CTOPO_DEST="s3://${S3_BUCKET}/${prod_key_prefix}region.ctopo"
  echo "  [$state_abbr] CTOPO_ONLY_TO_PROD: uploading region.ctopo -> ${CTOPO_DEST}"
  AWS_PROFILE=district-builder aws s3 cp "$CTOPO_LOCAL" "$CTOPO_DEST"
  echo "  [$state_abbr] Done!"
  exit 0
fi

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
