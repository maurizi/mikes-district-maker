// SPDX-License-Identifier: AGPL-3.0-or-later
// © 2026 Michael Maurizi Jr.

/**
 * Native GEOS helper via koffi FFI bindings to libgeos_c.
 * No WASM memory limits — uses the system's native GEOS library.
 */
import koffi from "koffi";
import { type Polygon, type MultiPolygon } from "geojson";

// Opaque pointer types
const GEOSGeometry = koffi.opaque("GEOSGeometry");
const GEOSGeometryPtr = koffi.pointer(GEOSGeometry);
const GEOSPreparedGeometry = koffi.opaque("GEOSPreparedGeometry");
const GEOSPreparedGeometryPtr = koffi.pointer(GEOSPreparedGeometry);
const GEOSWKTReader = koffi.opaque("GEOSWKTReader");
const GEOSWKTReaderPtr = koffi.pointer(GEOSWKTReader);
const GEOSWKTWriter = koffi.opaque("GEOSWKTWriter");
const GEOSWKTWriterPtr = koffi.pointer(GEOSWKTWriter);

function geojsonToWkt(geom: Polygon | MultiPolygon): string {
  if (geom.type === "Polygon") {
    const rings = geom.coordinates
      .map(ring => "(" + ring.map(p => `${p[0]} ${p[1]}`).join(", ") + ")")
      .join(", ");
    return `POLYGON (${rings})`;
  }
  if (geom.type === "MultiPolygon") {
    const polys = geom.coordinates
      .map(
        poly =>
          "(" +
          poly.map(ring => "(" + ring.map(p => `${p[0]} ${p[1]}`).join(", ") + ")").join(", ") +
          ")"
      )
      .join(", ");
    return `MULTIPOLYGON (${polys})`;
  }
  throw new Error(`Unsupported geometry type: ${(geom as any).type}`);
}

function wktToGeoJSON(wkt: string): Polygon | MultiPolygon | null {
  wkt = wkt.trim();
  if (wkt.startsWith("POLYGON")) {
    const coords = parseWktPolygon(wkt.substring(wkt.indexOf("((")));
    return { type: "Polygon", coordinates: coords };
  }
  if (wkt.startsWith("MULTIPOLYGON")) {
    const inner = wkt.substring(wkt.indexOf("(((") + 1, wkt.lastIndexOf("))") + 1);
    const polyStrs = inner.split(/\)\s*,\s*\(/);
    const coordinates = polyStrs.map(ps => {
      const cleaned = ps.replace(/^\(+/, "(").replace(/\)+$/, ")");
      return parseWktPolygon("(" + cleaned + ")");
    });
    return { type: "MultiPolygon", coordinates };
  }
  return null;
}

function parseWktPolygon(s: string): number[][][] {
  const rings: number[][][] = [];
  const ringStrs = s.match(/\([^()]+\)/g) || [];
  for (const ringStr of ringStrs) {
    const coords = ringStr
      .replace(/[()]/g, "")
      .trim()
      .split(",")
      .map(pair => {
        const [x, y] = pair.trim().split(/\s+/).map(Number);
        return [x, y];
      });
    rings.push(coords);
  }
  return rings;
}

export class GeosHelper {
  private lib: koffi.IKoffiLib;
  private reader: any;
  private writer: any;

  // GEOS lifecycle
  private _initGEOS: any;
  private _finishGEOS: any;
  // WKT I/O
  private _WKTReader_create: any;
  private _WKTReader_read: any;
  private _WKTReader_destroy: any;
  private _WKTWriter_create: any;
  private _WKTWriter_write: any;
  private _WKTWriter_destroy: any;
  // Prepared geometries (used by spatial-voting.ts)
  private _Prepare: any;
  private _PreparedContains: any;
  private _PreparedGeom_destroy: any;
  // Spatial predicates / ops used by callers + nodeAndSplit internals
  private _Contains: any;
  private _Intersection: any;
  private _Area: any;
  private _Buffer: any;
  private _isValid: any;
  private _isEmpty: any;
  private _Geom_destroy: any;
  // nodeAndSplit-only internals
  private _Boundary: any;
  private _Union: any;
  private _UnaryUnion: any;
  private _Polygonize: any;
  private _GetNumGeometries: any;
  private _GetGeometryN: any;
  private _PointOnSurface: any;
  private _Snap: any;
  private _SetPrecision: any;

  constructor() {
    this.lib = koffi.load("libgeos_c.so");

    // Initialize GEOS with null message handlers (suppress stderr)
    const noticeFn = koffi.pointer("void");
    const errorFn = koffi.pointer("void");
    this._initGEOS = this.lib.func("initGEOS", "void", [noticeFn, errorFn]);
    this._finishGEOS = this.lib.func("finishGEOS", "void", []);

    // WKT Reader
    this._WKTReader_create = this.lib.func("GEOSWKTReader_create", GEOSWKTReaderPtr, []);
    this._WKTReader_read = this.lib.func("GEOSWKTReader_read", GEOSGeometryPtr, [
      GEOSWKTReaderPtr,
      "str"
    ]);
    this._WKTReader_destroy = this.lib.func("GEOSWKTReader_destroy", "void", [GEOSWKTReaderPtr]);

    // WKT Writer
    this._WKTWriter_create = this.lib.func("GEOSWKTWriter_create", GEOSWKTWriterPtr, []);
    this._WKTWriter_write = this.lib.func("GEOSWKTWriter_write", "str", [
      GEOSWKTWriterPtr,
      GEOSGeometryPtr
    ]);
    this._WKTWriter_destroy = this.lib.func("GEOSWKTWriter_destroy", "void", [GEOSWKTWriterPtr]);

    // Prepared geometry
    this._Prepare = this.lib.func("GEOSPrepare", GEOSPreparedGeometryPtr, [GEOSGeometryPtr]);
    this._PreparedContains = this.lib.func("GEOSPreparedContains", "int", [
      GEOSPreparedGeometryPtr,
      GEOSGeometryPtr
    ]);
    this._PreparedGeom_destroy = this.lib.func("GEOSPreparedGeom_destroy", "void", [
      GEOSPreparedGeometryPtr
    ]);

    // Spatial operations
    this._Contains = this.lib.func("GEOSContains", "int", [GEOSGeometryPtr, GEOSGeometryPtr]);
    this._Intersection = this.lib.func("GEOSIntersection", GEOSGeometryPtr, [
      GEOSGeometryPtr,
      GEOSGeometryPtr
    ]);
    this._Area = this.lib.func("GEOSArea", "int", [
      GEOSGeometryPtr,
      koffi.out(koffi.pointer("double"))
    ]);
    this._Buffer = this.lib.func("GEOSBuffer", GEOSGeometryPtr, [GEOSGeometryPtr, "double", "int"]);
    this._isValid = this.lib.func("GEOSisValid", "int", [GEOSGeometryPtr]);
    this._isEmpty = this.lib.func("GEOSisEmpty", "int", [GEOSGeometryPtr]);
    this._Geom_destroy = this.lib.func("GEOSGeom_destroy", "void", [GEOSGeometryPtr]);

    // Noding + polygonize (used internally by nodeAndSplit)
    this._Boundary = this.lib.func("GEOSBoundary", GEOSGeometryPtr, [GEOSGeometryPtr]);
    this._Union = this.lib.func("GEOSUnion", GEOSGeometryPtr, [GEOSGeometryPtr, GEOSGeometryPtr]);
    this._UnaryUnion = this.lib.func("GEOSUnaryUnion", GEOSGeometryPtr, [GEOSGeometryPtr]);
    this._Polygonize = this.lib.func("GEOSPolygonize", GEOSGeometryPtr, [
      koffi.pointer(GEOSGeometryPtr),
      "uint"
    ]);
    this._GetNumGeometries = this.lib.func("GEOSGetNumGeometries", "int", [GEOSGeometryPtr]);
    this._GetGeometryN = this.lib.func("GEOSGetGeometryN", GEOSGeometryPtr, [
      GEOSGeometryPtr,
      "int"
    ]);
    this._PointOnSurface = this.lib.func("GEOSPointOnSurface", GEOSGeometryPtr, [GEOSGeometryPtr]);
    // Snap vertices of the first geometry to within `tolerance` of vertices
    // in the second. Used to force near-coincident precinct/block boundary
    // segments to coincide exactly before noding, so UnaryUnion can dedupe
    // them instead of polygonize emitting a zero-width sliver face between.
    this._Snap = this.lib.func("GEOSSnap", GEOSGeometryPtr, [
      GEOSGeometryPtr,
      GEOSGeometryPtr,
      "double"
    ]);
    // Snap a geometry's coordinates to a grid of `gridSize`. Used inside
    // nodeAndSplit to collapse near-coincident (sub-grid-offset) precinct
    // and block edges so polygonize doesn't emit zero-width sliver faces.
    // Flags=0 → default behaviour (may return collapsed geometry; caller
    // checks for empty/invalid output).
    this._SetPrecision = this.lib.func("GEOSGeom_setPrecision", GEOSGeometryPtr, [
      GEOSGeometryPtr,
      "double",
      "int"
    ]);
  }

  init(): void {
    this._initGEOS(null, null);
    this.reader = this._WKTReader_create();
    this.writer = this._WKTWriter_create();
  }

  destroy(): void {
    this._WKTReader_destroy(this.reader);
    this._WKTWriter_destroy(this.writer);
  }

  /** Convert a GeoJSON geometry to a GEOS geometry pointer */
  fromGeoJSON(geom: Polygon | MultiPolygon): any {
    const wkt = geojsonToWkt(geom);
    const geomPtr = this._WKTReader_read(this.reader, wkt);
    if (!geomPtr) {
      throw new Error("Failed to parse geometry");
    }
    return geomPtr;
  }

  /** Convert GEOS geometry back to GeoJSON */
  toGeoJSON(geom: any): Polygon | MultiPolygon | null {
    const wkt = this._WKTWriter_write(this.writer, geom);
    if (!wkt) return null;
    return wktToGeoJSON(wkt);
  }

  /** Prepare a geometry for fast repeated spatial queries */
  prepare(geom: any): any {
    return this._Prepare(geom);
  }

  /** Check if prepared geometry contains another geometry */
  preparedContains(prepared: any, other: any): boolean {
    return this._PreparedContains(prepared, other) === 1;
  }

  /** Compute intersection of two geometries; returns null for empty results. */
  intersection(a: any, b: any): any {
    const result = this._Intersection(a, b);
    if (!result) return null;
    if (this._isEmpty(result) === 1) {
      this._Geom_destroy(result);
      return null;
    }
    return result;
  }

  /** Get area of a geometry */
  area(geom: any): number {
    const out = [0];
    this._Area(geom, out);
    return out[0];
  }

  /** Buffer a geometry by a distance */
  buffer(geom: any, distance: number): any {
    return this._Buffer(geom, distance, 8);
  }

  /** Check if geometry is valid */
  isValid(geom: any): boolean {
    return this._isValid(geom) === 1;
  }

  /** Make geometry valid (buffer by 0) */
  makeValid(geom: any): any {
    return this._Buffer(geom, 0, 8);
  }

  /** Free a geometry pointer */
  free(geom: any): void {
    this._Geom_destroy(geom);
  }

  /** Free a prepared geometry pointer */
  freePrepared(prep: any): void {
    this._PreparedGeom_destroy(prep);
  }

  /** Ensure a geometry is valid, fixing if needed */
  private ensureValid(geom: any): any {
    if (this._isValid(geom) === 1) return geom;
    const fixed = this._Buffer(geom, 0, 8);
    this._Geom_destroy(geom);
    return fixed;
  }

  /**
   * Node block + precinct boundaries and polygonize to get clean faces.
   * Returns array of { geom, area, precinctIdx } for faces inside the block,
   * each labelled with whichever input precinct contains its representative
   * point. Faces inside the block but not inside any supplied precinct fall
   * back to `fallbackIdx` if provided; without a fallback they are dropped
   * (callers must accept the resulting area loss). Caller is responsible for
   * freeing the returned geom pointers.
   */
  nodeAndSplit(
    blockGeom: any,
    precinctGeoms: { geom: any; idx: number }[],
    fallbackIdx?: number
  ): { geom: any; area: number; precinctIdx: number }[] {
    // Use original block boundary (not buffered) so noded edges share exact
    // coordinates with adjacent non-split blocks.
    let combined = this._Boundary(blockGeom);

    for (const p of precinctGeoms) {
      // Validate precinct geometry (external data may be invalid) but not the block.
      const validPrec = this.ensureValid(this._Buffer(p.geom, 0, 8));
      const bnd = this._Boundary(validPrec);
      this._Geom_destroy(validPrec);
      const merged = this._Union(combined, bnd);
      this._Geom_destroy(combined);
      this._Geom_destroy(bnd);
      combined = merged;
    }

    // UnaryUnion is more robust than GEOSNode (which can segfault on certain
    // invalid geometries).
    const noded = this._UnaryUnion(combined);
    this._Geom_destroy(combined);

    const geomArray = [noded];
    const collection = this._Polygonize(geomArray, 1);
    this._Geom_destroy(noded);

    const numFaces = this._GetNumGeometries(collection);
    const results: { geom: any; area: number; precinctIdx: number }[] = [];

    for (let i = 0; i < numFaces; i++) {
      const face = this._GetGeometryN(collection, i);

      const rp = this._PointOnSurface(face);
      if (!rp) continue;

      const inBlock = this._Contains(blockGeom, rp) === 1;
      if (!inBlock) {
        this._Geom_destroy(rp);
        continue;
      }

      let precinctIdx = -1;
      for (const p of precinctGeoms) {
        if (this._Contains(p.geom, rp) === 1) {
          precinctIdx = p.idx;
          break;
        }
      }
      this._Geom_destroy(rp);

      if (precinctIdx === -1) {
        if (fallbackIdx === undefined) continue;
        precinctIdx = fallbackIdx;
      }

      const areaOut = [0];
      this._Area(face, areaOut);
      if (areaOut[0] <= 0) continue;

      // Clone the face — _GetGeometryN returns a borrowed reference owned by the collection.
      const wkt = this._WKTWriter_write(this.writer, face);
      const cloned = this._WKTReader_read(this.reader, wkt);

      results.push({ geom: cloned, area: areaOut[0], precinctIdx });
    }

    this._Geom_destroy(collection);
    return results;
  }
}
