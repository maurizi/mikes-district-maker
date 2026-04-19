#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
# © 2026 Michael Maurizi Jr.

"""
Normalize adjusted PL 94-171 data from various state-specific formats
into a uniform CSV per state.

Output format: GEOID,adj_population[,adj_white,adj_black,adj_asian,adj_hispanic,adj_other]
Racial breakdown columns only included when the source data provides them.

Input: RDH-downloaded zip files in INPUT_DIR
Output: One CSV per state in OUTPUT_DIR

Usage:
  python3 normalize-adjusted-pl.py                    # all states
  python3 normalize-adjusted-pl.py CA CO MD            # specific states
"""

import csv
import io
import os
import struct
import sys
import zipfile
from pathlib import Path

try:
    import openpyxl
except ImportError:
    print("ERROR: openpyxl required. Install with: pip install openpyxl")
    sys.exit(1)

SCRIPT_DIR = Path(__file__).parent
INPUT_DIR = Path("/media/mike/Share drive/Data/dev-data/adjusted-pl")
OUTPUT_DIR = SCRIPT_DIR / "../../dev-data/adjusted-pl"


def write_csv(output_path: Path, rows: list[dict]):
    """Write rows to CSV. Columns determined from first row's keys."""
    if not rows:
        print(f"  WARNING: No rows to write")
        return
    fieldnames = list(rows[0].keys())
    with open(output_path, "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)
    print(f"  Wrote {len(rows):,} rows → {output_path.name} (columns: {', '.join(fieldnames)})")


def compute_other(row: dict) -> dict:
    """Compute adj_other as residual if racial breakdown columns are present."""
    if "adj_white" in row and "adj_hispanic" in row:
        row["adj_other"] = max(
            0,
            row["adj_population"]
            - row.get("adj_white", 0)
            - row.get("adj_black", 0)
            - row.get("adj_asian", 0)
            - row.get("adj_hispanic", 0),
        )
    return row


# ── Per-state handlers ──


def normalize_ca(zf: zipfile.ZipFile) -> list[dict]:
    """CA: CSV with BLOCK20, Population P2, NH_Wht/Blk/Asn, Hispanic Origin."""
    with zf.open(
        "state_PL94_2020_Adjusted_P24_DOJ_Block_csv/state_PL94_2020_Adjusted_P24_DOJ_Block.csv"
    ) as f:
        reader = csv.DictReader(io.TextIOWrapper(f, encoding="utf-8"))
        rows = []
        for r in reader:
            rows.append(
                compute_other(
                    {
                        "GEOID": r["BLOCK20"],
                        "adj_population": int(r["Population P2"]),
                        "adj_white": int(r["NH_Wht"]),
                        "adj_black": int(r["NH_Blk"]),
                        "adj_asian": int(r["NH_Asn"]),
                        "adj_hispanic": int(r["Hispanic Origin"]),
                    }
                )
            )
        return rows


def normalize_co(zf: zipfile.ZipFile) -> list[dict]:
    """CO: XLSX with GEOID20, TOTALPOP_ADJ, racial breakdown."""
    wb = openpyxl.load_workbook(
        io.BytesIO(zf.read("2020_Block_Adj_Final.xlsx")), read_only=True
    )
    ws = wb[wb.sheetnames[0]]
    rows_iter = ws.iter_rows(values_only=True)
    header = next(rows_iter)
    col = {name: i for i, name in enumerate(header)}
    rows = []
    for r in rows_iter:
        rows.append(
            compute_other(
                {
                    "GEOID": str(r[col["GEOID20"]]),
                    "adj_population": int(r[col["TOTALPOP_ADJ"]] or 0),
                    "adj_white": int(r[col["NHWHITE_ADJ"]] or 0),
                    "adj_black": int(r[col["NHBLACK_ADJ"]] or 0),
                    "adj_asian": int(r[col["NHASIAN_ADJ"]] or 0),
                    "adj_hispanic": int(r[col["HISPANIC_ADJ"]] or 0),
                }
            )
        )
    wb.close()
    return rows


def normalize_ct(zf: zipfile.ZipFile) -> list[dict]:
    """CT: CSV with GEOID20, P0030001 - Adjusted. Total only, no racial breakdown."""
    with zf.open("2020_U.S._Census_Block_Adjustments.csv") as f:
        reader = csv.DictReader(io.TextIOWrapper(f, encoding="utf-8"))
        rows = []
        for r in reader:
            rows.append(
                {
                    "GEOID": r["GEOID20"],
                    "adj_population": int(r["P0030001 - Adjusted"]),
                }
            )
        return rows


def normalize_de(zf: zipfile.ZipFile) -> list[dict]:
    """DE: XLSX with Block (GEOID), Adj_Population. Total only."""
    wb = openpyxl.load_workbook(
        io.BytesIO(zf.read("Census Block Breakdown by District_Senate.xlsx")),
        read_only=True,
    )
    ws = wb[wb.sheetnames[0]]
    rows_iter = ws.iter_rows(values_only=True)
    header = next(rows_iter)
    col = {name: i for i, name in enumerate(header)}
    rows = []
    for r in rows_iter:
        geoid = str(r[col["Block"]])
        rows.append(
            {
                "GEOID": geoid,
                "adj_population": int(r[col["Adj_Population"]] or 0),
            }
        )
    wb.close()
    return rows


def normalize_il(zf: zipfile.ZipFile) -> list[dict]:
    """IL: CSV with blockid, adjtotal, adjwhite, adjblack, adjlatino, adjother.
    Values are fractional — round to int."""
    with zf.open("Illinois_block_returning_data.csv") as f:
        reader = csv.DictReader(io.TextIOWrapper(f, encoding="utf-8"))
        rows = []
        for r in reader:
            adj_pop = round(float(r["adjtotal"]))
            adj_white = round(float(r["adjwhite"]))
            adj_black = round(float(r["adjblack"]))
            adj_hispanic = round(float(r["adjlatino"]))
            adj_other_raw = round(float(r["adjother"]))
            # IL doesn't have adj_asian separately — it's in "other"
            rows.append(
                {
                    "GEOID": r["blockid"],
                    "adj_population": adj_pop,
                    "adj_white": adj_white,
                    "adj_black": adj_black,
                    "adj_asian": 0,
                    "adj_hispanic": adj_hispanic,
                    "adj_other": max(0, adj_pop - adj_white - adj_black - adj_hispanic),
                }
            )
        return rows


def normalize_md(zf: zipfile.ZipFile) -> list[dict]:
    """MD: CSV with Block, Adj_Population, Adj_NH_Wht/Blk/Asn, Adj_Hispanic_Origin."""
    with zf.open("Block.csv") as f:
        reader = csv.DictReader(io.TextIOWrapper(f, encoding="utf-8-sig"))
        rows = []
        for r in reader:
            rows.append(
                compute_other(
                    {
                        "GEOID": r["Block"],
                        "adj_population": int(r["Adj_Population"] or 0),
                        "adj_white": int(r["Adj_NH_Wht"] or 0),
                        "adj_black": int(r["Adj_NH_Blk"] or 0),
                        "adj_asian": int(r["Adj_NH_Asn"] or 0),
                        "adj_hispanic": int(r["Adj_Hispanic_Origin"] or 0),
                    }
                )
            )
        return rows


def read_dbf(data: bytes, wanted_fields: list[str]) -> list[dict]:
    """Parse a DBF file and extract specified fields."""
    num_records = struct.unpack_from("<I", data, 4)[0]
    header_size = struct.unpack_from("<H", data, 8)[0]
    record_size = struct.unpack_from("<H", data, 10)[0]
    num_fields = (header_size - 32 - 1) // 32

    fields = []
    for i in range(num_fields):
        offset = 32 + i * 32
        name = data[offset : offset + 11].split(b"\x00")[0].decode("ascii")
        ftype = chr(data[offset + 11])
        fsize = data[offset + 16]
        fields.append((name, ftype, fsize))

    field_names = [f[0] for f in fields]
    # Build offset table
    offsets = []
    pos = 0
    for _, _, fsize in fields:
        offsets.append(pos)
        pos += fsize

    # Map wanted fields to indices
    wanted_indices = {}
    for wf in wanted_fields:
        if wf in field_names:
            wanted_indices[wf] = field_names.index(wf)

    rows = []
    record_offset = header_size
    for _ in range(num_records):
        deletion_flag = data[record_offset]
        record_data = data[record_offset + 1 : record_offset + record_size]
        record_offset += record_size
        if deletion_flag == 0x2A:
            continue

        row = {}
        for wf, idx in wanted_indices.items():
            raw = record_data[offsets[idx] : offsets[idx] + fields[idx][2]]
            row[wf] = raw.decode("ascii", errors="replace").strip()
        rows.append(row)

    return rows


def normalize_mn(zf: zipfile.ZipFile) -> list[dict]:
    """MN: Shapefile (Census_Block.dbf). BLOCK=GEOID, POPULATION=adjusted total,
    NH_WHT/NH_BLK/NH_ASN=race, HISPANIC_O=Hispanic."""
    with zf.open("Census_Block.dbf") as f:
        data = f.read()

    dbf_rows = read_dbf(
        data,
        ["BLOCK", "POPULATION", "NH_WHT", "NH_BLK", "NH_ASN", "HISPANIC_O"],
    )
    rows = []
    for r in dbf_rows:
        geoid = r.get("BLOCK", "")
        if len(geoid) != 15:
            continue
        rows.append(
            compute_other(
                {
                    "GEOID": geoid,
                    "adj_population": int(float(r.get("POPULATION") or 0)),
                    "adj_white": int(float(r.get("NH_WHT") or 0)),
                    "adj_black": int(float(r.get("NH_BLK") or 0)),
                    "adj_asian": int(float(r.get("NH_ASN") or 0)),
                    "adj_hispanic": int(float(r.get("HISPANIC_O") or 0)),
                }
            )
        )
    return rows


def normalize_mt(zf: zipfile.ZipFile) -> list[dict]:
    """MT: File Geodatabase with CensusBlocks layer. Extract via ogr2ogr."""
    import shutil
    import subprocess
    import tempfile

    if not shutil.which("ogr2ogr"):
        print("  WARNING: ogr2ogr (GDAL) required for MT GDB. Install with: apt install gdal-bin")
        return []

    with tempfile.TemporaryDirectory() as tmpdir:
        # Extract GDB
        gdb_members = [n for n in zf.namelist() if "Redistricting_DataRelease.gdb/" in n]
        for m in gdb_members:
            zf.extract(m, tmpdir)
        gdb_path = os.path.join(tmpdir, "Redistricting_DataRelease.gdb")
        csv_path = os.path.join(tmpdir, "mt_blocks.csv")

        # Convert to CSV
        subprocess.run(
            [
                "ogr2ogr", "-f", "CSV", csv_path, gdb_path,
                "MT_CensusBlocks_2020PrisonerAdjusted",
            ],
            check=True,
            capture_output=True,
        )

        rows = []
        with open(csv_path) as f:
            reader = csv.DictReader(f)
            for r in reader:
                geoid = r.get("BLOCK", "")
                if len(geoid) != 15:
                    continue
                rows.append(
                    compute_other(
                        {
                            "GEOID": geoid,
                            "adj_population": int(float(r.get("ADJ_POPULA", 0) or 0)),
                            "adj_white": int(float(r.get("ADJSUP_NH_", 0) or 0)),
                            "adj_black": int(float(r.get("ADJSUP_BLA", 0) or 0)),
                            "adj_asian": int(float(r.get("ADJSUP_ASI", 0) or 0)),
                            "adj_hispanic": int(float(r.get("ADJSUP_HIS", 0) or 0)),
                        }
                    )
                )
        return rows


def normalize_nj(zf: zipfile.ZipFile) -> list[dict]:
    """NJ: 21 per-county XLSX files with multi-row headers."""
    xlsx_files = sorted(n for n in zf.namelist() if n.endswith(".xlsx"))
    rows = []
    for xlsx_name in xlsx_files:
        wb = openpyxl.load_workbook(
            io.BytesIO(zf.read(xlsx_name)), read_only=True
        )
        ws = wb[wb.sheetnames[0]]
        # Find header row (row 15, 0-indexed) and data rows
        all_rows = list(ws.iter_rows(values_only=True))
        wb.close()

        # Find the header row with "State", "County", etc.
        header_idx = None
        for i, r in enumerate(all_rows):
            if r and r[0] == "State" and r[1] == "County":
                header_idx = i
                break
        if header_idx is None:
            print(f"  WARNING: Cannot find header in {xlsx_name}")
            continue

        header = all_rows[header_idx]
        # Columns: State(0), County(1), Municipality(2), Tract(3), Block Group(4),
        #          Block(5), Vtd(6), Vtdi(7), County Name(8), Municipality Name(9),
        #          Areaname(10), Total Population(11), Total(12), White(13),
        #          Black/African American(14), AIAN(15), Asian(16), NHOPI(17),
        #          Some other race(18), Two or more(19), Hispanic(20+?)

        # Find Hispanic column
        hisp_idx = None
        for i, h in enumerate(header):
            if h and "hispanic" in str(h).lower():
                hisp_idx = i
                break

        for r in all_rows[header_idx + 1 :]:
            if not r or not r[0] or r[0] == "State":
                continue
            state = str(r[0]).strip()
            county = str(r[1]).strip()
            tract = str(r[3]).strip() if r[3] else ""
            block = str(r[5]).strip() if r[5] else ""

            if not state or not county or not tract or not block:
                continue
            # Skip summary rows (municipality = county-level)
            if len(tract) < 6 or len(block) < 4:
                continue

            geoid = f"{state.zfill(2)}{county.zfill(3)}{tract.zfill(6)}{block.zfill(4)}"
            if len(geoid) != 15:
                continue

            total_pop = int(r[11] or 0)
            white = int(r[13] or 0)
            black = int(r[14] or 0)
            asian = int(r[16] or 0)
            hispanic = int(r[hisp_idx] or 0) if hisp_idx else 0

            rows.append(
                compute_other(
                    {
                        "GEOID": geoid,
                        "adj_population": total_pop,
                        "adj_white": white,
                        "adj_black": black,
                        "adj_asian": asian,
                        "adj_hispanic": hispanic,
                    }
                )
            )

    return rows


def normalize_nv(zf: zipfile.ZipFile) -> list[dict]:
    """NV: XLSX with GEOID20, ADJPOP, racial breakdown."""
    wb = openpyxl.load_workbook(
        io.BytesIO(zf.read("2020PL94-171_ADJPOP11-13-2021_Blocks.xlsx")),
        read_only=True,
    )
    ws = wb[wb.sheetnames[0]]
    rows_iter = ws.iter_rows(values_only=True)
    header = next(rows_iter)
    col = {str(name): i for i, name in enumerate(header)}
    rows = []
    for r in rows_iter:
        geoid = str(r[col["GEOID20"]])
        rows.append(
            {
                "GEOID": geoid,
                "adj_population": int(r[col["ADJPOP"]] or 0),
                "adj_white": int(r[col["TAWHITEALN"]] or 0),
                "adj_black": int(r[col.get("TABLACKCMB", col.get("TABLACKALN", -1))] or 0),
                "adj_asian": int(r[col.get("TAASIANCMB", col.get("TAASIANALN", -1))] or 0),
                "adj_hispanic": 0,  # NV doesn't separate Hispanic in the available columns
                "adj_other": 0,  # Will compute
            }
        )
        # Compute other
        row = rows[-1]
        row["adj_other"] = max(
            0,
            row["adj_population"] - row["adj_white"] - row["adj_black"] - row["adj_asian"],
        )
    wb.close()
    return rows


def normalize_ny(zf: zipfile.ZipFile) -> list[dict]:
    """NY: XLSX with BLKID, TOTAL_ADJ, racial breakdown. Header at row 2."""
    wb = openpyxl.load_workbook(
        io.BytesIO(zf.read("PL_ADJUSTED_BLOCK.xlsx")), read_only=True
    )
    ws = wb[wb.sheetnames[0]]
    rows_iter = ws.iter_rows(values_only=True)

    # Skip to header row (row with 'STATE', 'COUNTY', etc.)
    header = None
    for r in rows_iter:
        if r and r[0] == "STATE":
            header = r
            break
    if not header:
        print("  WARNING: Cannot find header in NY xlsx")
        wb.close()
        return []

    col = {str(name): i for i, name in enumerate(header)}
    rows = []
    for r in rows_iter:
        if not r or not r[0]:
            continue
        blkid = str(r[col["BLKID"]])
        if len(blkid) != 15:
            continue
        rows.append(
            compute_other(
                {
                    "GEOID": blkid,
                    "adj_population": int(r[col["TOTAL_ADJ"]] or 0),
                    "adj_white": int(r[col["WHITE_ADJ"]] or 0),
                    "adj_black": int(r[col["BLACK_ADJ"]] or 0),
                    "adj_asian": int(r[col["ASIAN_ADJ"]] or 0),
                    "adj_hispanic": int(r[col["HISP_ADJ"]] or 0),
                }
            )
        )
    wb.close()
    return rows


def normalize_pa(zf: zipfile.ZipFile) -> list[dict]:
    """PA: XLSX at VTD level (9-digit FIPS), NOT block level.
    P-table columns. Will need proportional distribution to blocks in prepare-dev-data."""
    wb = openpyxl.load_workbook(
        io.BytesIO(zf.read("2021 Prison Adjusted Census Population.xlsx")),
        read_only=True,
    )
    ws = wb[wb.sheetnames[0]]
    rows_iter = ws.iter_rows(values_only=True)
    header = next(rows_iter)
    col = {str(name): i for i, name in enumerate(header)}

    # PA has VTD-level data: STFID is 9-digit (state+county+vtd).
    # P0010001=total, P0010003=white, P0010004=black, P0010006=asian, P0020002=hispanic
    # These are adjusted values in the standard PL table column naming.
    rows = []
    for r in rows_iter:
        stfid = str(r[col["STFID"]])
        rows.append(
            compute_other(
                {
                    "GEOID": stfid,  # VTD-level, not block
                    "adj_population": int(r[col["P0010001"]] or 0),
                    "adj_white": int(r[col["P0010003"]] or 0),
                    "adj_black": int(r[col["P0010004"]] or 0),
                    "adj_asian": int(r[col["P0010006"]] or 0),
                    "adj_hispanic": int(r[col["P0020002"]] or 0),
                }
            )
        )
    wb.close()
    print(f"  NOTE: PA data is VTD-level ({len(rows)} VTDs), not block-level.")
    print(f"  Will need proportional distribution to blocks in prepare-dev-data.")
    return rows


def normalize_va(zf: zipfile.ZipFile) -> list[dict]:
    """VA: Large CSV with GEOID20, ADJPOP, and TA* (total adjusted) race columns."""
    with zf.open("va_pl2020_official_blocks.csv") as f:
        reader = csv.DictReader(io.TextIOWrapper(f, encoding="utf-8"))
        rows = []
        for r in reader:
            # TAPERSONS = adjusted total, TA* = adjusted race
            # TAHISPANIC = adjusted Hispanic
            # TAWHITEALN = adjusted white alone
            rows.append(
                compute_other(
                    {
                        "GEOID": r["GEOID20"],
                        "adj_population": int(float(r.get("ADJPOP") or r.get("TAPERSONS") or 0)),
                        "adj_white": int(float(r.get("TAWHITEALN", 0) or 0)),
                        "adj_black": int(float(r.get("TABLACKALN", 0) or 0)),
                        "adj_asian": int(float(r.get("TAASIANALN", 0) or 0)),
                        "adj_hispanic": int(float(r.get("TAHISPANIC", 0) or 0)),
                    }
                )
            )
        return rows


def normalize_wa(zf: zipfile.ZipFile) -> list[dict]:
    """WA: CSV with GEOID20, TotalPop (adjusted), racial breakdown."""
    with zf.open("wa_2020_Redistricting_RCW4405140.csv") as f:
        reader = csv.DictReader(io.TextIOWrapper(f, encoding="utf-8"))
        rows = []
        for r in reader:
            rows.append(
                compute_other(
                    {
                        "GEOID": r["GEOID20"],
                        "adj_population": int(r["TotalPop"]),
                        "adj_white": int(r["WhiteAlNH"]),
                        "adj_black": int(r["BlackAlNH"]),
                        "adj_asian": int(r["AsianAlNH"]),
                        "adj_hispanic": int(r.get("WhiteAlHi", 0))
                        + int(r.get("BlackAlHi", 0))
                        + int(r.get("AIANAlHi", 0))
                        + int(r.get("AsianAlHi", 0))
                        + int(r.get("NHOPIAlHi", 0))
                        + int(r.get("OtherAlHi", 0))
                        + int(r.get("TwoMoreHi", 0)),
                    }
                )
            )
        return rows


# ── State → zip filename + handler mapping ──

STATE_HANDLERS = {
    "CA": ("ca_pl2020_official.zip", normalize_ca),
    "CO": ("co_pl2020_block_official.zip", normalize_co),
    "CT": ("ct_pl2020_block_adjusted_official.zip", normalize_ct),
    "DE": ("de_pl2020_b_official.zip", normalize_de),
    "IL": ("il_counterfactual_prisoner_adj_2020_blocks.zip", normalize_il),
    "MD": ("md_pl2020_block_official.zip", normalize_md),
    "MN": ("mn_pl2020_official.zip", normalize_mn),
    "MT": ("mt_pl2020_official.zip", normalize_mt),
    "NJ": ("nj_pl2020_b_official.zip", normalize_nj),
    "NV": ("nv_pl2020_official.zip", normalize_nv),
    "NY": ("ny_pl2020_official.zip", normalize_ny),
    "PA": ("pa_pl2020_official.zip", normalize_pa),
    "VA": ("va_pl2020_official.zip", normalize_va),
    "WA": ("wa_pl2020_b_official_adjusted.zip", normalize_wa),
}


def main():
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    args = [a.upper() for a in sys.argv[1:] if not a.startswith("-")]
    states_to_process = args if args else sorted(STATE_HANDLERS.keys())

    total = 0
    errors = []

    for state in states_to_process:
        if state not in STATE_HANDLERS:
            print(f"WARNING: No handler for {state}")
            continue

        zip_name, handler = STATE_HANDLERS[state]
        zip_path = INPUT_DIR / zip_name

        if not zip_path.exists():
            print(f"{state}: ZIP not found ({zip_name}), skipping")
            continue

        print(f"\n{state}: Processing {zip_name}...")
        try:
            with zipfile.ZipFile(zip_path) as zf:
                rows = handler(zf)
            if rows:
                output_path = OUTPUT_DIR / f"{state}.csv"
                write_csv(output_path, rows)
                total += 1
            else:
                errors.append(f"{state}: No rows produced")
        except Exception as e:
            errors.append(f"{state}: {e}")
            import traceback

            traceback.print_exc()

    print(f"\n{'=' * 40}")
    print(f"Processed {total} states")
    if errors:
        print(f"Errors ({len(errors)}):")
        for e in errors:
            print(f"  {e}")


if __name__ == "__main__":
    main()
