# SPDX-License-Identifier: AGPL-3.0-or-later
# © 2026 Michael Maurizi Jr.

# Block → precinct assignment.
#
# This replaces the entire rescue/noding/polygonize loop from
# prepare-dev-data.ts:1104-2271. Instead of splitting blocks where precinct
# boundaries cross, we keep blocks atomic and assign each one to whichever
# precinct covers the most of its area. maup.assign does this robustly:
# it first tries point-in-polygon on each block's representative point
# (fast path), then falls back to area overlap for blocks that representative
# point doesn't land cleanly inside any precinct.
#
# Blocks that fall outside all VEST precincts are handled per the TS policy
# at prepare-dev-data.ts:1000-1102:
#   * Block is in BEF   → snapped to nearest precinct (stray water blocks,
#                         offshore islands, VEST coastline drift, etc.).
#   * Block is not BEF,
#     has population    → hard error (inputs are broken).
#   * Block is not BEF,
#     zero population   → dropped from output (NaN assignment; caller skips).
#
# If no --befDir is supplied, every uncovered block falls into the
# "not in BEF" bucket ("strict mode" in the TS docs): the pipeline errors
# if any of them are populated and silently drops the rest.

from __future__ import annotations

import csv
from pathlib import Path
from typing import Callable

import geopandas as gpd
import maup
import pandas as pd


def _load_bef_assignments(bef_dir: str | None, state_abbr: str, log: Callable[[str], None]) -> dict[str, str]:
    """Load {befDir}/{STATE}/*.csv and return {blockGEOID: districtOrPrecinctCode}.

    The BEF CSVs have two columns: block GEOID, then a district/precinct code.
    We don't care about the specific district — only that a block appears in
    some BEF, which marks it as 'official' and thus allowed to fall back to
    nearest-precinct when outside VEST coverage.
    """
    if not bef_dir:
        return {}
    state_dir = Path(bef_dir) / state_abbr.upper()
    if not state_dir.exists():
        log(f"   WARNING: --bef-dir set but {state_dir} does not exist; ignoring")
        return {}

    assignments: dict[str, str] = {}
    csv_files = [
        p for p in state_dir.iterdir()
        if p.suffix.lower() == ".csv" and "_district_names" not in p.name
    ]
    for f in csv_files:
        with f.open() as fh:
            reader = csv.reader(fh)
            for i, row in enumerate(reader):
                if not row:
                    continue
                if i == 0:
                    # Heuristic: if first row is a header, skip it.
                    if not row[0].isdigit():
                        continue
                block_id = row[0].strip()
                if block_id:
                    assignments[block_id] = row[1].strip() if len(row) > 1 else ""
    log(f"   Loaded {len(assignments)} block GEOIDs from {len(csv_files)} BEF CSVs")
    return assignments


def assign_blocks_to_precincts(
    blocks: gpd.GeoDataFrame,
    precincts: gpd.GeoDataFrame,
    bef_dir: str | None,
    state_abbr: str,
    log: Callable[[str], None] = print,
    strict: bool = True,
) -> pd.Series:
    """Return a Series indexed by `blocks.index`, holding the precinct
    row-position assigned to each block.

    Policy for blocks that fall outside every precinct:
      * In BEF (any mode):    snapped to nearest precinct
      * Not in BEF, strict:   populated → RuntimeError; zero-pop → NaN (drop)
      * Not in BEF, ~strict:  NaN (no error, no drop — caller skips)

    Callers must treat NaN entries as blocks to exclude from vote
    disaggregation for this year. Primary-year callers also drop those
    blocks from the output set; additional-year callers keep them but
    give them no year-N votes.
    """
    assert blocks.crs is not None and precincts.crs is not None
    assert blocks.crs == precincts.crs, "blocks and precincts must share a CRS"

    log(f"   Assigning {len(blocks)} blocks to {len(precincts)} precincts via maup.assign...")
    assignment = maup.assign(blocks, precincts)

    missing_mask = assignment.isna()
    missing_count = int(missing_mask.sum())
    log(f"   maup.assign resolved {len(blocks) - missing_count} blocks; {missing_count} uncovered")

    if missing_count == 0:
        return assignment

    bef = _load_bef_assignments(bef_dir, state_abbr, log)
    missing = blocks.loc[missing_mask]

    if "GEOID20" in missing.columns and bef:
        in_bef_mask = missing["GEOID20"].isin(bef)
    else:
        in_bef_mask = pd.Series(False, index=missing.index)

    to_snap = missing[in_bef_mask]
    not_in_bef = missing[~in_bef_mask]

    # Strict mode: populated blocks that are neither in a precinct nor in the
    # BEF are a geographic gap (VEST/TIGER misalignment, missing BEF), not
    # water — bail loudly rather than silently lose people.
    if strict and len(not_in_bef) > 0 and "population" in not_in_bef.columns:
        populated = not_in_bef[not_in_bef["population"].fillna(0) > 0]
        if len(populated) > 0:
            examples = (
                populated["GEOID20"].head(5).tolist()
                if "GEOID20" in populated.columns
                else populated.index[:5].tolist()
            )
            raise RuntimeError(
                f"{len(populated)} populated blocks are outside all VEST precincts "
                f"and not listed in any BEF CSV. Inputs are likely broken "
                f"(VEST/TIGER misalignment, missing BEF). Examples: {examples}"
            )

    if len(not_in_bef) > 0:
        if strict:
            log(f"   Dropping {len(not_in_bef)} uncovered zero-population blocks (not in BEF)")
        else:
            log(f"   Leaving {len(not_in_bef)} uncovered blocks unassigned for this year (not in BEF)")

    if len(to_snap) > 0:
        log(f"   Snapping {len(to_snap)} in-BEF uncovered blocks to nearest precinct")
        snapped = gpd.sjoin_nearest(
            to_snap.reset_index().rename(columns={"index": "_orig_idx"}),
            precincts.reset_index().rename(columns={"index": "_precinct_idx"}),
            how="left",
        )
        snapped = snapped.drop_duplicates("_orig_idx", keep="first")
        snap_map = dict(zip(snapped["_orig_idx"], snapped["_precinct_idx"]))
        assignment = assignment.copy()
        for orig_idx, pidx in snap_map.items():
            if pd.notna(pidx):
                assignment.at[orig_idx] = pidx

    # Remaining NaN entries are the to_drop / unassigned set; callers must skip them.
    return assignment
