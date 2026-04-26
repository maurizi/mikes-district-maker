# SPDX-License-Identifier: AGPL-3.0-or-later
# © 2026 Michael Maurizi Jr.

# VEST shapefile loading and placeholder-precinct resolution.
#
# The placeholder-precinct logic is ported from
# prepare-dev-data.ts::resolvePlaceholderDuplicates (lines 89-347).
# States like CA use a single precinct ID for administrative catch-all
# categories and split it across dozens of polygon fragments. We:
#   * absorb sub-SLIVER_AREA_M2 fragments into their nearest same-county
#     real-precinct neighbor (geographic merge),
#   * promote larger fragments to distinct precincts with a `-N` suffix.

from __future__ import annotations

import re
import zipfile
from pathlib import Path
from typing import Callable

import geopandas as gpd
from shapely.geometry import MultiPolygon, Polygon
from shapely.ops import unary_union


# RDH shapefile zips often bundle multiple variants of the same state's data,
# one per office (e.g. `_cong_prec`, `_sldl_prec`, `_sldu_prec`, `_all_prec`).
# We want the "all offices" superset. First match wins. Mirrors
# voting-data.ts::SHAPEFILE_PREFERENCES.
#
# RDH naming is inconsistent across years: some files use `_no_splits_prec`
# (infix), others `_prec_no_splits` (suffix) — e.g. OH 2022 uses the latter.
# Both variants are listed; `_prec_no_splits` was added after OH 2022 fell
# through every preference and the loader picked _sldu by accident, which has
# only `GSU…` columns that fail the vote-column regex.
SHAPEFILE_PREFERENCES: tuple[str, ...] = (
    "_all_prec",
    "_no_splits_prec",
    "_prec_no_splits",
    "_all_pber",
    "_all_tx_vtd",
    "_st_prec",
    "_prec_st",
    "_st_",
)

# Below this area a fragment of a duplicate-ID precinct group is treated as
# a sliver and absorbed into its nearest neighbor; at or above it, we keep
# it as a distinct precinct with a -N suffix.
SLIVER_AREA_M2 = 100


def _extract_vest_zip(zip_path: Path, dest: Path) -> Path:
    dest.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(zip_path) as zf:
        zf.extractall(dest)
    return dest


def _find_preferred_shapefile(
    dest: Path,
    preferences: tuple[str, ...] = SHAPEFILE_PREFERENCES,
) -> Path:
    candidates = [
        p for p in dest.rglob("*.shp")
        if not any(part.startswith(".") or part == "__MACOSX" for part in p.parts)
    ]
    if not candidates:
        raise FileNotFoundError(f"No .shp file found under {dest}")
    for pref in preferences:
        for c in candidates:
            if pref.lower() in str(c).lower():
                return c
    return candidates[0]


# ---------------------------------------------------------------------------
# County-FIPS / county-name field detection. VEST schemas vary by state.

# Year-suffixed variants like COUNTYFP18, COUNTYFP20 are common — VEST
# shapefiles for OH 2016/2018 use them and silently fell through under the
# old explicit-name list, leaving resolve_placeholder_duplicates unable to
# split same-ID precincts across counties.
_COUNTY_FIELD_RE = re.compile(
    r"^(?:COUNTYFP|COUNTY_FP|COUNTYFIPS|CNTY_FIPS|CTY_FIPS)\d{0,2}$"
    r"|^(?:COUNTY|CNTY_NAME|COUNTY_NAM|COUNTY_NAME)$"
)


def detect_county_field(columns: list[str]) -> str | None:
    for c in columns:
        if _COUNTY_FIELD_RE.match(c):
            return c
    return None


# ---------------------------------------------------------------------------
# Vote-column detection — defer to votes.is_vote_column so all naming
# conventions (standard + WI-style alt) stay in sync.

from .votes import is_vote_column  # noqa: E402


def _has_real_votes(row: dict) -> bool:
    for k, v in row.items():
        if not isinstance(k, str) or not is_vote_column(k):
            continue
        if isinstance(v, (int, float)) and v > 0:
            return True
    return False


# ---------------------------------------------------------------------------

def load_vest_precincts(
    zip_path: str,
    scratch_dir: Path,
) -> gpd.GeoDataFrame:
    """Extract the VEST zip into scratch_dir and load the preferred shapefile.

    Each zip extracts into its own subdirectory keyed off the zip's stem to
    avoid cross-contamination when multiple VEST zips are processed in a
    single CLI run (e.g., one primary + several --additional-vest entries).
    Without per-zip dirs, _find_preferred_shapefile would rglob across all
    previously-extracted shapefiles too, and a zip whose internal shapefile
    name doesn't match any preference would silently fall through to a
    leftover from an earlier extraction.
    """
    zp = Path(zip_path)
    extract_dir = scratch_dir / "vest" / zp.stem
    extracted = _extract_vest_zip(zp, extract_dir)
    shp = _find_preferred_shapefile(extracted)
    return gpd.read_file(shp)


def resolve_placeholder_duplicates(
    gdf: gpd.GeoDataFrame,
    precinct_field: str,
    log: Callable[[str], None] = print,
) -> gpd.GeoDataFrame:
    """Resolve zero-vote duplicate-precinct groups.

    Port of prepare-dev-data.ts::resolvePlaceholderDuplicates. Requires that
    `gdf` be in a projected CRS in meters (VEST is reprojected before this
    is called, matching TS behavior).
    """
    if len(gdf) == 0:
        return gdf

    county_field = detect_county_field(list(gdf.columns))

    # Group by (county, precinct). We can't safely pandas-groupby on geometry
    # so we build groups manually keeping the original index.
    groups: dict[tuple[str, str], list[int]] = {}
    for idx, row in gdf.iterrows():
        county = str(row[county_field]) if county_field else ""
        precinct = str(row[precinct_field]) if precinct_field in row else ""
        groups.setdefault((county, precinct), []).append(idx)

    kept_indices: list[int] = []
    kept_precinct_overrides: dict[int, str] = {}
    sliver_indices: list[int] = []
    split_stats: list[tuple[str, int, int]] = []
    vote_warnings: list[str] = []

    for (county, precinct), idxs in groups.items():
        if len(idxs) == 1:
            kept_indices.append(idxs[0])
            continue
        has_votes = any(_has_real_votes(gdf.loc[i].to_dict()) for i in idxs)
        if has_votes:
            kept_indices.extend(idxs)
            vote_warnings.append(
                f"{county}|{precinct} ({len(idxs)} feats; has real votes, kept all)"
            )
            continue

        # Zero-vote duplicate group → classify each member by area.
        big = 0
        sliver = 0
        for seq, i in enumerate(idxs, start=1):
            geom = gdf.loc[i, "geometry"]
            area = geom.area if geom is not None else 0.0
            if area < SLIVER_AREA_M2:
                sliver_indices.append(i)
                sliver += 1
            else:
                kept_indices.append(i)
                kept_precinct_overrides[i] = f"{precinct}-{seq}"
                big += 1
        split_stats.append((f"{county}|{precinct}", big, sliver))

    # Absorb slivers into nearest same-county kept neighbor by centroid distance.
    merge_targets: dict[int, list[Polygon]] = {}
    unmatched = 0
    if sliver_indices:
        kept_by_county: dict[str, list[int]] = {}
        for i in kept_indices:
            county = (
                str(gdf.loc[i, county_field])
                if county_field
                else ""
            )
            kept_by_county.setdefault(county, []).append(i)

        kept_centroids: dict[int, tuple[float, float]] = {}
        for i in kept_indices:
            g = gdf.loc[i, "geometry"]
            if g is not None and not g.is_empty:
                c = g.centroid
                kept_centroids[i] = (c.x, c.y)

        for sv_idx in sliver_indices:
            sv_geom = gdf.loc[sv_idx, "geometry"]
            if sv_geom is None or sv_geom.is_empty:
                unmatched += 1
                continue
            sv_c = sv_geom.centroid
            sv_xy = (sv_c.x, sv_c.y)
            county = (
                str(gdf.loc[sv_idx, county_field])
                if county_field
                else ""
            )
            candidates = kept_by_county.get(county) or kept_indices
            if not candidates:
                unmatched += 1
                continue
            best_i = None
            best_d2 = float("inf")
            for k in candidates:
                kc = kept_centroids.get(k)
                if kc is None:
                    continue
                dx = kc[0] - sv_xy[0]
                dy = kc[1] - sv_xy[1]
                d2 = dx * dx + dy * dy
                if d2 < best_d2:
                    best_d2 = d2
                    best_i = k
            if best_i is None:
                unmatched += 1
                continue
            g = gdf.loc[sv_idx, "geometry"]
            polys = merge_targets.setdefault(best_i, [])
            if isinstance(g, Polygon):
                polys.append(g)
            elif isinstance(g, MultiPolygon):
                polys.extend(g.geoms)

    # Rebuild output. Apply precinct-ID overrides and merged geometries.
    kept_rows: list[dict] = []
    for i in kept_indices:
        row = gdf.loc[i].to_dict()
        if i in kept_precinct_overrides:
            row[precinct_field] = kept_precinct_overrides[i]
        if i in merge_targets:
            # Union the original geometry with absorbed sliver polygons.
            parts: list[Polygon] = []
            g = row["geometry"]
            if isinstance(g, Polygon):
                parts.append(g)
            elif isinstance(g, MultiPolygon):
                parts.extend(g.geoms)
            parts.extend(merge_targets[i])
            merged = unary_union(parts)
            row["geometry"] = merged
        kept_rows.append(row)

    out = gpd.GeoDataFrame(kept_rows, columns=gdf.columns, crs=gdf.crs)

    if split_stats:
        log(
            f"   Resolved {len(split_stats)} zero-vote duplicate precinct groups "
            f"(county field={county_field}, sliver threshold={SLIVER_AREA_M2} m²):"
        )
        for key, big, sliver in split_stats:
            log(f"     {key}: {big} promoted to distinct precincts, {sliver} absorbed as slivers")
    if unmatched:
        log(f"   WARNING: {unmatched} sliver features had no nearest neighbor; dropped")
    if vote_warnings:
        log(f"   WARNING: {len(vote_warnings)} duplicate-ID groups have votes and were kept:")
        for w in vote_warnings[:10]:
            log(f"     {w}")
        if len(vote_warnings) > 10:
            log(f"     ... and {len(vote_warnings) - 10} more")

    return out
