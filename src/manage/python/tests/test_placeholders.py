# SPDX-License-Identifier: AGPL-3.0-or-later
# © 2026 Michael Maurizi Jr.

import io
import zipfile
from pathlib import Path

import geopandas as gpd
import pytest
from shapely.geometry import Polygon

from prepare_region_data.vest import (
    SLIVER_AREA_M2,
    load_vest_precincts,
    resolve_placeholder_duplicates,
)


# 1 m = 1e-5 degrees at the equator, so 1000 m² ≈ 1e-4 deg × 1e-4 deg at
# small scales. We work in a projected CRS (fake EPSG:3857) with coords in
# meters for these tests so SLIVER_AREA_M2 is meaningful without lat
# correction.
PROJECTED_CRS = "EPSG:3857"


def _square(x: float, y: float, size: float) -> Polygon:
    return Polygon([(x, y), (x + size, y), (x + size, y + size), (x, y + size), (x, y)])


def test_single_member_groups_pass_through():
    gdf = gpd.GeoDataFrame(
        {
            "COUNTYFP": ["001", "001"],
            "PRECINCT": ["A", "B"],
            "G20PREDBID": [10, 20],
        },
        geometry=[_square(0, 0, 100), _square(200, 0, 100)],
        crs=PROJECTED_CRS,
    )
    out = resolve_placeholder_duplicates(gdf, "PRECINCT", log=lambda s: None)
    assert len(out) == 2
    assert set(out["PRECINCT"]) == {"A", "B"}


def test_dup_group_with_votes_is_kept_intact():
    gdf = gpd.GeoDataFrame(
        {
            "COUNTYFP": ["001", "001"],
            "PRECINCT": ["X", "X"],
            "G20PREDBID": [5, 7],  # both have votes
        },
        geometry=[_square(0, 0, 100), _square(200, 0, 100)],
        crs=PROJECTED_CRS,
    )
    out = resolve_placeholder_duplicates(gdf, "PRECINCT", log=lambda s: None)
    assert len(out) == 2
    assert all(p == "X" for p in out["PRECINCT"])


def test_zero_vote_dup_big_pieces_promoted_with_suffix():
    # Two pieces of precinct "0000", both big enough (size=100 → area=10,000 m²).
    gdf = gpd.GeoDataFrame(
        {
            "COUNTYFP": ["001", "001"],
            "PRECINCT": ["0000", "0000"],
            "G20PREDBID": [0, 0],
        },
        geometry=[_square(0, 0, 100), _square(500, 0, 100)],
        crs=PROJECTED_CRS,
    )
    out = resolve_placeholder_duplicates(gdf, "PRECINCT", log=lambda s: None)
    assert len(out) == 2
    assert set(out["PRECINCT"]) == {"0000-1", "0000-2"}


def test_zero_vote_dup_slivers_absorbed_into_nearest_neighbor():
    # Real precinct "A" (big, real votes), and two zero-vote fragments of
    # placeholder precinct "0000": one tiny sliver (area = 25 m², below
    # SLIVER_AREA_M2) and one big enough to be promoted.
    sliver_size = 5.0  # 25 m²
    big_size = 100.0  # 10000 m²
    assert sliver_size**2 < SLIVER_AREA_M2 <= big_size**2

    gdf = gpd.GeoDataFrame(
        {
            "COUNTYFP": ["001", "001", "001"],
            "PRECINCT": ["A", "0000", "0000"],
            "G20PREDBID": [100, 0, 0],
        },
        geometry=[
            _square(0, 0, 100),           # A, real precinct
            _square(102, 0, sliver_size), # 0000 sliver (next to A)
            _square(500, 0, big_size),    # 0000 big
        ],
        crs=PROJECTED_CRS,
    )
    out = resolve_placeholder_duplicates(gdf, "PRECINCT", log=lambda s: None)
    # Sliver absorbed into A (same county, closest centroid), big promoted.
    assert len(out) == 2
    precincts = set(out["PRECINCT"])
    assert "A" in precincts
    assert any(p.startswith("0000-") for p in precincts)
    # A's geometry should now include the sliver (area increased).
    a_row = out[out["PRECINCT"] == "A"].iloc[0]
    assert a_row.geometry.area > 100 * 100  # original A was exactly 10,000 m²


def _write_zip_with_shapefile(zip_path: Path, gdf: gpd.GeoDataFrame, stem: str) -> None:
    """Write a GeoDataFrame to a temp shapefile and zip it under `stem`."""
    work = zip_path.parent / f"_w_{stem}"
    work.mkdir(exist_ok=True)
    shp = work / f"{stem}.shp"
    gdf.to_file(shp)
    with zipfile.ZipFile(zip_path, "w") as zf:
        for ext in (".shp", ".dbf", ".prj", ".shx", ".cpg"):
            p = work / f"{stem}{ext}"
            if p.exists():
                zf.write(p, p.name)


def test_load_vest_precincts_isolates_zip_extractions(tmp_path: Path):
    """Regression: two VEST zips processed through the same scratch_dir
    must not bleed into each other when neither matches a preference. The
    earlier bug was that both extracted into scratch_dir/vest/ and rglob
    returned both shapefiles; the second load picked up the first zip's
    .shp by alphabetical fallback."""
    scratch = tmp_path / "scratch"
    zip_a = tmp_path / "al_2016.zip"
    zip_b = tmp_path / "al_2018.zip"

    a_gdf = gpd.GeoDataFrame(
        {"YEAR_TAG": ["sixteen"], "G16PREDBID": [100]},
        geometry=[Polygon([(0, 0), (1, 0), (1, 1), (0, 1)])],
        crs="EPSG:4326",
    )
    b_gdf = gpd.GeoDataFrame(
        {"YEAR_TAG": ["eighteen"], "G18GOVDFOO": [200]},
        geometry=[Polygon([(0, 0), (1, 0), (1, 1), (0, 1)])],
        crs="EPSG:4326",
    )
    _write_zip_with_shapefile(zip_a, a_gdf, "al_2016")
    _write_zip_with_shapefile(zip_b, b_gdf, "al_2018")

    out_a = load_vest_precincts(str(zip_a), scratch)
    out_b = load_vest_precincts(str(zip_b), scratch)

    assert list(out_a["YEAR_TAG"]) == ["sixteen"]
    assert list(out_b["YEAR_TAG"]) == ["eighteen"]
    assert "G16PREDBID" in out_a.columns and "G16PREDBID" not in out_b.columns
    assert "G18GOVDFOO" in out_b.columns and "G18GOVDFOO" not in out_a.columns


def test_no_county_field_falls_back_to_global_neighbor():
    # No COUNTYFP-like field means all kept features are candidates.
    gdf = gpd.GeoDataFrame(
        {"PRECINCT": ["A", "0000", "0000"], "G20PREDBID": [1, 0, 0]},
        geometry=[
            _square(0, 0, 100),
            _square(2, 0, 2),       # sliver: 4 m²
            _square(500, 0, 100),   # big
        ],
        crs=PROJECTED_CRS,
    )
    out = resolve_placeholder_duplicates(gdf, "PRECINCT", log=lambda s: None)
    assert len(out) == 2
