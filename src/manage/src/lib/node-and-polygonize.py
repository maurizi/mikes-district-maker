#!/usr/bin/env python3
"""
Node+polygonize block/precinct boundaries and assign faces to blocks/precincts.
Uses native GEOS via shapely (no WASM memory limit).

Two-pass approach to keep peak memory low:
  Pass 1: Read polygons → extract boundaries → unary_union → polygonize → write faces
  Pass 2: Re-read polygons → build STRtree → assign faces to blocks/precincts

Usage: python3 node-and-polygonize.py <blocks.ndjson> <precincts.ndjson> <output.ndjson>
       [--simplify-precincts TOLERANCE]
"""
import json
import sys
import time
import gc
from shapely import unary_union, get_parts, STRtree
from shapely.ops import polygonize
from shapely.geometry import shape, mapping
from shapely.validation import make_valid


def read_geoms(path, simplify_tolerance=0):
    """Read geometries from ndjson, optionally simplify."""
    geoms = []
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line:
                geoms.append(None)
                continue
            try:
                geom = shape(json.loads(line))
                if not geom.is_valid:
                    geom = make_valid(geom)
                if simplify_tolerance > 0:
                    geom = make_valid(geom.simplify(simplify_tolerance, preserve_topology=True))
                geoms.append(geom)
            except Exception:
                geoms.append(None)
    return geoms


def main():
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument('blocks', help='Block polygons ndjson')
    parser.add_argument('precincts', help='Precinct polygons ndjson')
    parser.add_argument('output', help='Output faces ndjson')
    parser.add_argument('--simplify-precincts', type=float, default=0,
                        help='Simplify precinct geometry with this tolerance (degrees) before noding')
    args = parser.parse_args()

    t0 = time.time()

    # ── Pass 1: Noding + Polygonize ──
    # Read only boundaries (not full polygons) to minimize memory during unary_union

    print("  Pass 1: Extracting boundaries...", file=sys.stderr)
    boundaries = []
    n_blocks = 0
    with open(args.blocks) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                geom = shape(json.loads(line))
                if not geom.is_valid:
                    geom = make_valid(geom)
                boundaries.append(geom.boundary)
                n_blocks += 1
            except Exception:
                pass
    print(f"  {n_blocks} block boundaries extracted", file=sys.stderr)

    simplify_tolerance = args.simplify_precincts
    n_precincts = 0
    with open(args.precincts) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                geom = shape(json.loads(line))
                if not geom.is_valid:
                    geom = make_valid(geom)
                if simplify_tolerance > 0:
                    geom = make_valid(geom.simplify(simplify_tolerance, preserve_topology=True))
                boundaries.append(geom.boundary)
                n_precincts += 1
            except Exception:
                pass
    print(f"  {n_precincts} precinct boundaries extracted ({len(boundaries)} total)", file=sys.stderr)
    if simplify_tolerance > 0:
        print(f"  (precincts simplified with tolerance={simplify_tolerance})", file=sys.stderr)

    t1 = time.time()
    print(f"  Noding (unary_union)...", file=sys.stderr)
    noded = unary_union(boundaries)
    del boundaries
    gc.collect()
    print(f"  Unary union complete in {time.time()-t1:.1f}s", file=sys.stderr)

    t2 = time.time()
    noded_lines = list(get_parts(noded))
    print(f"  Extracted {len(noded_lines)} linestrings for polygonize", file=sys.stderr)
    del noded
    gc.collect()
    faces = list(polygonize(noded_lines))
    del noded_lines
    gc.collect()
    print(f"  Polygonize: {len(faces)} faces in {time.time()-t2:.1f}s", file=sys.stderr)

    # Compute representative points for all faces (needed for assignment)
    t3 = time.time()
    face_rps = []
    face_areas = []
    for face in faces:
        face_areas.append(face.area)
        face_rps.append(face.representative_point())
    print(f"  Computed {len(face_rps)} representative points in {time.time()-t3:.1f}s", file=sys.stderr)

    # Free face geometries temporarily — write to temp file, re-read during output
    # Keep only the representative points and areas for assignment
    import tempfile, os
    face_tmp = tempfile.NamedTemporaryFile(mode='w', suffix='.ndjson', delete=False)
    for face in faces:
        face_tmp.write(json.dumps(mapping(face)) + '\n')
    face_tmp.close()
    face_tmp_path = face_tmp.name
    del faces
    gc.collect()
    print(f"  Pass 1 complete, peak memory freed in {time.time()-t0:.1f}s", file=sys.stderr)

    # ── Pass 2: Assignment ──
    print("  Pass 2: Assigning faces to blocks/precincts...", file=sys.stderr)

    t4 = time.time()
    block_geoms = read_geoms(args.blocks)
    print(f"  Re-read {sum(1 for g in block_geoms if g is not None)} blocks in {time.time()-t4:.1f}s", file=sys.stderr)

    t5 = time.time()
    precinct_geoms = read_geoms(args.precincts, simplify_tolerance)
    print(f"  Re-read {sum(1 for g in precinct_geoms if g is not None)} precincts in {time.time()-t5:.1f}s", file=sys.stderr)

    # Build spatial indices
    t6 = time.time()
    valid_block_indices = [i for i, g in enumerate(block_geoms) if g is not None]
    valid_block_geoms = [block_geoms[i] for i in valid_block_indices]
    block_tree = STRtree(valid_block_geoms)

    valid_precinct_indices = [i for i, g in enumerate(precinct_geoms) if g is not None]
    valid_precinct_geoms = [precinct_geoms[i] for i in valid_precinct_indices]
    precinct_tree = STRtree(valid_precinct_geoms)
    del block_geoms, precinct_geoms
    gc.collect()
    print(f"  Built spatial indices in {time.time()-t6:.1f}s", file=sys.stderr)

    # Assign faces and write output
    t7 = time.time()
    assigned = 0
    no_block = 0
    no_precinct = 0

    face_geom_file = open(face_tmp_path)
    with open(args.output, 'w') as out:
        for fi in range(len(face_rps)):
            if fi % 200000 == 0 and fi > 0:
                print(f"  Assigning faces: {fi}/{len(face_rps)}", file=sys.stderr)

            area = face_areas[fi]
            face_geom_json = face_geom_file.readline().strip()

            if area <= 0:
                continue

            rp = face_rps[fi]

            # Find containing block
            block_idx = None
            block_hits = block_tree.query(rp, predicate='contains')
            if len(block_hits) > 0:
                block_idx = valid_block_indices[block_hits[0]]
            else:
                block_hits = block_tree.query(rp.buffer(0.001), predicate='intersects')
                for hit in block_hits:
                    if valid_block_geoms[hit].contains(rp):
                        block_idx = valid_block_indices[hit]
                        break

            # Find containing precinct
            precinct_idx = None
            precinct_hits = precinct_tree.query(rp, predicate='contains')
            if len(precinct_hits) > 0:
                precinct_idx = valid_precinct_indices[precinct_hits[0]]
            else:
                precinct_hits = precinct_tree.query(rp.buffer(0.001), predicate='intersects')
                for hit in precinct_hits:
                    if valid_precinct_geoms[hit].contains(rp):
                        precinct_idx = valid_precinct_indices[hit]
                        break

            if block_idx is None:
                no_block += 1
                continue
            if precinct_idx is None:
                no_precinct += 1
                continue

            assigned += 1
            row = json.dumps({
                "geom": json.loads(face_geom_json),
                "area": area,
                "blockIdx": block_idx,
                "precinctIdx": precinct_idx
            })
            out.write(row + '\n')

    face_geom_file.close()
    os.unlink(face_tmp_path)

    print(f"  Assignment: {assigned} assigned, {no_block} no block, {no_precinct} no precinct in {time.time()-t7:.1f}s", file=sys.stderr)
    print(f"  Total: {time.time()-t0:.1f}s", file=sys.stderr)


if __name__ == '__main__':
    main()
