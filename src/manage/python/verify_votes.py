"""Compare per-(office,party,year) vote totals between source VEST shapefiles
and the output GeoJSON produced by prepare-region-data.

Run inside the manage container:
    docker compose run --no-deps --rm manage \
        python -m verify_votes AL dev-data/staging/al_2020.zip:VTDST20:20 \
            dev-data/staging/al_2018.zip:VTDST18:18 \
            dev-data/staging/al_2016.zip:VTDST16:16 \
            dev-data/staging/al_2024_gen_prec.zip:UNIQUE_ID:24 \
            --output dev-data/output/AL/input.geojson
"""
import json
import re
import sys
import zipfile
from pathlib import Path

import click
import geopandas as gpd

from prepare_region_data.votes import extract_voting_data
from prepare_region_data.vest import SHAPEFILE_PREFERENCES


def find_shapefile(zip_path: Path, scratch: Path) -> Path:
    out = scratch / zip_path.stem
    out.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(zip_path) as zf:
        zf.extractall(out)
    shps = list(out.rglob("*.shp"))
    if not shps:
        raise RuntimeError(f"no shapefile in {zip_path}")
    for pref in SHAPEFILE_PREFERENCES:
        for s in shps:
            if pref in s.name:
                return s
    return sorted(shps)[0]


_VEST_COL_RE = re.compile(r"^[GPCRS](\d{2})([A-Z]{3})([DRLGIOCNSMPUAWBETH])")


def sum_vest(zip_path: Path, scratch: Path, year_yy: str) -> tuple[dict[str, int], str]:
    from prepare_region_data.votes import vote_field_name
    shp = find_shapefile(zip_path, scratch)
    gdf = gpd.read_file(shp)
    election_year = ""
    totals: dict[str, int] = {}
    for raw in gdf.columns:
        m = _VEST_COL_RE.match(raw)
        if not m:
            continue
        year = m.group(1)
        if year != year_yy:
            # Cross-year columns occasionally appear in VEST; skip non-target.
            continue
        if not election_year:
            election_year = year
        office = m.group(2)
        p_code = m.group(3)
        party = {"D": "democrat", "R": "republican"}.get(p_code, "other")
        name = vote_field_name(office, party, election_year)
        col_sum = int(
            gdf[raw]
            .apply(lambda v: 0 if v is None else (0 if isinstance(v, float) and v != v else int(v) if isinstance(v, (int, float)) else (int(str(v)) if str(v).strip().lstrip("-").isdigit() else 0)))
            .sum()
        )
        totals[name] = totals.get(name, 0) + col_sum
    return totals, election_year


def stream_features(path: Path):
    """Brace-balanced streaming parse of a GeoJSON FeatureCollection that
    was written as one giant single-line `{"type":"FeatureCollection","features":[F,F,...]}`."""
    buf = []
    depth = 0
    in_string = False
    escape = False
    started = False
    head = ""
    with open(path) as f:
        while True:
            chunk = f.read(1 << 20)
            if not chunk:
                return
            for ch in chunk:
                if not started:
                    head += ch
                    if ch == "[":
                        started = True
                        head = ""
                    continue
                if escape:
                    buf.append(ch)
                    escape = False
                    continue
                if ch == "\\":
                    buf.append(ch)
                    escape = True
                    continue
                if ch == '"':
                    in_string = not in_string
                    buf.append(ch)
                    continue
                if in_string:
                    buf.append(ch)
                    continue
                if ch == "{":
                    depth += 1
                    buf.append(ch)
                elif ch == "}":
                    depth -= 1
                    buf.append(ch)
                    if depth == 0:
                        yield json.loads("".join(buf))
                        buf = []
                elif ch == "," and depth == 0:
                    buf = []
                elif ch == "]" and depth == 0:
                    return
                else:
                    if depth > 0:
                        buf.append(ch)


_OUT_VOTE_COL_RE = re.compile(r"^([A-Z]+_)?(democrat|republican|other)\d{2}$")


def sum_output(geojson_path: Path) -> dict[str, int]:
    """Stream-parse GeoJSON, summing voting properties per feature."""
    totals: dict[str, int] = {}
    n = 0
    for feat in stream_features(geojson_path):
        props = feat.get("properties", {})
        for k, v in props.items():
            if _OUT_VOTE_COL_RE.match(k) and v is not None:
                totals[k] = totals.get(k, 0) + int(v)
        n += 1
        if n % 50000 == 0:
            click.echo(f"    ...{n} features parsed", err=True)
    click.echo(f"    total {n} features", err=True)
    return totals


def sum_output_per_precinct(
    geojson_path: Path, year_yy: str
) -> dict[str, dict[str, int]]:
    """Aggregate output votes per precinct, restricted to columns whose
    suffix matches `year_yy`. Returns {precinct_compound: {col: votes}}."""
    suffix = year_yy
    by_prec: dict[str, dict[str, int]] = {}
    n = 0
    for feat in stream_features(geojson_path):
        props = feat.get("properties", {})
        prec = props.get("precinct")
        if prec is None:
            continue
        bucket = by_prec.setdefault(prec, {})
        for k, v in props.items():
            if v is None or not k.endswith(suffix):
                continue
            if not _OUT_VOTE_COL_RE.match(k):
                continue
            bucket[k] = bucket.get(k, 0) + int(v)
        n += 1
        if n % 50000 == 0:
            click.echo(f"    ...{n} features parsed", err=True)
    click.echo(f"    total {n} features, {len(by_prec)} precincts", err=True)
    return by_prec


def sum_vest_per_precinct(
    zip_path: Path, scratch: Path, precinct_field: str, year_yy: str
) -> dict[str, dict[str, int]]:
    """Aggregate VEST votes per `{COUNTYFP20}-{precinct_field}` compound key,
    using the same compound-key construction as cli.py:514."""
    from prepare_region_data.votes import vote_field_name

    shp = find_shapefile(zip_path, scratch)
    gdf = gpd.read_file(shp)

    # Locate the county FIPS column; VEST files use COUNTYFP20 / COUNTYFP10 / COUNTYFP.
    county_col = None
    for cand in ("COUNTYFP20", "COUNTYFP10", "COUNTYFP"):
        if cand in gdf.columns:
            county_col = cand
            break
    if county_col is None:
        raise RuntimeError(
            f"no COUNTYFP* column in {zip_path.name}; columns: {list(gdf.columns)[:20]}"
        )
    if precinct_field not in gdf.columns:
        raise RuntimeError(
            f"precinct field {precinct_field!r} not in {zip_path.name}; "
            f"columns: {list(gdf.columns)[:20]}"
        )

    vote_cols: list[tuple[str, str]] = []  # (raw_col, output_col_name)
    for raw in gdf.columns:
        m = _VEST_COL_RE.match(raw)
        if not m or m.group(1) != year_yy:
            continue
        office = m.group(2)
        p_code = m.group(3)
        party = {"D": "democrat", "R": "republican"}.get(p_code, "other")
        vote_cols.append((raw, vote_field_name(office, party, year_yy)))

    by_prec: dict[str, dict[str, int]] = {}
    for _, row in gdf.iterrows():
        county = str(row[county_col]) if row[county_col] is not None else ""
        pid = str(row[precinct_field]) if row[precinct_field] is not None else ""
        compound = f"{county}-{pid}"
        bucket = by_prec.setdefault(compound, {})
        for raw, out_name in vote_cols:
            v = row[raw]
            if v is None:
                votes = 0
            elif isinstance(v, float) and v != v:
                votes = 0
            elif isinstance(v, (int, float)):
                votes = int(v)
            else:
                s = str(v).strip()
                votes = int(s) if s.lstrip("-").isdigit() else 0
            bucket[out_name] = bucket.get(out_name, 0) + votes
    return by_prec


def _run_state_totals(vest_specs, out_totals, scratch_dir):
    click.echo("Reading source VEST files...")
    vest_totals: dict[str, int] = {}
    for spec in vest_specs:
        path, _field, yy = spec.split(":")
        click.echo(f"  {path} (year=20{yy})...")
        totals, ey = sum_vest(Path(path), scratch_dir, yy)
        click.echo(f"    {len(totals)} columns, election_year={ey}")
        for k, v in totals.items():
            if k in vest_totals:
                click.echo(f"    WARNING: column {k} in multiple VEST files; first wins")
            else:
                vest_totals[k] = v

    click.echo("\n=== State-wide Comparison ===")
    all_cols = sorted(set(vest_totals) | set(out_totals))
    mismatches = 0
    for col in all_cols:
        v = vest_totals.get(col)
        o = out_totals.get(col)
        if v == o:
            mark = "OK"
        elif v is None:
            mark = "OUTPUT-ONLY"
            mismatches += 1
        elif o is None:
            mark = "VEST-ONLY"
            mismatches += 1
        else:
            diff = o - v
            pct = abs(diff) / v * 100 if v else float("inf")
            mark = f"DIFF={diff:+d} ({pct:.4f}%)"
            if diff != 0:
                mismatches += 1
        click.echo(f"  {col:36s} VEST={v}  OUT={o}  [{mark}]")
    click.echo(f"\nState-wide: {len(all_cols)} columns, {mismatches} mismatches")
    return mismatches


def _run_per_precinct(vest_specs, output_path: Path, year_yy: str, scratch_dir):
    spec = next((s for s in vest_specs if s.split(":")[2] == year_yy), None)
    if spec is None:
        raise click.UsageError(f"--per-precinct {year_yy}: no VEST spec for that year")
    path, field, yy = spec.split(":")

    click.echo(f"Per-precinct comparison for year 20{yy}")
    click.echo(f"  VEST: {path} (field={field})")
    vest_pp = sum_vest_per_precinct(Path(path), scratch_dir, field, yy)
    click.echo(f"  VEST has {len(vest_pp)} unique precinct compounds")

    click.echo(f"  Aggregating output by precinct...")
    out_pp = sum_output_per_precinct(output_path, yy)
    click.echo(f"  Output has {len(out_pp)} unique precinct compounds")

    only_vest = sorted(set(vest_pp) - set(out_pp))
    only_out = sorted(set(out_pp) - set(vest_pp))
    common = sorted(set(vest_pp) & set(out_pp))

    click.echo(f"\n  Common: {len(common)}, VEST-only: {len(only_vest)}, OUT-only: {len(only_out)}")

    cell_mismatches: list[tuple[str, str, int, int]] = []
    perfect_precincts = 0
    for prec in common:
        v_cols = vest_pp[prec]
        o_cols = out_pp[prec]
        all_cols = set(v_cols) | set(o_cols)
        ok = True
        for c in all_cols:
            v = v_cols.get(c, 0)
            o = o_cols.get(c, 0)
            if v != o:
                cell_mismatches.append((prec, c, v, o))
                ok = False
        if ok:
            perfect_precincts += 1

    click.echo(f"  Perfect precincts (all cols match): {perfect_precincts}/{len(common)}")
    click.echo(f"  Cell mismatches: {len(cell_mismatches)}")

    if only_vest:
        click.echo(f"\n  VEST-only precincts (no output rows assigned):")
        for p in only_vest[:20]:
            v_total = sum(vest_pp[p].values())
            click.echo(f"    {p:40s}  votes_in_vest={v_total}")
        if len(only_vest) > 20:
            click.echo(f"    ... ({len(only_vest) - 20} more)")

    if only_out:
        click.echo(f"\n  OUT-only precincts (assigned blocks but no VEST row with this compound):")
        for p in only_out[:20]:
            o_total = sum(out_pp[p].values())
            click.echo(f"    {p:40s}  votes_in_output={o_total}")
        if len(only_out) > 20:
            click.echo(f"    ... ({len(only_out) - 20} more)")

    if cell_mismatches:
        click.echo(f"\n  Top cell mismatches by abs diff:")
        for prec, col, v, o in sorted(
            cell_mismatches, key=lambda t: -abs(t[3] - t[2])
        )[:15]:
            click.echo(f"    {prec:40s} {col:24s} VEST={v}  OUT={o}  DIFF={o - v:+d}")

    return len(cell_mismatches) + len(only_vest) + len(only_out)


@click.command()
@click.argument("state")
@click.argument("vest_specs", nargs=-1)
@click.option("--output", "output_path", required=True, type=click.Path(exists=True))
@click.option("--scratch", default="dev-data/staging/.cache/verify-scratch", type=click.Path())
@click.option("--per-precinct", "per_precinct_yy", default=None, help="Year YY (e.g. 20) to also do per-precinct comparison")
@click.option("--skip-state-totals", is_flag=True, default=False)
def main(state, vest_specs, output_path, scratch, per_precinct_yy, skip_state_totals):
    """vest_specs: list of `path:precinctField:yearYY` like al_2020.zip:VTDST20:20"""
    scratch_dir = Path(scratch)
    scratch_dir.mkdir(parents=True, exist_ok=True)

    out_totals = None
    if not skip_state_totals:
        click.echo(f"Reading {output_path}...")
        out_totals = sum_output(Path(output_path))
        click.echo(f"  Found {len(out_totals)} voting columns in output")

    state_mm = 0
    if not skip_state_totals:
        state_mm = _run_state_totals(vest_specs, out_totals, scratch_dir)

    pp_mm = 0
    if per_precinct_yy:
        pp_mm = _run_per_precinct(vest_specs, Path(output_path), per_precinct_yy, scratch_dir)

    click.echo(f"\n=== Summary ===  state-wide mismatches: {state_mm}, per-precinct issues: {pp_mm}")
    sys.exit(1 if (state_mm + pp_mm) else 0)


if __name__ == "__main__":
    main()
