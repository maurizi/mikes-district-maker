#!/bin/bash
#
# Convert Census Bureau Block Equivalency Files (BEFs) into BLOCKID,DISTRICT
# CSVs ready for DistrictBuilder import.
#
# Input: 6 zip files in ~/Downloads:
#   cd118.zip, cd119.zip, sldl_2022.zip, sldl24.zip, sldu_2022.zip, sldu24.zip
#
# Output: output/<STATE_ABBR>/<chamber>.csv
#   Chambers: us_house, state_house, state_senate
#   For states with mid-decade redistricting, also: us_house_118, state_house_2022, state_senate_2022

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DOWNLOADS="${1:-$HOME/Downloads}"
OUTPUT_DIR="${2:-$SCRIPT_DIR/output}"
WORK_DIR=$(mktemp -d)

trap 'rm -rf "$WORK_DIR"' EXIT

# FIPS code -> state abbreviation
declare -A FIPS=(
  [01]=AL [02]=AK [04]=AZ [05]=AR [06]=CA [08]=CO [09]=CT [10]=DE [11]=DC
  [12]=FL [13]=GA [15]=HI [16]=ID [17]=IL [18]=IN [19]=IA [20]=KS [21]=KY
  [22]=LA [23]=ME [24]=MD [25]=MA [26]=MI [27]=MN [28]=MS [29]=MO [30]=MT
  [31]=NE [32]=NV [33]=NH [34]=NJ [35]=NM [36]=NY [37]=NC [38]=ND [39]=OH
  [40]=OK [41]=OR [42]=PA [44]=RI [45]=SC [46]=SD [47]=TN [48]=TX [49]=UT
  [50]=VT [51]=VA [53]=WA [54]=WV [55]=WI [56]=WY
)

# Convert a BEF .txt file to BLOCKID,DISTRICT csv
# Strips header, Windows line endings, leading zeros from district, skips ZZZ
convert_bef() {
  local input="$1"
  local output="$2"
  echo "BLOCKID,DISTRICT" > "$output"
  # Skip header line, strip \r, parse CSV, convert district to integer
  tail -n +2 "$input" | tr -d '\r' | awk -F',' '{
    # Trim whitespace from fields
    gsub(/^ +| +$/, "", $1)
    gsub(/^ +| +$/, "", $2)
    # Skip ZZZ (unassigned) or empty districts
    if ($2 == "ZZZ" || $2 == "") next
    # Convert district to integer (strips leading zeros)
    district = int($2)
    print $1 "," district
  }' >> "$output"
}

echo "=== Extracting zip files ==="
for zip in cd118 cd119 sldl_2022 sldl24 sldu_2022 sldu24; do
  zipfile="$DOWNLOADS/${zip}.zip"
  if [[ ! -f "$zipfile" ]]; then
    echo "WARNING: $zipfile not found, skipping"
    continue
  fi
  mkdir -p "$WORK_DIR/$zip"
  unzip -q -o "$zipfile" -d "$WORK_DIR/$zip"
  echo "  Extracted $zip ($(ls "$WORK_DIR/$zip"/*.txt 2>/dev/null | wc -l) files)"
done

echo ""
echo "=== Converting BEFs ==="

# Track which states have updated (mid-decade) maps
declare -A CD119_STATES=()
declare -A SLDL24_STATES=()
declare -A SLDU24_STATES=()

# Index updated state files
for f in "$WORK_DIR"/cd119/*.txt; do
  [[ -f "$f" ]] || continue
  fname=$(basename "$f")
  fips="${fname%%_*}"
  [[ "$fips" == "National"* ]] && continue
  CD119_STATES[$fips]=1
done

for f in "$WORK_DIR"/sldl24/*.txt; do
  [[ -f "$f" ]] || continue
  fname=$(basename "$f")
  fips="${fname%%_*}"
  [[ "$fips" == "National"* ]] && continue
  SLDL24_STATES[$fips]=1
done

for f in "$WORK_DIR"/sldu24/*.txt; do
  [[ -f "$f" ]] || continue
  fname=$(basename "$f")
  fips="${fname%%_*}"
  [[ "$fips" == "National"* ]] && continue
  SLDU24_STATES[$fips]=1
done

# Process each state
for fips in $(echo "${!FIPS[@]}" | tr ' ' '\n' | sort); do
  abbr="${FIPS[$fips]}"
  state_dir="$OUTPUT_DIR/$abbr"
  mkdir -p "$state_dir"

  echo "  $abbr ($fips):"

  # --- US House (Congressional Districts) ---
  cd118_file="$WORK_DIR/cd118/${fips}_${abbr}_CD118.txt"
  cd119_file="$WORK_DIR/cd119/${fips}_${abbr}_CD119.txt"

  if [[ -n "${CD119_STATES[$fips]:-}" ]] && [[ -f "$cd119_file" ]]; then
    # State has mid-decade redraw: current = cd119, original = cd118
    convert_bef "$cd119_file" "$state_dir/us_house.csv"
    if [[ -f "$cd118_file" ]]; then
      convert_bef "$cd118_file" "$state_dir/us_house_118.csv"
    fi
    echo "    US House: cd119 (current) + cd118 (original)"
  elif [[ -f "$cd118_file" ]]; then
    convert_bef "$cd118_file" "$state_dir/us_house.csv"
    echo "    US House: cd118"
  else
    echo "    US House: MISSING"
  fi

  # --- State House (SLDL) ---
  sldl22_file="$WORK_DIR/sldl_2022/${fips}_${abbr}_SLDL22.txt"
  sldl24_file="$WORK_DIR/sldl24/${fips}_${abbr}_SLDL24.txt"

  if [[ -n "${SLDL24_STATES[$fips]:-}" ]] && [[ -f "$sldl24_file" ]]; then
    convert_bef "$sldl24_file" "$state_dir/state_house.csv"
    if [[ -f "$sldl22_file" ]]; then
      convert_bef "$sldl22_file" "$state_dir/state_house_2022.csv"
    fi
    echo "    State House: sldl24 (current) + sldl22 (original)"
  elif [[ -f "$sldl22_file" ]]; then
    convert_bef "$sldl22_file" "$state_dir/state_house.csv"
    echo "    State House: sldl22"
  else
    echo "    State House: N/A (DC or NE)"
  fi

  # --- State Senate (SLDU) ---
  sldu22_file="$WORK_DIR/sldu_2022/${fips}_${abbr}_SLDU22.txt"
  sldu24_file="$WORK_DIR/sldu24/${fips}_${abbr}_SLDU24.txt"

  if [[ -n "${SLDU24_STATES[$fips]:-}" ]] && [[ -f "$sldu24_file" ]]; then
    convert_bef "$sldu24_file" "$state_dir/state_senate.csv"
    if [[ -f "$sldu22_file" ]]; then
      convert_bef "$sldu22_file" "$state_dir/state_senate_2022.csv"
    fi
    echo "    State Senate: sldu24 (current) + sldu22 (original)"
  elif [[ -f "$sldu22_file" ]]; then
    convert_bef "$sldu22_file" "$state_dir/state_senate.csv"
    echo "    State Senate: sldu22"
  else
    echo "    State Senate: MISSING"
  fi
done

echo ""
echo "=== Summary ==="
total_files=$(find "$OUTPUT_DIR" -name '*.csv' | wc -l)
total_states=$(ls -d "$OUTPUT_DIR"/*/ 2>/dev/null | wc -l)
echo "Generated $total_files CSV files across $total_states states"
echo "Output directory: $OUTPUT_DIR"
echo ""
echo "States with mid-decade congressional redistricting (both versions saved):"
for fips in $(echo "${!CD119_STATES[@]}" | tr ' ' '\n' | sort); do
  echo "  ${FIPS[$fips]}: us_house.csv (cd119/current) + us_house_118.csv (cd118/original)"
done
echo ""
echo "States with updated state legislative maps (both versions saved):"
for fips in $(echo "${!SLDL24_STATES[@]}" | tr ' ' '\n' | sort); do
  echo "  ${FIPS[$fips]}: state_house (sldl24) + state_house_2022 (sldl22)"
done
for fips in $(echo "${!SLDU24_STATES[@]}" | tr ' ' '\n' | sort); do
  echo "  ${FIPS[$fips]}: state_senate (sldu24) + state_senate_2022 (sldu22)"
done
