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

  async init(): Promise<void> {
    // geos-wasm exports a default function that returns a promise
    const mod = require("geos-wasm"); // eslint-disable-line
    const initFn = mod.default || mod;
    this.geos = await initFn();
    this.reader = this.geos.GEOSWKTReader_create();
    this.writer = this.geos.GEOSWKTWriter_create();
  }

  destroy(): void {
    this.geos.GEOSWKTReader_destroy(this.reader);
    this.geos.GEOSWKTWriter_destroy(this.writer);
  }

  private allocString(str: string): number {
    const size = str.length + 1;
    const ptr = this.geos.Module._malloc(size);
    this.geos.Module.stringToUTF8(str, ptr, size);
    return ptr;
  }

  /** Convert a GeoJSON geometry to a GEOS geometry pointer */
  fromGeoJSON(geom: Polygon | MultiPolygon): GeomPtr {
    const wkt = geojsonToWkt(geom);
    const strPtr = this.allocString(wkt);
    const geomPtr = this.geos.GEOSWKTReader_read(this.reader, strPtr);
    this.geos.Module._free(strPtr);
    if (!geomPtr) {
      throw new Error("Failed to parse geometry");
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

  /** Compute intersection of two geometries */
  intersection(a: GeomPtr, b: GeomPtr): GeomPtr | null {
    const result = this.geos.GEOSIntersection(a, b);
    if (!result) return null;
    // Check if empty
    if (this.geos.GEOSisEmpty(result) === 1) {
      this.geos.GEOSGeom_destroy(result);
      return null;
    }
    return result;
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

  /** Convert GEOS geometry back to GeoJSON */
  toGeoJSON(geom: GeomPtr): Polygon | MultiPolygon | null {
    const strPtr = this.geos.GEOSWKTWriter_write(this.writer, geom);
    if (!strPtr) return null;
    const wkt = this.geos.Module.UTF8ToString(strPtr);
    this.geos.GEOSFree(strPtr);
    return wktToGeoJSON(wkt);
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
