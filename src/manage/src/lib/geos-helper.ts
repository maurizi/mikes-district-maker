/**
 * GEOS-wasm helper for fast spatial operations.
 * Wraps the low-level C API with proper memory management.
 */
// @ts-ignore — geos-wasm types have issues with some TS configs
import initGeos from "geos-wasm";
import { Feature, Polygon, MultiPolygon } from "geojson";

type GeosModule = Awaited<ReturnType<typeof initGeos>>;
type GeomPtr = number;

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
          poly
            .map(
              ring =>
                "(" + ring.map(p => `${p[0]} ${p[1]}`).join(", ") + ")"
            )
            .join(", ") +
          ")"
      )
      .join(", ");
    return `MULTIPOLYGON (${polys})`;
  }
  throw new Error(`Unsupported geometry type: ${(geom as any).type}`);
}

export class GeosHelper {
  private geos!: GeosModule;
  private reader!: number;
  private writer!: number;

  private jsonReader!: number;
  private jsonWriter!: number;

  async init(): Promise<void> {
    // geos-wasm exports a default function that returns a promise
    const mod = require("geos-wasm"); // eslint-disable-line
    const initFn = mod.default || mod;
    this.geos = await initFn();
    this.reader = this.geos.GEOSWKTReader_create();
    this.writer = this.geos.GEOSWKTWriter_create();
    this.jsonReader = this.geos.GEOSGeoJSONReader_create();
    this.jsonWriter = this.geos.GEOSGeoJSONWriter_create();
  }

  destroy(): void {
    this.geos.GEOSWKTReader_destroy(this.reader);
    this.geos.GEOSWKTWriter_destroy(this.writer);
    this.geos.GEOSGeoJSONReader_destroy(this.jsonReader);
    this.geos.GEOSGeoJSONWriter_destroy(this.jsonWriter);
  }

  private allocString(str: string): number {
    const size = str.length + 1;
    const ptr = this.geos.Module._malloc(size);
    this.geos.Module.stringToUTF8(str, ptr, size);
    return ptr;
  }

  /** Convert a GeoJSON geometry to a GEOS geometry pointer */
  fromGeoJSON(geom: Polygon | MultiPolygon): GeomPtr {
    const json = JSON.stringify(geom);
    const strPtr = this.allocString(json);
    const geomPtr = this.geos.GEOSGeoJSONReader_readGeometry(this.jsonReader, strPtr);
    this.geos.Module._free(strPtr);
    if (!geomPtr) {
      // Fallback to WKT
      const wkt = geojsonToWkt(geom);
      const wktPtr = this.allocString(wkt);
      const wktGeom = this.geos.GEOSWKTReader_read(this.reader, wktPtr);
      this.geos.Module._free(wktPtr);
      if (!wktGeom) throw new Error("Failed to parse geometry");
      return wktGeom;
    }
    return geomPtr;
  }

  /** Convert a GeoJSON Feature to a GEOS geometry pointer */
  featureToGeom(feature: Feature): GeomPtr {
    return this.fromGeoJSON(feature.geometry as Polygon | MultiPolygon);
  }

  /** Create a point geometry */
  createPoint(x: number, y: number): GeomPtr {
    const wkt = `POINT (${x} ${y})`;
    const strPtr = this.allocString(wkt);
    const geomPtr = this.geos.GEOSWKTReader_read(this.reader, strPtr);
    this.geos.Module._free(strPtr);
    return geomPtr;
  }

  /** Prepare a geometry for fast repeated spatial queries */
  prepare(geom: GeomPtr): GeomPtr {
    return this.geos.GEOSPrepare(geom);
  }

  /** Check if prepared geometry contains another geometry */
  preparedContains(prepared: GeomPtr, other: GeomPtr): boolean {
    return this.geos.GEOSPreparedContains(prepared, other) === 1;
  }

  /** Check if geometry A contains geometry B */
  contains(a: GeomPtr, b: GeomPtr): boolean {
    return this.geos.GEOSContains(a, b) === 1;
  }

  /** Compute intersection using precision-aware overlay.
   *  Inputs should already be on a consistent precision grid. */
  intersection(a: GeomPtr, b: GeomPtr): GeomPtr | null {
    const result = (this.geos as any).GEOSIntersectionPrec(a, b, 1e-6);
    if (!result) return null;
    if (this.geos.GEOSisEmpty(result) === 1) {
      this.geos.GEOSGeom_destroy(result);
      return null;
    }
    return result;
  }

  /** Fill nested rings in a polygon. Census blocks can have "holes" that are
   *  actually filled by more of the same block (island-in-lake-in-block).
   *  We convert each hole ring into a standalone polygon and union everything
   *  to collapse the nested geometry. */
  fillNestedRings(geom: GeomPtr): GeomPtr {
    // Only applies to polygons with holes
    const typeId = this.geos.GEOSGeomTypeId(geom);
    if (typeId !== 3) return geom; // 3 = Polygon

    const exterior = this.geos.GEOSGetExteriorRing(geom);
    const numHoles = this.geos.GEOSGetNumInteriorRings(geom);
    if (numHoles === 0) return geom;

    // Create a polygon from just the exterior ring (no holes)
    const extClone = this.geos.GEOSGeom_clone(exterior);
    const extPoly = this.geos.GEOSGeom_createPolygon(extClone, 0, 0);

    // Create polygons from each hole ring (treating them as exteriors)
    let result = extPoly;
    for (let i = 0; i < numHoles; i++) {
      const holeRing = this.geos.GEOSGetInteriorRingN(geom, i);
      // Reverse the ring to make it an exterior ring
      const reversed = this.geos.GEOSReverse(holeRing);
      const holePoly = this.geos.GEOSGeom_createPolygon(
        this.geos.GEOSGeom_clone(reversed), 0, 0
      );
      this.geos.GEOSGeom_destroy(reversed);
      // Union with running result
      const merged = this.geos.GEOSUnion(result, holePoly);
      this.geos.GEOSGeom_destroy(holePoly);
      if (merged) {
        this.geos.GEOSGeom_destroy(result);
        result = merged;
      }
    }
    return result;
  }

  /** Compute difference of two geometries (a minus b) */
  difference(a: GeomPtr, b: GeomPtr): GeomPtr | null {
    // Try precision-aware overlay first, fall back to classic
    let result = null;
    try {
      result = (this.geos as any).GEOSDifferencePrec(a, b, 1e-6);
    } catch { /* fall through */ }
    if (!result) {
      result = this.geos.GEOSDifference(a, b);
    }
    if (!result) return null;
    if (this.geos.GEOSisEmpty(result) === 1) {
      this.geos.GEOSGeom_destroy(result);
      return null;
    }
    return result;
  }

  /** Clone a geometry */
  clone(geom: GeomPtr): GeomPtr {
    return this.geos.GEOSGeom_clone(geom);
  }

  /** Union two geometries */
  union(a: GeomPtr, b: GeomPtr): GeomPtr | null {
    const result = this.geos.GEOSUnion(a, b);
    if (!result) return null;
    if (this.geos.GEOSisEmpty(result) === 1) {
      this.geos.GEOSGeom_destroy(result);
      return null;
    }
    return result;
  }

  /** Check if geometry is empty */
  isEmpty(geom: GeomPtr): boolean {
    return this.geos.GEOSisEmpty(geom) === 1;
  }

  /** Reduce geometry to a fixed precision grid */
  setPrecision(geom: GeomPtr, gridSize: number): GeomPtr {
    return this.geos.GEOSGeom_setPrecision(geom, gridSize, 0);
  }

  /** Get area of a geometry */
  area(geom: GeomPtr): number {
    const ptr = this.geos.Module._malloc(8);
    this.geos.GEOSArea(geom, ptr);
    const val = this.geos.Module.getValue(ptr, "double");
    this.geos.Module._free(ptr);
    return val;
  }

  /** Buffer a geometry by a distance */
  buffer(geom: GeomPtr, distance: number): GeomPtr {
    return this.geos.GEOSBuffer(geom, distance, 8);
  }

  /** Get the minimum width (thinnest dimension) of a geometry */
  minimumWidth(geom: GeomPtr): number {
    const mw = this.geos.GEOSMinimumWidth(geom);
    if (!mw) return 0;
    const ptr = this.geos.Module._malloc(8);
    this.geos.GEOSLength(mw, ptr);
    const len = this.geos.Module.getValue(ptr, "double");
    this.geos.Module._free(ptr);
    this.geos.GEOSGeom_destroy(mw);
    return len;
  }

  /** Check if geometry is valid */
  isValid(geom: GeomPtr): boolean {
    return this.geos.GEOSisValid(geom) === 1;
  }

  /** Make geometry valid (buffer by 0) */
  makeValid(geom: GeomPtr): GeomPtr {
    return this.geos.GEOSBuffer(geom, 0, 8);
  }

  /** Convert GEOS geometry to GeoJSON (any type) */
  toGeoJSONAny(geom: GeomPtr): any | null {
    const strPtr = (this.geos as any).GEOSGeoJSONWriter_writeGeometry(this.jsonWriter, geom, 0);
    if (!strPtr) return null;
    const json = this.geos.Module.UTF8ToString(strPtr);
    this.geos.GEOSFree(strPtr);
    try {
      return JSON.parse(json);
    } catch {
      return null;
    }
  }

  /** Convert GEOS geometry back to GeoJSON using native GeoJSON writer
   *  to preserve exact coordinate precision (no WKT round-trip). */
  toGeoJSON(geom: GeomPtr): Polygon | MultiPolygon | null {
    const strPtr = (this.geos as any).GEOSGeoJSONWriter_writeGeometry(this.jsonWriter, geom, 0);
    if (!strPtr) return null;
    const json = this.geos.Module.UTF8ToString(strPtr);
    this.geos.GEOSFree(strPtr);
    try {
      const parsed = JSON.parse(json);
      if (parsed.type === "Polygon" || parsed.type === "MultiPolygon") return parsed;
      if (parsed.type === "GeometryCollection") return null;
      return null;
    } catch {
      return null;
    }
  }

  /** Extract boundary of a geometry as a linestring/multilinestring */
  boundary(geom: GeomPtr): GeomPtr {
    const result = this.geos.GEOSBoundary(geom);
    if (!result) throw new Error("GEOSBoundary failed");
    return result;
  }

  /** Create a geometry collection from an array of geometries.
   *  Type constants: 5=MultiLineString, 7=GeometryCollection.
   *  The collection takes ownership of the input geometries — do not free them separately. */
  createCollection(type: number, geoms: GeomPtr[]): GeomPtr {
    const n = geoms.length;
    const arrayPtr = this.geos.Module._malloc(n * 4);
    for (let i = 0; i < n; i++) {
      (this.geos.Module as any).setValue(arrayPtr + i * 4, geoms[i], "i32");
    }
    const result = (this.geos as any).GEOSGeom_createCollection(type, arrayPtr, n);
    this.geos.Module._free(arrayPtr);
    if (!result) throw new Error("GEOSGeom_createCollection failed");
    return result;
  }

  /** Compute unary union of a geometry (typically a collection).
   *  For linestrings, this nodes them at all intersection points. */
  unaryUnion(geom: GeomPtr): GeomPtr {
    const result = this.geos.GEOSUnaryUnion(geom);
    if (!result) throw new Error("GEOSUnaryUnion failed");
    return result;
  }

  /** Polygonize a set of linestring geometries.
   *  Returns a GeometryCollection of polygons reconstructed from the noded edges. */
  polygonize(geoms: GeomPtr[]): GeomPtr {
    const n = geoms.length;
    const arrayPtr = this.geos.Module._malloc(n * 4);
    for (let i = 0; i < n; i++) {
      (this.geos.Module as any).setValue(arrayPtr + i * 4, geoms[i], "i32");
    }
    const result = (this.geos as any).GEOSPolygonize(arrayPtr, n);
    this.geos.Module._free(arrayPtr);
    if (!result) throw new Error("GEOSPolygonize failed");
    return result;
  }

  /** Get centroid coordinates of a geometry */
  centroid(geom: GeomPtr): { x: number; y: number } {
    const centroidGeom = this.geos.GEOSGetCentroid(geom);
    if (!centroidGeom) throw new Error("GEOSGetCentroid failed");
    const coords = this.extractPointCoords(centroidGeom);
    this.geos.GEOSGeom_destroy(centroidGeom);
    return coords;
  }

  /** Get a point guaranteed to be inside the geometry's interior (not on boundary) */
  pointOnSurface(geom: GeomPtr): { x: number; y: number } {
    const pt = (this.geos as any).GEOSPointOnSurface(geom);
    if (!pt) throw new Error("GEOSPointOnSurface failed");
    const coords = this.extractPointCoords(pt);
    this.geos.GEOSGeom_destroy(pt);
    return coords;
  }

  private extractPointCoords(pointGeom: GeomPtr): { x: number; y: number } {
    const cs = this.geos.GEOSGeom_getCoordSeq(pointGeom);
    const xPtr = this.geos.Module._malloc(8);
    const yPtr = this.geos.Module._malloc(8);
    this.geos.GEOSCoordSeq_getX(cs, 0, xPtr);
    this.geos.GEOSCoordSeq_getY(cs, 0, yPtr);
    const x = this.geos.Module.getValue(xPtr, "double");
    const y = this.geos.Module.getValue(yPtr, "double");
    this.geos.Module._free(xPtr);
    this.geos.Module._free(yPtr);
    return { x, y };
  }

  /** Get number of geometries in a collection */
  getNumGeometries(geom: GeomPtr): number {
    return this.geos.GEOSGetNumGeometries(geom);
  }

  /** Get the nth geometry from a collection.
   *  Returns a BORROWED pointer — do NOT free it. */
  getGeometryN(geom: GeomPtr, n: number): GeomPtr {
    return this.geos.GEOSGetGeometryN(geom, n);
  }

  private origNoticeHandler: number = 0;
  private origErrorHandler: number = 0;

  /** Suppress GEOS notice/error messages (self-intersection warnings etc.) */
  suppressWarnings(): void {
    const ctx = (this.geos as any)._ctx;
    const noopPtr = (this.geos.Module as any).addFunction(() => {}, "vii");
    this.origNoticeHandler = this.geos.GEOSContext_setNoticeHandler_r(ctx, noopPtr);
    this.origErrorHandler = this.geos.GEOSContext_setErrorHandler_r(ctx, noopPtr);
  }

  /** Restore GEOS message handlers */
  restoreWarnings(): void {
    const ctx = (this.geos as any)._ctx;
    if (this.origNoticeHandler) {
      this.geos.GEOSContext_setNoticeHandler_r(ctx, this.origNoticeHandler);
    }
    if (this.origErrorHandler) {
      this.geos.GEOSContext_setErrorHandler_r(ctx, this.origErrorHandler);
    }
  }

  /** Free a geometry pointer */
  free(geom: GeomPtr): void {
    this.geos.GEOSGeom_destroy(geom);
  }

  /** Free a prepared geometry pointer */
  freePrepared(prep: GeomPtr): void {
    this.geos.GEOSPreparedGeom_destroy(prep);
  }
}

function wktToGeoJSON(wkt: string): Polygon | MultiPolygon | null {
  wkt = wkt.trim();
  if (wkt.startsWith("POLYGON")) {
    const coords = parseWktPolygon(wkt.substring(wkt.indexOf("((")));
    return { type: "Polygon", coordinates: coords };
  }
  if (wkt.startsWith("MULTIPOLYGON")) {
    const inner = wkt.substring(wkt.indexOf("(((") + 1, wkt.lastIndexOf("))") + 1);
    // Split on ")),((" to get individual polygons
    const polyStrs = inner.split(/\)\s*,\s*\(/);
    const coordinates = polyStrs.map(ps => {
      const cleaned = ps.replace(/^\(+/, "(").replace(/\)+$/, ")");
      return parseWktPolygon("(" + cleaned + ")");
    });
    return { type: "MultiPolygon", coordinates };
  }
  // For other types (GeometryCollection from intersection), return null
  return null;
}

function parseWktPolygon(s: string): number[][][] {
  // Input: "((x y, x y, ...), (x y, ...))"
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
