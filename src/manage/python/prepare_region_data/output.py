# SPDX-License-Identifier: AGPL-3.0-or-later
# © 2026 Michael Maurizi Jr.

# Streaming GeoJSON writer. Emits one feature per TIGER block in WGS84 with
# the property schema process-geojson expects (see
# prepare-dev-data.ts:2274-2541 for the reference layout).
#
# We stream rather than load a full FeatureCollection because large states
# (CA) can produce hundreds of MB of GeoJSON.

from __future__ import annotations

import json
from pathlib import Path
from typing import Iterable

import geopandas as gpd
import pandas as pd
from shapely.geometry.base import BaseGeometry


def _to_native(v):
    """Convert numpy/pandas scalars to JSON-safe Python natives."""
    if v is None:
        return None
    if isinstance(v, float) and pd.isna(v):
        return None
    if hasattr(v, "item"):  # numpy scalars
        return v.item()
    return v


def write_geojson(
    gdf: gpd.GeoDataFrame,
    property_columns: Iterable[str],
    output_path: str | Path,
    log=print,
) -> None:
    """Write one Feature per row of `gdf` to `output_path` as a GeoJSON
    FeatureCollection. `property_columns` lists the columns to include as
    properties (in the order given)."""
    output_path = Path(output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    if gdf.crs is None or gdf.crs.to_epsg() != 4326:
        log(f"   Reprojecting output to EPSG:4326 (was {gdf.crs})")
        gdf = gdf.to_crs("EPSG:4326")

    property_columns = list(property_columns)
    log(f"   Writing {len(gdf)} features to {output_path}")

    with output_path.open("w") as fh:
        fh.write('{"type":"FeatureCollection","features":[')
        first = True
        for _, row in gdf.iterrows():
            geom: BaseGeometry | None = row.geometry
            if geom is None or geom.is_empty:
                continue
            props = {c: _to_native(row[c]) for c in property_columns if c in row.index}
            feat = {
                "type": "Feature",
                "properties": props,
                "geometry": geom.__geo_interface__,
            }
            if first:
                first = False
            else:
                fh.write(",")
            fh.write(json.dumps(feat, separators=(",", ":")))
        fh.write("]}\n")

    log(f"   Done: {output_path}")
