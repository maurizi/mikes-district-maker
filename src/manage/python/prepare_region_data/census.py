# SPDX-License-Identifier: AGPL-3.0-or-later
# © 2026 Michael Maurizi Jr.

# Census data loading: TIGER blocks, Decennial PL demographics, ACS CVAP.
#
# Cache layout matches the TS pipeline (src/manage/src/commands/prepare-dev-data.ts
# steps 1a/1b/1c) so the two pipelines can share a --censusCache prefix:
#
#   {cacheBase}.features.geojsonseq   # block geometries, one feature per line (WGS84)
#   {cacheBase}.demographics.json     # { GEOID: { population, VAP_MOD, ... } }
#   {cacheBase}.counties.json         # { countyFIPS: "County Name" }
#
# We also cache the raw TIGER zip download in {cacheBase}.tiger.zip when the
# TS cache is missing, so re-runs skip the Census FTP hit.

from __future__ import annotations

import io
import json
import os
import zipfile
from pathlib import Path
from typing import TypedDict

import geopandas as gpd
import pandas as pd
import requests


TIGER_URL = (
    "https://www2.census.gov/geo/tiger/TIGER2020/TABBLOCK20/"
    "tl_2020_{fips}_tabblock20.zip"
)

# Decennial PL 2020 variables for block-level demographics.
#   P1_001N = total pop
#   P1_003N/004N/006N = White / Black / Asian (non-Hispanic alone)
#   P2_002N = Hispanic
#   P3_001N/003N/004N/006N = VAP total / White / Black / Asian
#   P4_002N = VAP Hispanic
#   P5_003N = adult prison population (for VAP_MOD = VAP - prison)
_PL_VARS = [
    "P1_001N", "P1_003N", "P1_004N", "P1_006N", "P2_002N",
    "P3_001N", "P3_003N", "P3_004N", "P3_006N", "P4_002N",
    "P5_003N",
]
_PL_URL = (
    "https://api.census.gov/data/2020/dec/pl?get={vars}&for=block:*"
    "&in=state:{fips}&in=county:*&in=tract:*"
)
_COUNTY_NAMES_URL = (
    "https://api.census.gov/data/2020/dec/pl?get=NAME&for=county:*&in=state:{fips}"
)

# ACS B05003 race iterations (CVAP). Published at tract level only; block-group
# returns nulls. Distributed to blocks proportionally by VAP.
_CVAP_TABLES = [
    ("B05003",  "cvapTotal"),
    ("B05003H", "cvapWhite"),    # White non-Hispanic
    ("B05003B", "cvapBlack"),
    ("B05003D", "cvapAsian"),
    ("B05003I", "cvapHispanic"),
]
_ACS_URL = (
    "https://api.census.gov/data/2022/acs/acs5?get={vars}&for=tract:*"
    "&in=state:{fips}&in=county:*"
)


class Demographics(TypedDict, total=False):
    population: int
    white: int
    black: int
    asian: int
    hispanic: int
    other: int
    VAP: int
    VAP_White: int
    VAP_Black: int
    VAP_Asian: int
    VAP_Hispanic: int
    VAP_Other: int
    VAP_MOD: int
    CVAP: int
    CVAP_White: int
    CVAP_Black: int
    CVAP_Asian: int
    CVAP_Hispanic: int
    CVAP_Other: int


# Mapping between TS JSON keys (with spaces) and the pandas-safe column names
# used internally. Applied when reading/writing the cache so both pipelines
# produce the same on-disk shape.
_KEY_TO_COL = {
    "population": "population",
    "white": "white",
    "black": "black",
    "asian": "asian",
    "hispanic": "hispanic",
    "other": "other",
    "VAP": "VAP",
    "VAP White": "VAP White",
    "VAP Black": "VAP Black",
    "VAP Asian": "VAP Asian",
    "VAP Hispanic": "VAP Hispanic",
    "VAP Other": "VAP Other",
    "VAP_MOD": "VAP_MOD",
    "CVAP": "CVAP",
    "CVAP White": "CVAP White",
    "CVAP Black": "CVAP Black",
    "CVAP Asian": "CVAP Asian",
    "CVAP Hispanic": "CVAP Hispanic",
    "CVAP Other": "CVAP Other",
}


def _cache_paths(cache_base: str | None) -> dict[str, Path] | None:
    if not cache_base:
        return None
    base = Path(cache_base)
    if base.suffix == ".geojson":
        base = base.with_suffix("")
    return {
        "features": base.parent / f"{base.name}.features.geojsonseq",
        "demographics": base.parent / f"{base.name}.demographics.json",
        "counties": base.parent / f"{base.name}.counties.json",
        "tiger": base.parent / f"{base.name}.tiger.zip",
    }


def _fetch_tiger(state_fips: str, cache_zip: Path | None) -> bytes:
    if cache_zip is not None and cache_zip.exists():
        return cache_zip.read_bytes()
    url = TIGER_URL.format(fips=state_fips)
    resp = requests.get(url, timeout=300)
    resp.raise_for_status()
    data = resp.content
    if cache_zip is not None:
        cache_zip.parent.mkdir(parents=True, exist_ok=True)
        cache_zip.write_bytes(data)
    return data


def _read_tiger_blocks(zip_bytes: bytes, scratch_dir: Path) -> gpd.GeoDataFrame:
    scratch_dir.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
        zf.extractall(scratch_dir)
    # Find the .shp file (TIGER archives contain one).
    shp = next(scratch_dir.rglob("*.shp"))
    gdf = gpd.read_file(shp)
    # TIGER ships in NAD83; reproject to WGS84 for the on-disk cache shape
    # to match what the TS pipeline writes.
    if gdf.crs is not None and gdf.crs.to_epsg() != 4326:
        gdf = gdf.to_crs("EPSG:4326")
    return gdf


def _fetch_pl_demographics(state_fips: str) -> pd.DataFrame:
    url = _PL_URL.format(vars=",".join(_PL_VARS), fips=state_fips)
    resp = requests.get(url, timeout=300)
    resp.raise_for_status()
    rows = resp.json()
    header, *records = rows
    df = pd.DataFrame(records, columns=header)
    for v in _PL_VARS:
        df[v] = pd.to_numeric(df[v], errors="coerce").fillna(0).astype(int)
    df["GEOID"] = df["state"] + df["county"] + df["tract"] + df["block"]

    pop = df["P1_001N"]
    white = df["P1_003N"]
    black = df["P1_004N"]
    asian = df["P1_006N"]
    hispanic = df["P2_002N"]
    vap = df["P3_001N"]
    vap_white = df["P3_003N"]
    vap_black = df["P3_004N"]
    vap_asian = df["P3_006N"]
    vap_hispanic = df["P4_002N"]
    prison = df["P5_003N"]

    demo = pd.DataFrame({
        "GEOID": df["GEOID"],
        "population": pop,
        "white": white,
        "black": black,
        "asian": asian,
        "hispanic": hispanic,
        "other": (pop - white - black - asian - hispanic).clip(lower=0),
        "VAP": vap,
        "VAP White": vap_white,
        "VAP Black": vap_black,
        "VAP Asian": vap_asian,
        "VAP Hispanic": vap_hispanic,
        "VAP Other": (
            vap - vap_white - vap_black - vap_asian - vap_hispanic
        ).clip(lower=0),
        "VAP_MOD": (vap - prison).clip(lower=0),
    })
    return demo


def _fetch_county_names(state_fips: str) -> dict[str, str]:
    resp = requests.get(_COUNTY_NAMES_URL.format(fips=state_fips), timeout=60)
    resp.raise_for_status()
    rows = resp.json()
    out: dict[str, str] = {}
    for row in rows[1:]:
        name, st, county_fp = row[0], row[1], row[2]
        out[county_fp] = name.split(",")[0].strip()
    return out


def _fetch_cvap(state_fips: str) -> pd.DataFrame:
    # Each B05003 table gets four variables (_009E + _011E + _020E + _022E
    # = 18+ Native + Naturalized, Male + Female = total CVAP for that race).
    cvap_vars: list[str] = []
    for prefix, _ in _CVAP_TABLES:
        for suffix in ("_009E", "_011E", "_020E", "_022E"):
            cvap_vars.append(f"{prefix}{suffix}")
    url = _ACS_URL.format(vars=",".join(cvap_vars), fips=state_fips)
    resp = requests.get(url, timeout=300)
    resp.raise_for_status()
    rows = resp.json()
    header, *records = rows
    df = pd.DataFrame(records, columns=header)
    for v in cvap_vars:
        df[v] = pd.to_numeric(df[v], errors="coerce").fillna(0).astype(int)
    df["tractId"] = df["state"] + df["county"] + df["tract"]

    out = pd.DataFrame({"tractId": df["tractId"]})
    for prefix, key in _CVAP_TABLES:
        out[key] = (
            df[f"{prefix}_009E"]
            + df[f"{prefix}_011E"]
            + df[f"{prefix}_020E"]
            + df[f"{prefix}_022E"]
        )
    out["cvapOther"] = (
        out["cvapTotal"]
        - out["cvapWhite"]
        - out["cvapBlack"]
        - out["cvapAsian"]
        - out["cvapHispanic"]
    ).clip(lower=0)
    return out


def _distribute_cvap(demo: pd.DataFrame, cvap: pd.DataFrame) -> pd.DataFrame:
    """Distribute tract-level CVAP to blocks proportionally by VAP share.
    Mirrors prepare-dev-data.ts step 1c."""
    demo = demo.copy()
    demo["tractId"] = demo["GEOID"].str[:11]
    tract_vap = demo.groupby("tractId")["VAP"].sum().rename("tractVap")
    demo = demo.join(tract_vap, on="tractId")
    demo = demo.merge(cvap, on="tractId", how="left")

    ratio = (demo["VAP"] / demo["tractVap"]).where(demo["tractVap"] > 0, 0)
    for src, dst in [
        ("cvapTotal", "CVAP"),
        ("cvapWhite", "CVAP White"),
        ("cvapBlack", "CVAP Black"),
        ("cvapAsian", "CVAP Asian"),
        ("cvapHispanic", "CVAP Hispanic"),
        ("cvapOther", "CVAP Other"),
    ]:
        demo[dst] = (demo[src].fillna(0) * ratio).round().astype(int)
    demo = demo.drop(
        columns=[
            "tractId", "tractVap",
            "cvapTotal", "cvapWhite", "cvapBlack", "cvapAsian",
            "cvapHispanic", "cvapOther",
        ]
    )
    return demo


def _write_ts_compat_cache(
    paths: dict[str, Path],
    blocks: gpd.GeoDataFrame,
    demo: pd.DataFrame,
    counties: dict[str, str],
) -> None:
    """Write the cache in the same shape the TS pipeline writes, so the two
    pipelines can share a --censusCache prefix."""
    paths["features"].parent.mkdir(parents=True, exist_ok=True)

    # Demographics: { GEOID: { field: value } }
    demo_map: dict[str, dict[str, int]] = {}
    demo_fields = [c for c in demo.columns if c != "GEOID"]
    for row in demo.itertuples(index=False):
        rec = row._asdict()
        demo_map[rec["GEOID"]] = {f: int(rec[f]) for f in demo_fields}
    paths["demographics"].write_text(json.dumps(demo_map))

    paths["counties"].write_text(json.dumps(counties))

    # Features as geojsonseq (one JSON per line) — string-length friendly.
    with paths["features"].open("w") as fh:
        for _, row in blocks.iterrows():
            feat = {
                "type": "Feature",
                "properties": {
                    k: (None if pd.isna(v) else v)
                    for k, v in row.drop("geometry").items()
                },
                "geometry": row.geometry.__geo_interface__ if row.geometry else None,
            }
            fh.write(json.dumps(feat) + "\n")


def _read_ts_compat_cache(
    paths: dict[str, Path],
) -> tuple[gpd.GeoDataFrame, pd.DataFrame, dict[str, str]] | None:
    if not (paths["features"].exists() and paths["demographics"].exists()):
        return None

    # Features: geojsonseq. Line-by-line read to avoid loading the whole file
    # as a single string (TIGER states like CA overflow V8 but also strain
    # Python's JSON decoder if we try to build one big array).
    features: list[dict] = []
    with paths["features"].open("r") as fh:
        for line in fh:
            line = line.strip()
            if line:
                features.append(json.loads(line))
    blocks = gpd.GeoDataFrame.from_features(features, crs="EPSG:4326")

    demo_map: dict[str, dict[str, int]] = json.loads(paths["demographics"].read_text())
    demo = (
        pd.DataFrame.from_dict(demo_map, orient="index")
        .reset_index()
        .rename(columns={"index": "GEOID"})
    )
    demo = demo.fillna(0).convert_dtypes()
    # Cast numeric columns to native int for downstream math.
    for c in demo.columns:
        if c != "GEOID":
            demo[c] = pd.to_numeric(demo[c], errors="coerce").fillna(0).astype(int)

    counties = (
        json.loads(paths["counties"].read_text())
        if paths["counties"].exists()
        else {}
    )
    return blocks, demo, counties


def load_blocks_and_demographics(
    state_fips: str,
    cache_base: str | None,
    scratch_dir: Path,
    log=print,
) -> tuple[gpd.GeoDataFrame, pd.DataFrame, dict[str, str]]:
    """Return (blocks, demographics, county_names).

    - blocks: GeoDataFrame in EPSG:4326 with property GEOID20 (TIGER)
    - demographics: DataFrame keyed by GEOID with all demographic columns
    - county_names: { countyFIPS: "County Name" }
    """
    state_fips = state_fips.zfill(2)
    paths = _cache_paths(cache_base)

    if paths is not None:
        cached = _read_ts_compat_cache(paths)
        if cached is not None:
            blocks, demo, counties = cached
            log(
                f"1. Loaded {len(blocks)} blocks and "
                f"{len(demo)} demographic rows from cache"
            )
            return blocks, demo, counties

    log("1a. Downloading Census 2020 TIGER block shapefile...")
    tiger_zip_cache = paths["tiger"] if paths else None
    zip_bytes = _fetch_tiger(state_fips, tiger_zip_cache)
    log(f"   Downloaded {len(zip_bytes) / 1024 / 1024:.1f} MB")
    blocks = _read_tiger_blocks(zip_bytes, scratch_dir / "tiger")
    log(f"   {len(blocks)} blocks loaded")

    log("1b. Fetching Decennial PL demographics...")
    demo = _fetch_pl_demographics(state_fips)
    log(f"   {len(demo)} block demographics loaded")

    log("   Fetching county names...")
    counties = _fetch_county_names(state_fips)
    log(f"   {len(counties)} county names loaded")

    log("1c. Fetching ACS 5-year CVAP and distributing to blocks by VAP...")
    cvap = _fetch_cvap(state_fips)
    demo = _distribute_cvap(demo, cvap)
    log(f"   CVAP distributed to {len(demo)} blocks")

    if paths is not None:
        log(f"   Writing cache to {paths['features'].parent}...")
        _write_ts_compat_cache(paths, blocks, demo, counties)

    return blocks, demo, counties


def apply_adjusted_pl(
    demo: pd.DataFrame, adj_dir: str | None, state_abbr: str, log=print,
) -> pd.DataFrame:
    """Merge {adj_dir}/{STATE}.csv into demographics. Any column other than
    GEOID in the CSV overrides the matching column in demo, or adds it as a
    new adj_* column."""
    if not adj_dir:
        return demo
    csv_path = Path(adj_dir) / f"{state_abbr.upper()}.csv"
    if not csv_path.exists():
        log(f"   No adjusted-PL file at {csv_path}; skipping")
        return demo
    log(f"   Loading adjusted-PL from {csv_path}...")
    adj = pd.read_csv(csv_path, dtype={"GEOID": str})
    matched = demo["GEOID"].isin(adj["GEOID"]).sum()
    log(f"   {matched} blocks matched, {len(adj) - matched} unmatched")

    demo = demo.merge(adj, on="GEOID", how="left", suffixes=("", "__adj"))
    for col in adj.columns:
        if col == "GEOID":
            continue
        override_col = f"{col}__adj"
        if override_col in demo.columns:
            # Round+fallback mirrors the TS logic: `Math.round(parseFloat(cols[c]) || 0)`
            demo[col] = (
                demo[override_col].fillna(demo[col]).round().astype(int)
            )
            demo = demo.drop(columns=[override_col])
    return demo
