#!/usr/bin/env python3
"""
Convert Census Bureau Block Equivalency Files (BEFs) into BLOCKID,DISTRICT
CSVs ready for DistrictBuilder import.

Split blocks (blocks that straddle precinct boundaries) are handled by the
import endpoint in the server — it automatically expands base block IDs to
their split variants.

Input: 6 zip files in ~/Downloads:
  cd118.zip, cd119.zip, sldl_2022.zip, sldl24.zip, sldu_2022.zip, sldu24.zip

Output: output/<STATE_ABBR>/<chamber>.csv
"""

import csv
import os
import sys
import tempfile
import zipfile
from pathlib import Path

SCRIPT_DIR = Path(__file__).parent
DOWNLOADS = Path(sys.argv[1]) if len(sys.argv) > 1 else Path.home() / "Downloads"
OUTPUT_DIR = Path(sys.argv[2]) if len(sys.argv) > 2 else SCRIPT_DIR / "output"

FIPS = {
    "01": "AL", "02": "AK", "04": "AZ", "05": "AR", "06": "CA", "08": "CO",
    "09": "CT", "10": "DE", "11": "DC", "12": "FL", "13": "GA", "15": "HI",
    "16": "ID", "17": "IL", "18": "IN", "19": "IA", "20": "KS", "21": "KY",
    "22": "LA", "23": "ME", "24": "MD", "25": "MA", "26": "MI", "27": "MN",
    "28": "MS", "29": "MO", "30": "MT", "31": "NE", "32": "NV", "33": "NH",
    "34": "NJ", "35": "NM", "36": "NY", "37": "NC", "38": "ND", "39": "OH",
    "40": "OK", "41": "OR", "42": "PA", "44": "RI", "45": "SC", "46": "SD",
    "47": "TN", "48": "TX", "49": "UT", "50": "VT", "51": "VA", "53": "WA",
    "54": "WV", "55": "WI", "56": "WY",
}


def parse_bef_records(input_path: str) -> list[tuple[str, str]]:
    """Parse a BEF file into (geoid, district_str) pairs, skipping unassigned."""
    records = []
    with open(input_path, "r") as inp:
        reader = csv.reader(inp)
        next(reader)  # skip header
        for row in reader:
            geoid = row[0].strip()
            district_str = row[1].strip()
            if district_str in ("ZZZ", "ZZ", ""):
                continue
            records.append((geoid, district_str))
    return records


def build_district_map(records: list[tuple[str, str]]) -> dict[str, int]:
    """Map district IDs to integers.

    Pure numeric IDs (like "01", "14") keep their numeric value.
    Alphanumeric IDs (like "01A", "ADD", "C-1") get sequential integers starting at 1.
    """
    unique_districts = sorted(set(d for _, d in records))

    all_numeric = all(d.isdigit() for d in unique_districts)
    if all_numeric:
        return {d: int(d) for d in unique_districts}

    return {d: i + 1 for i, d in enumerate(unique_districts)}


def convert_bef(input_path: str, output_path: str) -> dict:
    """Convert a BEF .txt file to BLOCKID,DISTRICT csv."""
    stats = {"rows": 0, "alpha_districts": False, "num_districts": 0}

    records = parse_bef_records(input_path)
    district_map = build_district_map(records)
    stats["alpha_districts"] = any(not d.isdigit() for d in district_map.keys())
    stats["num_districts"] = len(district_map)

    with open(output_path, "w", newline="") as out:
        writer = csv.writer(out)
        writer.writerow(["BLOCKID", "DISTRICT"])
        for geoid, district_str in records:
            writer.writerow([geoid, district_map[district_str]])
            stats["rows"] += 1

    # Write district name mapping for alphanumeric districts
    if stats["alpha_districts"]:
        map_path = output_path.replace(".csv", "_district_names.csv")
        with open(map_path, "w", newline="") as f:
            w = csv.writer(f)
            w.writerow(["DISTRICT", "ORIGINAL_NAME"])
            for name, num in sorted(district_map.items(), key=lambda x: x[1]):
                w.writerow([num, name])

    return stats


def main():
    work_dir = tempfile.mkdtemp()

    # Extract zips
    print("=== Extracting zip files ===")
    zips = ["cd118", "cd119", "sldl_2022", "sldl24", "sldu_2022", "sldu24"]
    for name in zips:
        zippath = DOWNLOADS / f"{name}.zip"
        if not zippath.exists():
            print(f"  WARNING: {zippath} not found, skipping")
            continue
        dest = os.path.join(work_dir, name)
        os.makedirs(dest, exist_ok=True)
        with zipfile.ZipFile(zippath) as zf:
            txt_count = sum(1 for n in zf.namelist() if n.endswith(".txt"))
            zf.extractall(dest)
            print(f"  Extracted {name} ({txt_count} files)")

    # Index which states have updated (2024/119) files
    def index_updates(subdir: str) -> set[str]:
        fips_set = set()
        d = os.path.join(work_dir, subdir)
        if not os.path.isdir(d):
            return fips_set
        for fname in os.listdir(d):
            if fname.startswith("National") or not fname.endswith(".txt"):
                continue
            fips_set.add(fname.split("_")[0])
        return fips_set

    cd119_states = index_updates("cd119")
    sldl24_states = index_updates("sldl24")
    sldu24_states = index_updates("sldu24")

    print()
    print("=== Converting BEFs ===")

    total_files = 0

    for fips in sorted(FIPS.keys()):
        abbr = FIPS[fips]
        state_dir = OUTPUT_DIR / abbr
        state_dir.mkdir(parents=True, exist_ok=True)

        print(f"  {abbr} ({fips}):")

        def do_convert(src: str, dst: str, label: str):
            nonlocal total_files
            if not os.path.isfile(src):
                return False
            stats = convert_bef(src, dst)
            total_files += 1
            parts = [f"{stats['rows']} rows", f"{stats['num_districts']} districts"]
            if stats["alpha_districts"]:
                parts.append("alpha->numeric mapping saved")
            print(f"    {label}: {', '.join(parts)}")
            return True

        # --- US House ---
        cd118 = os.path.join(work_dir, "cd118", f"{fips}_{abbr}_CD118.txt")
        cd119 = os.path.join(work_dir, "cd119", f"{fips}_{abbr}_CD119.txt")

        if fips in cd119_states:
            do_convert(cd119, str(state_dir / "us_house.csv"), "US House (cd119)")
            do_convert(cd118, str(state_dir / "us_house_118.csv"), "US House (cd118/original)")
        else:
            do_convert(cd118, str(state_dir / "us_house.csv"), "US House (cd118)")

        # --- State House ---
        sldl22 = os.path.join(work_dir, "sldl_2022", f"{fips}_{abbr}_SLDL22.txt")
        sldl24 = os.path.join(work_dir, "sldl24", f"{fips}_{abbr}_SLDL24.txt")

        if fips in sldl24_states:
            do_convert(sldl24, str(state_dir / "state_house.csv"), "State House (sldl24)")
            do_convert(sldl22, str(state_dir / "state_house_2022.csv"), "State House (sldl22/original)")
        elif os.path.isfile(sldl22):
            do_convert(sldl22, str(state_dir / "state_house.csv"), "State House (sldl22)")
        else:
            print(f"    State House: N/A")

        # --- State Senate ---
        sldu22 = os.path.join(work_dir, "sldu_2022", f"{fips}_{abbr}_SLDU22.txt")
        sldu24 = os.path.join(work_dir, "sldu24", f"{fips}_{abbr}_SLDU24.txt")

        if fips in sldu24_states:
            do_convert(sldu24, str(state_dir / "state_senate.csv"), "State Senate (sldu24)")
            do_convert(sldu22, str(state_dir / "state_senate_2022.csv"), "State Senate (sldu22/original)")
        elif os.path.isfile(sldu22):
            do_convert(sldu22, str(state_dir / "state_senate.csv"), "State Senate (sldu22)")
        else:
            print(f"    State Senate: N/A")

    print()
    print("=== Summary ===")
    print(f"Generated {total_files} CSV files in {OUTPUT_DIR}")
    print()
    if cd119_states:
        print("Mid-decade congressional redistricting (both versions):")
        for f in sorted(cd119_states):
            print(f"  {FIPS[f]}")
    if sldl24_states:
        print("Updated state house maps (both versions):")
        for f in sorted(sldl24_states):
            print(f"  {FIPS[f]}")
    if sldu24_states:
        print("Updated state senate maps (both versions):")
        for f in sorted(sldu24_states):
            print(f"  {FIPS[f]}")


if __name__ == "__main__":
    main()
