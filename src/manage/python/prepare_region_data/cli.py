# SPDX-License-Identifier: AGPL-3.0-or-later
# © 2026 Michael Maurizi Jr.

# Orchestration for the block-as-atomic-unit region-data pipeline.
#
# Flag parity with src/manage/src/commands/prepare-dev-data.ts is intentional
# so operators can swap commands without re-learning inputs.

from __future__ import annotations

import hashlib
import math
import re
import sys
import tempfile
from functools import partialmethod
from pathlib import Path
from typing import Callable

# maup uses tqdm internally (smart_repair, intersections, indexed_geometries
# progress bars). When stdout isn't a TTY (e.g. process-state.sh redirects
# to dev-data/<state>.log and we tail it), tqdm's carriage-return updates
# render as a wall of garbage in the log file. Default tqdm to disable=True
# before maup imports it, so its tqdm instances inherit the disabled
# default. Interactive runs (real terminal) keep the bars.
if not sys.stdout.isatty():
    try:
        from tqdm import tqdm as _tqdm
        _tqdm.__init__ = partialmethod(_tqdm.__init__, disable=True)
    except ImportError:
        pass

import click
import geopandas as gpd
import pandas as pd
import shapely

from .assignment import assign_blocks_to_precincts
from .census import apply_adjusted_pl, load_blocks_and_demographics
from .output import write_geojson
from .projections import get_state_projection
from .vest import (
    SHAPEFILE_PREFERENCES,
    detect_county_field,
    load_vest_precincts,
    resolve_placeholder_duplicates,
)
from .votes import (
    Assignment,
    PartyVotes,
    apportion as vote_apportion,
    disaggregate_block_votes,
    extract_voting_data,
    is_vote_column,
    reconcile_precinct_votes,
    vote_field_name,
)


DEMO_COLUMNS = [
    "population", "white", "black", "asian", "hispanic", "other",
    "VAP", "VAP White", "VAP Black", "VAP Asian", "VAP Hispanic", "VAP Other",
    "VAP_MOD",
    "CVAP", "CVAP White", "CVAP Black", "CVAP Asian", "CVAP Hispanic", "CVAP Other",
]
ADJ_COLUMN_CANDIDATES = [
    "adj_population", "adj_white", "adj_black", "adj_asian", "adj_hispanic", "adj_other",
]


def _parse_precinct_field(value: str) -> tuple[str, str]:
    """`fieldName` or `fieldName:nameField` → (fieldName, nameField|"")"""
    if ":" in value:
        a, b = value.split(":", 1)
        return a, b
    return value, ""


def _reproject(gdf: gpd.GeoDataFrame, target_crs: str) -> gpd.GeoDataFrame:
    if gdf.crs is None:
        gdf = gdf.set_crs("EPSG:4326")
    return gdf.to_crs(target_crs)


def _polygons_only(geom):
    """make_valid output is always valid but may be a GeometryCollection
    mixing polygons with linear/point remnants. Keep just the polygonal
    part. Geometries with no polygonal content collapse to None and get
    caught by the post-repair audit."""
    if geom is None or geom.is_empty:
        return geom
    if geom.geom_type in ("Polygon", "MultiPolygon"):
        return geom
    if geom.geom_type == "GeometryCollection":
        polys = [g for g in geom.geoms if g.geom_type in ("Polygon", "MultiPolygon")]
        if not polys:
            return None
        if len(polys) == 1:
            return polys[0]
        return shapely.union_all(polys)
    return None


def _repair_vest(
    gdf: gpd.GeoDataFrame, log: Callable[[str], None],
) -> gpd.GeoDataFrame:
    """Lightweight VEST geometry repair: pointwise vertex snap to a
    state-wide grid, plus shapely.make_valid on rows still invalid after
    the snap.

    Skips maup.smart_repair AND maup.quick_repair — both depend on
    `iter_adjacencies` (pairwise STRtree query + per-pair `intersection`
    on each candidate), whose cost on FL's coastline-laden 6160-precinct
    VEST (lots of bbox overlaps from islands and peninsulas, expensive
    intersections on complex polygons) never finishes. The vertex snap
    mirrors maup.smart_repair's default snap_magnitude formula
    (smart_repair.py:175-186), preserving the GEOS rounding-error defense
    that originally motivated smart_repair on FL.

    Trade-off accepted: cross-precinct overlaps in the VEST source are NOT
    resolved. `maup.assign`'s max-area rule deterministically assigns each
    block to the precinct that claims more area, and reconcile preserves
    per-precinct vote totals exactly. The cosmetic effect is that the
    dissolved-union shape of an overlap-winning precinct is slightly
    larger than its VEST geometry, and the loser's slightly smaller —
    within the existing "blocks-as-atomic-unit" design's tolerance. Vote
    integrity per precinct is unchanged.
    """
    bbox = gdf.geometry.total_bounds
    largest_bound = max(bbox[2] - bbox[0], bbox[3] - bbox[1])
    snap_magnitude = int(math.log10(largest_bound)) - 9
    grid_size = 10 ** snap_magnitude

    pre_invalid = int((~gdf.geometry.is_valid).sum())
    log(
        f"   Snapping {len(gdf)} VEST geoms to grid_size={grid_size:.3g} "
        f"({pre_invalid} pre-snap invalid)"
    )

    out = gdf.copy()
    # Stash pre-repair geoms by index so we can recover a fallback location
    # for any row that collapses below.
    pre_repair_geoms = gdf.geometry
    # mode='pointwise' rounds each vertex without checking topology — it
    # can't fail on invalid input (default 'valid_output' tripped a
    # side-location-conflict on FL's pre-snap invalids). The make_valid
    # pass below catches any self-intersections the snap introduces.
    out["geometry"] = out.geometry.set_precision(grid_size, mode="pointwise")

    invalid_mask = ~out.geometry.is_valid
    n_invalid = int(invalid_mask.sum())
    if n_invalid:
        log(f"   Running shapely.make_valid on {n_invalid} invalid geometries...")
        # Per-row with try/except: vectorized .make_valid() aborts the whole
        # batch if a single geom triggers a GEOS error (e.g. OH 2024 hit
        # "Overlay input is mixed-dimension" when set_precision produced a
        # GeometryCollection mixing 1D/2D parts). 'structure' uses
        # GEOSMakeValidWithParams and handles cases the default 'linework'
        # method can't. Anything still un-repairable becomes None and gets
        # caught by the post-repair audit (collapse-rescue or hard fail).
        n_structure = 0
        n_failed = 0
        for idx in out.index[invalid_mask]:
            g = out.at[idx, "geometry"]
            try:
                fixed = shapely.make_valid(g)
            except shapely.errors.GEOSException:
                try:
                    fixed = shapely.make_valid(g, method="structure")
                    n_structure += 1
                except shapely.errors.GEOSException:
                    fixed = None
                    n_failed += 1
            out.at[idx, "geometry"] = _polygons_only(fixed) if fixed is not None else None
        if n_structure:
            log(f"   {n_structure} geometries needed make_valid(method='structure') fallback")
        if n_failed:
            log(f"   {n_failed} geometries un-repairable; deferring to collapse-rescue")

    null_after = out.geometry.isna() | out.geometry.is_empty
    n_null = int(null_after.sum())
    if n_null:
        # Audit collapsed rows. Zero-vote remnants are safe to drop. Rows
        # that carried votes get a tiny-buffer fallback at the pre-repair
        # geom's bounds-center, so maup.assign can route them into a
        # containing block — equivalent to proration into one neighbor.
        # Without this, votes would be silently lost.
        vote_cols = [c for c in out.columns if isinstance(c, str) and is_vote_column(c)]
        rescued: list[tuple[int, int]] = []
        unrescuable: list[tuple[int, int]] = []
        if vote_cols:
            buf_radius = grid_size * 4
            for idx in out.index[null_after]:
                row_total = 0
                for c in vote_cols:
                    v = out.at[idx, c]
                    if v is None:
                        continue
                    try:
                        row_total += int(float(v))
                    except (TypeError, ValueError):
                        pass
                if row_total <= 0:
                    continue
                pre = pre_repair_geoms.loc[idx]
                if pre is None or pre.is_empty:
                    unrescuable.append((idx, row_total))
                    continue
                minx, miny, maxx, maxy = pre.bounds
                cx, cy = (minx + maxx) / 2.0, (miny + maxy) / 2.0
                out.at[idx, "geometry"] = shapely.Point(cx, cy).buffer(buf_radius)
                rescued.append((idx, row_total))
        if unrescuable:
            sample = ", ".join(f"row {i} ({t} votes)" for i, t in unrescuable[:5])
            total = sum(t for _, t in unrescuable)
            raise RuntimeError(
                f"VEST repair collapsed {len(unrescuable)} rows with votes whose "
                f"pre-repair geometry was also empty; {total} votes would be lost. "
                f"Examples: {sample}. Source data needs a fix."
            )
        if rescued:
            sample = ", ".join(f"row {i} ({t} votes)" for i, t in rescued[:5])
            log(
                f"   Rescued {len(rescued)} collapsed VEST rows carrying votes "
                f"via tiny-buffer fallback at pre-repair bounds-center ({sample})"
            )
        # Re-evaluate after rescue — any rows still null are zero-vote and safe.
        null_after = out.geometry.isna() | out.geometry.is_empty
        n_null = int(null_after.sum())
        if n_null:
            log(f"   Dropping {n_null} VEST rows with no polygonal area after repair (zero votes — safe)")
            out = out.loc[~null_after].reset_index(drop=True)
    return out


def _extract_precinct_votes(
    precincts: gpd.GeoDataFrame,
    precinct_field: str,
    name_field: str,
    county_field: str | None,
    log: Callable[[str], None],
) -> tuple[pd.DataFrame, set[str], str]:
    """Build a DataFrame keyed by precinct row-position with columns:
      precinctId, precinctName, countyFp, {office}_{party} for each office.
    Returns (df, offices_found, election_year)."""
    offices_found: set[str] = set()
    election_year = ""

    rows: list[dict] = []
    for i, row in precincts.iterrows():
        props = row.drop("geometry").to_dict()
        by_office, year = extract_voting_data(props)
        if year and not election_year:
            election_year = year
        for office in by_office:
            offices_found.add(office)

        pid = str(props.get(precinct_field, ""))
        pname = str(props.get(name_field, pid)) if name_field else pid
        county = str(props.get(county_field, "")) if county_field else ""

        rec = {
            "precinct_row": i,
            "precinctId": pid,
            "precinctName": pname,
            "countyFp": county,
        }
        for office, pv in by_office.items():
            rec[f"{office}__democrat"] = pv.democrat
            rec[f"{office}__republican"] = pv.republican
            rec[f"{office}__other"] = pv.other
        rows.append(rec)

    df = pd.DataFrame(rows)
    log(f"   Detected offices: {sorted(offices_found)}; year: {election_year or '(none)'}")
    return df, offices_found, election_year


def _disaggregate_and_reconcile(
    blocks: gpd.GeoDataFrame,
    vest_gdf: gpd.GeoDataFrame,
    assignment: pd.Series,
    precinct_df: pd.DataFrame,
    offices: set[str],
    election_year: str,
    feature_props: list[dict],
    log: Callable[[str], None],
    is_primary: bool = False,
) -> None:
    """For each block, compute its per-party vote share for each office in
    the election represented by `precinct_df`, mutate `feature_props`
    in-place, then reconcile so per-precinct sums match expected totals.

    Lost-precinct absorption: precincts that VEST has but `maup.assign`
    passed over (the precinct is smaller than every TIGER block it
    overlaps, so the max-area rule never picks it) get handled by:
      (a) **Block-stealing** (primary year only): re-key the block with the
          largest intersection-with-lost-precinct area from its current
          donor precinct to the lost precinct, provided the donor has at
          least one other block to fall back on. The stolen block's
          `precinct` compound key in `feature_props` is rewritten so the
          lost precinct survives in the output GeoJSON. Reconcile then
          handles vote redistribution for both donor and lost precinct.
      (b) **Prorate fallback** (additional years; or primary-year cases
          where every donor would be orphaned by stealing): distribute the
          lost precinct's votes additively across all overlapping blocks
          weighted by intersection area. State-wide totals stay exact; the
          lost precinct's identity is folded into neighbor precincts.
    """
    if not offices or not election_year:
        log("   No voting data in this VEST; skipping disaggregation")
        return

    # precinct_df is indexed positionally (row-position in precincts GeoDataFrame).
    # Map precinct_row → votes per office.
    precinct_votes: dict[int, dict[str, PartyVotes]] = {}
    for r in precinct_df.itertuples():
        d_votes: dict[str, PartyVotes] = {}
        for office in offices:
            d = getattr(r, f"{office}__democrat", 0) or 0
            rep = getattr(r, f"{office}__republican", 0) or 0
            oth = getattr(r, f"{office}__other", 0) or 0
            d_votes[office] = PartyVotes(democrat=int(d), republican=int(rep), other=int(oth))
        precinct_votes[r.precinct_row] = d_votes

    # Aggregate VAP_MOD per precinct for weighting.
    vap_mod_by_precinct = (
        blocks.assign(_pi=assignment.values, _vm=blocks["VAP_MOD"].astype(int))
        .groupby("_pi")["_vm"]
        .sum()
        .to_dict()
    )

    # precinct_assigned: maps precinct_row → {office: [Assignment, ...]}
    # Assignment.feature_idx is the block's position in feature_props.
    precinct_assigned: dict[int, dict[str, list[Assignment]]] = {}
    feature_idx_by_block_row: dict[int, int] = {}

    # Disaggregate per block. Skip NaN assignments (block uncovered this year
    # and not in BEF) — they simply contribute no votes for this election.
    for feature_idx, (block_row_idx, pi) in enumerate(assignment.items()):
        feature_idx_by_block_row[block_row_idx] = feature_idx
        if pd.isna(pi):
            continue
        pi_int = int(pi)
        if pi_int not in precinct_votes:
            continue
        vap_mod = int(blocks.at[block_row_idx, "VAP_MOD"])
        precinct_vap_mod = int(vap_mod_by_precinct.get(pi_int, 0))

        # Build per-office total dict keyed by office. The "total" we pass is
        # the precinct's VAP_MOD sum; the weight is this block's VAP_MOD.
        totals = {office: precinct_vap_mod for office in offices}
        disagg = disaggregate_block_votes(
            precinct_votes[pi_int], totals, float(vap_mod), offices, election_year
        )
        feature_props[feature_idx].update(disagg)

        per_office = precinct_assigned.setdefault(pi_int, {})
        for office in offices:
            per_office.setdefault(office, []).append(
                Assignment(feature_idx=feature_idx, weight=float(vap_mod))
            )

    # ── Discover lost precincts (have votes, no block assigned) ────────────
    assigned_precinct_rows = set(precinct_assigned.keys())
    lost_with_votes: list[tuple[int, str, int, dict[str, PartyVotes]]] = []
    for r in precinct_df.itertuples():
        if r.precinct_row in assigned_precinct_rows:
            continue
        per_office_pv: dict[str, PartyVotes] = precinct_votes[r.precinct_row]
        total_v = sum(pv.democrat + pv.republican + pv.other for pv in per_office_pv.values())
        if total_v > 0:
            lost_with_votes.append((r.precinct_row, r.precinctId, total_v, per_office_pv))

    # ── Block-steal pass + prorate-queue (must run before reconcile) ───────
    prorate_pending: list[tuple[int, str, int, dict[str, PartyVotes], list[tuple[int, float]]]] = []
    # Block positions already claimed by a prior lost-precinct steal in this
    # pass — skip them as both steal candidates and prorate recipients so we
    # don't double-count if two tiny precincts overlap the same block.
    stolen_positions: set[int] = set()
    if lost_with_votes:
        log(f"   {len(lost_with_votes)} precincts unassigned with nonzero votes; absorbing...")
        block_sindex = blocks.sindex
        precinct_by_row = {r.precinct_row: r for r in precinct_df.itertuples()}
        for prec_row, prec_id, vote_total, per_office_pv in lost_with_votes:
            lost_geom = vest_gdf.iloc[prec_row].geometry
            cand_positions = list(block_sindex.query(lost_geom))
            # Two intersection lists: `unclaimed` (eligible for block-stealing
            # — must own the block exclusively) and `all` (used by prorate
            # fallback, which is additive and tolerates already-claimed
            # blocks). NY had a cluster of co-located lost precincts where
            # earlier steals consumed every candidate of a later precinct;
            # prior code raised, but proration over the full overlap set is
            # the correct fallback there.
            unclaimed_intersections: list[tuple[int, float]] = []
            all_intersections: list[tuple[int, float]] = []
            for cp in cand_positions:
                bg = blocks.geometry.iloc[cp]
                if bg is None or bg.is_empty:
                    continue
                if bg.intersects(lost_geom):
                    ia = bg.intersection(lost_geom).area
                    if ia > 0:
                        all_intersections.append((cp, ia))
                        if cp not in stolen_positions:
                            unclaimed_intersections.append((cp, ia))
            if not all_intersections:
                raise RuntimeError(
                    f"Lost precinct {prec_id} ({vote_total} votes, year {election_year}) "
                    f"has no overlapping blocks at all — should not occur"
                )
            unclaimed_intersections.sort(key=lambda t: -t[1])
            all_intersections.sort(key=lambda t: -t[1])

            stolen = False
            if is_primary:
                for cp, ia in unclaimed_intersections:
                    block_row_idx = blocks.index[cp]
                    donor_pi_raw = assignment.iloc[cp]
                    if pd.isna(donor_pi_raw):
                        continue
                    donor_pi = int(donor_pi_raw)
                    if donor_pi not in precinct_assigned:
                        continue
                    any_office = next(iter(precinct_assigned[donor_pi]))
                    donor_block_count = len(precinct_assigned[donor_pi][any_office])
                    if donor_block_count <= 1:
                        continue  # would orphan donor; try next candidate
                    # Steal!
                    feature_idx = feature_idx_by_block_row[block_row_idx]
                    for office in list(precinct_assigned[donor_pi].keys()):
                        precinct_assigned[donor_pi][office] = [
                            a for a in precinct_assigned[donor_pi][office]
                            if a.feature_idx != feature_idx
                        ]
                    vap_mod = int(blocks.at[block_row_idx, "VAP_MOD"])
                    weight = float(vap_mod) if vap_mod > 0 else 1.0
                    new_per_office = precinct_assigned.setdefault(prec_row, {})
                    for office in offices:
                        new_per_office.setdefault(office, []).append(
                            Assignment(feature_idx=feature_idx, weight=weight)
                        )
                    # Re-key the block's precinct compound + name so the
                    # lost precinct survives in the output GeoJSON.
                    lost_rec = precinct_by_row[prec_row]
                    new_cfp = blocks.at[block_row_idx, "COUNTYFP20"] or lost_rec.countyFp
                    feature_props[feature_idx]["precinct"] = f"{new_cfp}-{lost_rec.precinctId}"
                    feature_props[feature_idx]["precinct_name"] = lost_rec.precinctName
                    log(
                        f"     Stole block {blocks.at[block_row_idx, 'GEOID20']} "
                        f"(intersect={ia:.1f}) from donor row {donor_pi} for lost "
                        f"precinct {prec_id} ({vote_total} votes)"
                    )
                    stolen_positions.add(cp)
                    stolen = True
                    break
            if not stolen:
                if not unclaimed_intersections:
                    reason = "all candidate blocks already claimed by prior steals"
                elif not is_primary:
                    reason = "additional year"
                else:
                    reason = "every donor would be orphaned"
                log(
                    f"     Prorating {vote_total} votes for lost precinct "
                    f"{prec_id} across {len(all_intersections)} overlapping blocks "
                    f"({reason})"
                )
                prorate_pending.append(
                    (prec_row, prec_id, vote_total, per_office_pv, all_intersections)
                )

    # ── Reconcile (handles donor + stolen-block redistribution) ────────────
    def get_precinct_votes(pi: int) -> dict[str, PartyVotes]:
        return precinct_votes[pi]

    def get_vote(idx: int, field: str) -> int:
        return int(feature_props[idx].get(field, 0))

    def set_vote(idx: int, field: str, value: int) -> None:
        feature_props[idx][field] = int(value)

    reconciled = reconcile_precinct_votes(
        precinct_assigned, get_precinct_votes, get_vote, set_vote, election_year
    )
    log(f"   Reconciled {reconciled} precinct-party totals ({election_year})")

    # ── Prorate fallback (additive, post-reconcile) ────────────────────────
    for prec_row, prec_id, vote_total, per_office_pv, intersections in prorate_pending:
        weights = [float(ia) for _, ia in intersections]
        for office in offices:
            pv = per_office_pv.get(office, PartyVotes())
            for party in ("democrat", "republican", "other"):
                expected = pv.get(party)
                if expected == 0:
                    continue
                shares = vote_apportion(int(expected), weights)
                field = vote_field_name(office, party, election_year)
                for (cp, _), share in zip(intersections, shares):
                    if share == 0:
                        continue
                    block_row_idx = blocks.index[cp]
                    fi = feature_idx_by_block_row[block_row_idx]
                    feature_props[fi][field] = (
                        int(feature_props[fi].get(field, 0)) + int(share)
                    )


def _vest_repair_cache_path(zip_path: str, state_crs: str) -> Path:
    """Cache path for the post-reproject + post-repair GeoDataFrame.

    Lives in a hidden .cache/ subdir alongside the zip so it's invisible
    in normal staging listings but trivial to wipe (rm -rf .cache). The
    filename embeds a hash of (zip contents + state CRS + repair-version)
    so any change to source data, projection, or repair logic invalidates
    automatically.
    """
    zp = Path(zip_path)
    cache_dir = zp.parent / ".cache"
    h = hashlib.sha256()
    with zp.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    h.update(state_crs.encode("utf-8"))
    # Bump when _repair_vest's behavior changes so stale caches don't
    # silently return geometries from a different repair pipeline.
    h.update(b"repair-v9-alt-vote-col-regex")
    digest = h.hexdigest()[:16]
    return cache_dir / f"{zp.stem}.repaired.{digest}.gpkg"


def _prepare_vest(
    vest_path: str,
    state_crs: str,
    precinct_field: str,
    scratch_dir: Path,
    log: Callable[[str], None],
) -> gpd.GeoDataFrame:
    # Caching boundary: everything from "open zip" through "_repair_vest"
    # is deterministic on (zip contents, state CRS). Placeholder resolution
    # depends on `precinct_field` separately, so it stays outside the cache
    # and runs every invocation.
    cache_path = _vest_repair_cache_path(vest_path, state_crs)
    if cache_path.exists():
        log(f"   Loading cached repaired VEST from {cache_path.name}")
        vest = gpd.read_file(cache_path)
        log(f"   {len(vest)} precincts loaded from cache")
    else:
        log(f"   Loading VEST zip {vest_path}...")
        vest = load_vest_precincts(vest_path, scratch_dir)
        log(f"   {len(vest)} precincts loaded")
        if vest.crs is None:
            log("   VEST has no CRS; assuming WGS84")
            vest = vest.set_crs("EPSG:4326")
        vest = vest.to_crs(state_crs)
        vest = _repair_vest(vest, log)
        cache_path.parent.mkdir(parents=True, exist_ok=True)
        log(f"   Caching repaired VEST → {cache_path.name}")
        vest.to_file(cache_path, driver="GPKG")

    vest = resolve_placeholder_duplicates(vest, precinct_field, log)
    vest = vest.reset_index(drop=True)
    return vest


@click.group()
def main() -> None:
    """DistrictBuilder Python data pipeline (complements the TS `manage` CLI)."""


@main.command("prepare-region-data")
@click.argument("state_fips")
@click.argument("state_abbr")
@click.option("-v", "--vest", required=True, help="Path to VEST shapefile zip (primary year)")
@click.option(
    "-p", "--vest-precinct-field", "vest_precinct_field", required=True,
    help="VEST precinct-id field name; optionally `idField:nameField` for display name",
)
@click.option(
    "-o", "--output", default="dev-data/output.geojson",
    help="Output GeoJSON path (default dev-data/output.geojson)",
)
@click.option(
    "-c", "--census-cache", "census_cache", default=None,
    help="Path prefix for cached Census blocks + demographics (shares shape with prepare-dev-data)",
)
@click.option(
    "-a", "--additional-vest", "additional_vest", default="",
    help="Comma-separated list of precinctField:path pairs for additional election years",
)
@click.option(
    "--bef-dir", "bef_dir", default=None,
    help="Directory containing per-state BEF CSV subdirectories",
)
@click.option(
    "--adj-dir", "adj_dir", default=None,
    help="Directory containing {STATE}.csv adjusted-PL files",
)
def prepare_region_data(
    state_fips: str,
    state_abbr: str,
    vest: str,
    vest_precinct_field: str,
    output: str,
    census_cache: str | None,
    additional_vest: str,
    bef_dir: str | None,
    adj_dir: str | None,
) -> None:
    """Block-as-atomic-unit region-data preparation (RDH-style, no block splitting)."""
    state_fips = state_fips.zfill(2)
    state_abbr = state_abbr.upper()
    log = click.echo
    log(f"Preparing region data for {state_abbr} (FIPS {state_fips})")

    state_crs = get_state_projection(state_abbr)
    log(f"Local projection: {state_crs}")

    with tempfile.TemporaryDirectory(prefix=f"prep-region-{state_abbr}-") as tmp_str:
        scratch_dir = Path(tmp_str)

        # ── Step 1: Census blocks + demographics ───────────────────────────
        blocks, demo, county_names = load_blocks_and_demographics(
            state_fips, census_cache, scratch_dir, log=log,
        )
        # Normalize GEOID column. TIGER uses GEOID20; ensure demo uses GEOID.
        if "GEOID20" not in blocks.columns and "GEOID" in blocks.columns:
            blocks = blocks.rename(columns={"GEOID": "GEOID20"})
        demo = apply_adjusted_pl(demo, adj_dir, state_abbr, log=log)

        # Merge demographics onto blocks.
        blocks = blocks.merge(
            demo, left_on="GEOID20", right_on="GEOID", how="left",
        )
        missing_demo = int(blocks["population"].isna().sum())
        if missing_demo:
            log(f"   {missing_demo} blocks missing Census demographics; filling with 0")

        # Normalize every demographic + adjusted-PL column to integer with 0
        # for missing values, regardless of whether population specifically
        # had NaNs. NaNs arrive from two independent left-joins:
        #   1. blocks → census demo (blocks the API didn't return)
        #   2. blocks → adj CSV (blocks not listed in adjusted-PL)
        # The TS pipeline used `Math.round(parseFloat(...) || 0)` which
        # collapsed both classes to 0; we do the same here.
        adj_with_nans = 0
        for col in DEMO_COLUMNS + ADJ_COLUMN_CANDIDATES:
            if col not in blocks.columns:
                continue
            n_nan = int(blocks[col].isna().sum())
            if n_nan and col.startswith("adj_"):
                adj_with_nans += n_nan
            blocks[col] = blocks[col].fillna(0).round().astype(int)
        if adj_with_nans:
            log(
                f"   {adj_with_nans} adjusted-PL cell(s) were NaN "
                "(blocks not in --adj-dir CSV); filled with 0"
            )

        # Reproject to state CRS for spatial work. TIGER blocks are valid
        # and non-overlapping by Census construction; we don't repair them.
        log(f"\n2. Reprojecting {len(blocks)} blocks to {state_crs}")
        blocks = _reproject(blocks, state_crs).reset_index(drop=True)

        # ── Step 3: Primary VEST ───────────────────────────────────────────
        precinct_field, name_field = _parse_precinct_field(vest_precinct_field)
        log(f"\n3. Loading primary VEST ({vest_precinct_field})...")
        primary_vest = _prepare_vest(vest, state_crs, precinct_field, scratch_dir, log)
        county_field = detect_county_field(list(primary_vest.columns))

        # Extract precinct votes.
        primary_votes_df, primary_offices, primary_year = _extract_precinct_votes(
            primary_vest, precinct_field, name_field, county_field, log,
        )

        # ── Step 4: Assign blocks → precincts (primary) ────────────────────
        log(f"\n4. Assigning blocks to primary precincts...")
        primary_assignment = assign_blocks_to_precincts(
            blocks, primary_vest, bef_dir, state_abbr, log=log, strict=True,
        )

        # Drop blocks that the strict-mode assignment left as NaN: uncovered
        # in VEST AND not in any BEF AND zero population. Keeping them would
        # put null-precinct features in the output.
        kept_mask = primary_assignment.notna()
        dropped_count = int((~kept_mask).sum())
        if dropped_count:
            blocks = blocks.loc[kept_mask].reset_index(drop=True)
            primary_assignment = primary_assignment.loc[kept_mask].reset_index(drop=True)
            log(f"   Keeping {len(blocks)} blocks after dropping {dropped_count} uncovered")

        # ── Step 5: Build per-block output properties ──────────────────────
        log("\n5. Building per-block output properties...")
        # Determine adj fields actually present.
        adj_fields = [c for c in ADJ_COLUMN_CANDIDATES if c in blocks.columns]
        if adj_fields:
            log(f"   Adjusted fields present: {', '.join(adj_fields)}")

        primary_by_row = {
            int(r.precinct_row): r for r in primary_votes_df.itertuples()
        }

        feature_props: list[dict] = []
        for block_row_idx, pi in primary_assignment.items():
            pi_int = int(pi)
            block_row = blocks.loc[block_row_idx]
            geoid = block_row["GEOID20"]
            county_fp = block_row.get("COUNTYFP20", "")
            prec = primary_by_row.get(pi_int)
            precinct_id = prec.precinctId if prec is not None else ""
            precinct_name = prec.precinctName if prec is not None else precinct_id
            if not county_fp and prec is not None:
                county_fp = prec.countyFp
            props: dict = {
                "block": geoid,
                "precinct": f"{county_fp}-{precinct_id}",
                "precinct_name": precinct_name,
                "county": county_fp,
                "county_name": county_names.get(county_fp, county_fp),
            }
            for col in DEMO_COLUMNS + adj_fields:
                # VAP_MOD is a scratch column on `blocks` used by the
                # disaggregation weighting; not part of the public output
                # schema. update-voting-data's backfillVapMod() can recompute
                # it from VAP + a Census P5_003N fetch if ever needed.
                if col == "VAP_MOD":
                    continue
                if col in block_row.index:
                    props[col] = int(block_row[col])
            feature_props.append(props)

        # ── Step 6: Disaggregate + reconcile primary votes ─────────────────
        log("\n6. Disaggregating primary votes by VAP_MOD weighting...")
        _disaggregate_and_reconcile(
            blocks, primary_vest, primary_assignment, primary_votes_df,
            primary_offices, primary_year, feature_props, log,
            is_primary=True,
        )

        # Sanity: every VEST precinct survives in output.
        distinct_precincts = {p["precinct"] for p in feature_props}
        log(
            f"   Distinct output precincts: {len(distinct_precincts)} / "
            f"{len(primary_vest)} VEST"
        )

        # ── Step 7: Additional voting years ────────────────────────────────
        if additional_vest.strip():
            log("\n7. Processing additional VEST years...")
            pairs = [
                s.strip() for s in additional_vest.split(",") if ":" in s
            ]
            for pair in pairs:
                idx = pair.index(":")
                add_field, add_path = pair[:idx], pair[idx + 1:]
                add_precinct_field, add_name_field = _parse_precinct_field(add_field)
                log(f"   Year pair: {add_field} from {add_path}")
                add_vest = _prepare_vest(
                    add_path, state_crs, add_precinct_field, scratch_dir, log,
                )
                add_county_field = detect_county_field(list(add_vest.columns))
                add_votes_df, add_offices, add_year = _extract_precinct_votes(
                    add_vest, add_precinct_field, add_name_field, add_county_field, log,
                )
                # Additional years run non-strict: a block that was in the
                # primary year's coverage but sits outside year-N's precincts
                # and isn't in BEF just gets no year-N votes, not a hard error.
                add_assignment = assign_blocks_to_precincts(
                    blocks, add_vest, bef_dir, state_abbr, log=log, strict=False,
                )
                _disaggregate_and_reconcile(
                    blocks, add_vest, add_assignment, add_votes_df,
                    add_offices, add_year, feature_props, log,
                    is_primary=False,
                )

        # ── Step 8: Write output ───────────────────────────────────────────
        log("\n8. Writing output GeoJSON...")
        # Build a GeoDataFrame with properties + geometry aligned by index.
        out_columns = list(feature_props[0].keys()) if feature_props else []
        out_df = pd.DataFrame(feature_props)
        # Blocks unassigned for an additional year never get its vote keys
        # written, so DataFrame() leaves NaN there. Backfill 0 — semantically
        # correct (no assignment → no votes), and stops downstream JSON-null
        # values from tripping consumers like process-geojson's
        # abbreviateNumber, which calls .toPrecision() unguarded.
        vote_col_re = re.compile(r"^(?:[A-Z]+_)?(?:democrat|republican|other)\d{2}$")
        for col in out_df.columns:
            if vote_col_re.match(col):
                out_df[col] = out_df[col].fillna(0).astype(int)
        out_gdf = gpd.GeoDataFrame(
            out_df, geometry=blocks.geometry.values, crs=blocks.crs,
        )
        # Union of every output property across features (additional years
        # may produce columns present on only a subset).
        all_property_columns: list[str] = []
        seen: set[str] = set()
        for f in feature_props:
            for k in f:
                if k not in seen:
                    seen.add(k)
                    all_property_columns.append(k)
        write_geojson(out_gdf, all_property_columns, output, log=log)

        # Summary
        total_pop = int(sum(p.get("population", 0) for p in feature_props))
        counties = {p["county"] for p in feature_props}
        precincts = {p["precinct"] for p in feature_props}
        log("\nSummary:")
        log(f"  Population: {total_pop:,}")
        log(f"  Counties:   {len(counties)}")
        log(f"  Precincts:  {len(precincts)}")
        log(f"  Features:   {len(feature_props)}")


if __name__ == "__main__":
    main()
