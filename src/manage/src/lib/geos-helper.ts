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

function geojsonToWktScaled(geom: Polygon | MultiPolygon, scale: number): string {
  if (geom.type === "Polygon") {
    const rings = geom.coordinates
      .map(
        ring =>
          "(" +
          ring.map(p => `${Math.round(p[0] * scale)} ${Math.round(p[1] * scale)}`).join(", ") +
          ")"
      )
      .join(", ");
    return `POLYGON (${rings})`;
  }
  if (geom.type === "MultiPolygon") {
    const polys = geom.coordinates
      .map(
        poly =>
          "(" +
          poly
            .map(
              ring =>
                "(" +
                ring
                  .map(p => `${Math.round(p[0] * scale)} ${Math.round(p[1] * scale)}`)
                  .join(", ") +
                ")"
            )
            .join(", ") +
          ")"
      )
      .join(", ");
    return `MULTIPOLYGON (${polys})`;
  }
  throw new Error(`Unsupported geometry type: ${(geom as any).type}`);
}

function wktToGeoJSONScaled(wkt: string, scale: number): Polygon | MultiPolygon | null {
  const result = wktToGeoJSON(wkt);
  if (!result) return null;
  function unscaleCoords(coords: any): any {
    if (typeof coords[0] === "number") return [coords[0] / scale, coords[1] / scale];
    return coords.map(unscaleCoords);
  }
  return { ...result, coordinates: unscaleCoords(result.coordinates) } as any;
}

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

  // Bound GEOS functions
  private _initGEOS: any;
  private _WKTReader_create: any;
  private _WKTReader_read: any;
  private _WKTReader_destroy: any;
  private _WKTWriter_create: any;
  private _WKTWriter_write: any;
  private _WKTWriter_destroy: any;
  private _Prepare: any;
  private _PreparedContains: any;
  private _PreparedGeom_destroy: any;
  private _Contains: any;
  private _Intersection: any;
  private _Area: any;
  private _Buffer: any;
  private _isValid: any;
  private _isEmpty: any;
  private _Geom_destroy: any;
  private _Free: any;
  private _MinimumWidth: any;
  private _Length: any;
  private _Boundary: any;
  private _Union: any;
  private _Node: any;
  private _Polygonize: any;
  private _GetNumGeometries: any;
  private _GetGeometryN: any;
  private _PointOnSurface: any;
  private _UnaryUnion: any;
  private _CreateCollection: any;
  private _Intersects: any;
  private _Difference: any;
  private _SymDifference: any;
  private _SetPrecision: any;
  private _Snap: any;
  private _finishGEOS: any;

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
    this._Free = this.lib.func("GEOSFree", "void", [koffi.pointer("void")]);
    this._MinimumWidth = this.lib.func("GEOSMinimumWidth", GEOSGeometryPtr, [GEOSGeometryPtr]);
    this._Length = this.lib.func("GEOSLength", "int", [
      GEOSGeometryPtr,
      koffi.out(koffi.pointer("double"))
    ]);

    // Noding + polygonize operations
    this._Boundary = this.lib.func("GEOSBoundary", GEOSGeometryPtr, [GEOSGeometryPtr]);
    this._Union = this.lib.func("GEOSUnion", GEOSGeometryPtr, [GEOSGeometryPtr, GEOSGeometryPtr]);
    this._Node = this.lib.func("GEOSNode", GEOSGeometryPtr, [GEOSGeometryPtr]);
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
    this._Intersects = this.lib.func("GEOSIntersects", "int", [GEOSGeometryPtr, GEOSGeometryPtr]);
    this._Difference = this.lib.func("GEOSDifference", GEOSGeometryPtr, [
      GEOSGeometryPtr,
      GEOSGeometryPtr
    ]);
    this._SymDifference = this.lib.func("GEOSSymDifference", GEOSGeometryPtr, [
      GEOSGeometryPtr,
      GEOSGeometryPtr
    ]);
    // GEOSGeom_setPrecision(geom, gridSize, flags) — snaps coords to grid
    // flags: 0 = default (may produce invalid geometry), 1 = NO_TOPO (keep topology)
    this._SetPrecision = this.lib.func("GEOSGeom_setPrecision", GEOSGeometryPtr, [
      GEOSGeometryPtr,
      "double",
      "int"
    ]);
    // GEOSSnap(input, snapTo, tolerance) — snap vertices of input to snapTo
    this._Snap = this.lib.func("GEOSSnap", GEOSGeometryPtr, [
      GEOSGeometryPtr,
      GEOSGeometryPtr,
      "double"
    ]);
    // type 7 = GEOS_GEOMETRYCOLLECTION
    this._CreateCollection = this.lib.func("GEOSGeom_createCollection", GEOSGeometryPtr, [
      "int",
      koffi.pointer(GEOSGeometryPtr),
      "uint"
    ]);
  }

  /** Create a geometry collection from an array of geometries.
   *  WARNING: The collection takes ownership of the input geometries — do NOT free them separately. */
  createCollection(geoms: any[]): any {
    return this._CreateCollection(7, geoms, geoms.length);
  }

  /** Cascaded union of all geometries (much faster than incremental union) */
  unaryUnion(geom: any): any {
    return this._UnaryUnion(geom);
  }

  init(): void {
    this._initGEOS(null, null);
    this.reader = this._WKTReader_create();
    this.writer = this._WKTWriter_create();
  }

  /** Reset reader/writer for reuse after freeing all geometries */
  reset(): void {
    this._WKTReader_destroy(this.reader);
    this._WKTWriter_destroy(this.writer);
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

  /** Convert a GeoJSON geometry to GEOS, scaling coordinates to integers */
  fromGeoJSONScaled(geom: Polygon | MultiPolygon, scale: number): any {
    const wkt = geojsonToWktScaled(geom, scale);
    const geomPtr = this._WKTReader_read(this.reader, wkt);
    if (!geomPtr) {
      throw new Error("Failed to parse scaled geometry");
    }
    return geomPtr;
  }

  /** Convert GEOS geometry back to GeoJSON, unscaling from integers */
  toGeoJSONScaled(geom: any, scale: number): Polygon | MultiPolygon | null {
    const wkt = this._WKTWriter_write(this.writer, geom);
    if (!wkt) return null;
    return wktToGeoJSONScaled(wkt, scale);
  }

  /** Convert a GeoJSON Feature to a GEOS geometry pointer */
  featureToGeom(feature: { geometry: Polygon | MultiPolygon }): any {
    return this.fromGeoJSON(feature.geometry);
  }

  /** Create a point geometry */
  createPoint(x: number, y: number): any {
    const wkt = `POINT (${x} ${y})`;
    return this._WKTReader_read(this.reader, wkt);
  }

  /** Prepare a geometry for fast repeated spatial queries */
  prepare(geom: any): any {
    return this._Prepare(geom);
  }

  /** Check if prepared geometry contains another geometry */
  preparedContains(prepared: any, other: any): boolean {
    return this._PreparedContains(prepared, other) === 1;
  }

  /** Check if geometry A contains geometry B */
  contains(a: any, b: any): boolean {
    return this._Contains(a, b) === 1;
  }

  /** Compute intersection of two geometries */
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

  /** Get the minimum width (thinnest dimension) of a geometry */
  minimumWidth(geom: any): number {
    const mw = this._MinimumWidth(geom);
    if (!mw) return 0;
    const out = [0];
    this._Length(mw, out);
    const len = out[0];
    this._Geom_destroy(mw);
    return len;
  }

  /** Check if geometry is valid */
  isValid(geom: any): boolean {
    return this._isValid(geom) === 1;
  }

  /** Make geometry valid (buffer by 0) */
  makeValid(geom: any): any {
    return this._Buffer(geom, 0, 8);
  }

  /** Convert GEOS geometry to WKT string */
  toWkt(geom: any): string | null {
    return this._WKTWriter_write(this.writer, geom) || null;
  }

  /** Convert GEOS geometry back to GeoJSON */
  toGeoJSON(geom: any): Polygon | MultiPolygon | null {
    const wkt = this._WKTWriter_write(this.writer, geom);
    if (!wkt) return null;
    return wktToGeoJSON(wkt);
  }

  /** Check if two geometries intersect */
  intersects(a: any, b: any): boolean {
    return this._Intersects(a, b) === 1;
  }

  /** Get boundary of a geometry */
  boundary(geom: any): any {
    return this._Boundary(geom);
  }

  /** Union two geometries */
  union(a: any, b: any): any {
    return this._Union(a, b);
  }

  /** Difference: A minus B */
  difference(a: any, b: any): any {
    return this._Difference(a, b);
  }

  /** Symmetric difference: (A minus B) union (B minus A) */
  symDifference(a: any, b: any): any {
    return this._SymDifference(a, b);
  }

  /** Snap vertices of input geometry to vertices of snapTo geometry within tolerance.
   *  Returns a new geometry; caller must free it. */
  snap(input: any, snapTo: any, tolerance: number): any {
    return this._Snap(input, snapTo, tolerance);
  }

  /** Snap geometry coordinates to a precision grid.
   *  gridSize is the cell size (e.g., 1e-7 ≈ 1cm for lat/lon).
   *  Returns a new geometry; caller must free it. */
  setPrecision(geom: any, gridSize: number): any {
    return this._SetPrecision(geom, gridSize, 0);
  }

  /** Node a geometry (split lines at intersections) */
  node(geom: any): any {
    return this._Node(geom);
  }

  /** Get a representative point guaranteed to be inside the geometry */
  pointOnSurface(geom: any): any {
    return this._PointOnSurface(geom);
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
   * Returns array of { geom, precinctIdx } for faces inside the block.
   * Caller is responsible for freeing the returned geom pointers.
   */
  nodeAndSplit(
    blockGeom: any,
    precinctGeoms: { geom: any; idx: number }[]
  ): { geom: any; area: number; precinctIdx: number }[] {
    // Use original block boundary (not buffered) so noded edges share exact
    // coordinates with adjacent non-split blocks
    let combined = this._Boundary(blockGeom);

    for (const p of precinctGeoms) {
      // Validate precinct geometry (external data may be invalid) but not the block
      const validPrec = this.ensureValid(this._Buffer(p.geom, 0, 8));
      const bnd = this._Boundary(validPrec);
      this._Geom_destroy(validPrec);
      const merged = this._Union(combined, bnd);
      this._Geom_destroy(combined);
      this._Geom_destroy(bnd);
      combined = merged;
    }

    // Node to split at all intersections (UnaryUnion is more robust than GEOSNode
    // which can segfault on certain invalid geometries)
    const noded = this._UnaryUnion(combined);
    this._Geom_destroy(combined);

    // Polygonize
    const geomArray = [noded];
    const collection = this._Polygonize(geomArray, 1);
    this._Geom_destroy(noded);

    const numFaces = this._GetNumGeometries(collection);
    const results: { geom: any; area: number; precinctIdx: number }[] = [];

    for (let i = 0; i < numFaces; i++) {
      // GetGeometryN returns a borrowed pointer — we need to clone it
      // Actually, the collection owns these, so we read WKT and re-parse
      const face = this._GetGeometryN(collection, i);

      // Check if face is inside the block
      const rp = this._PointOnSurface(face);
      if (!rp) continue;

      const inBlock = this._Contains(blockGeom, rp) === 1;
      if (!inBlock) {
        this._Geom_destroy(rp);
        continue;
      }

      // Find which precinct contains this face
      let precinctIdx = -1;
      for (const p of precinctGeoms) {
        if (this._Contains(p.geom, rp) === 1) {
          precinctIdx = p.idx;
          break;
        }
      }
      this._Geom_destroy(rp);

      if (precinctIdx === -1) continue;

      const areaOut = [0];
      this._Area(face, areaOut);
      if (areaOut[0] <= 0) continue;

      // Clone the face geometry (GetGeometryN returns a borrowed ref)
      const wkt = this._WKTWriter_write(this.writer, face);
      const cloned = this._WKTReader_read(this.reader, wkt);

      results.push({ geom: cloned, area: areaOut[0], precinctIdx });
    }

    this._Geom_destroy(collection);
    return results;
  }

  /** Free a geometry pointer */
  free(geom: any): void {
    this._Geom_destroy(geom);
  }

  /** Free a prepared geometry pointer */
  freePrepared(prep: any): void {
    this._PreparedGeom_destroy(prep);
  }
}
