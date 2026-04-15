import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "fs";
import { type TypedArray } from "../../../shared/entities";
import { join } from "path";
import * as shapefile from "shapefile";
import * as unzipper from "unzipper";
import * as proj4Module from "proj4";
const proj4 = (proj4Module as any).default || proj4Module;

export async function extractZipToDir(zipBuffer: Buffer, dir: string): Promise<void> {
  mkdirSync(dir, { recursive: true });
  const zip = await unzipper.Open.buffer(zipBuffer);
  await zip.extract({ path: dir });
}

// Some DBF files (e.g. AK 2016/2020 VEST) use null-byte padding instead of
// space padding for N-type numeric fields. The shapefile library returns null
// for null-padded values. Fix by replacing only trailing null bytes in numeric
// fields with spaces, leaving string fields untouched.
export function fixDbfNullPadding(dbfBytes: Buffer): Buffer {
  const buf = Buffer.from(dbfBytes); // copy so we don't mutate the original
  const headerSize = buf.readUInt16LE(8);
  const recordSize = buf.readUInt16LE(10);
  const numRecords = buf.readUInt32LE(4);
  const numFields = Math.floor((headerSize - 33) / 32);

  const numericFields: Array<{ offset: number; len: number }> = [];
  let fieldOffset = 1; // first byte of each record is deletion flag
  for (let i = 0; i < numFields; i++) {
    const descOffset = 32 + i * 32;
    const ftype = String.fromCharCode(buf[descOffset + 11]);
    const flen = buf[descOffset + 16];
    if (ftype === "N") numericFields.push({ offset: fieldOffset, len: flen });
    fieldOffset += flen;
  }

  if (numericFields.length === 0) return buf;

  for (let r = 0; r < numRecords; r++) {
    const recStart = headerSize + r * recordSize;
    for (const { offset, len } of numericFields) {
      const start = recStart + offset;
      let hasNull = false;
      for (let b = start; b < start + len; b++) {
        if (buf[b] === 0x00) {
          hasNull = true;
          break;
        }
      }
      if (!hasNull) continue;
      for (let b = start + len - 1; b >= start; b--) {
        if (buf[b] === 0x00) buf[b] = 0x20;
        else break;
      }
    }
  }
  return buf;
}

export async function readShapefile(shpPath: string, dbfPath?: string): Promise<GeoJSON.Feature[]> {
  const actualDbfPath = dbfPath || shpPath.replace(/\.shp$/i, ".dbf");
  if (existsSync(actualDbfPath)) {
    const raw = readFileSync(actualDbfPath);
    const fixed = fixDbfNullPadding(raw);
    if (!fixed.equals(raw)) writeFileSync(actualDbfPath, fixed);
  }

  const features: GeoJSON.Feature[] = [];
  const source = await shapefile.open(shpPath, actualDbfPath);
  while (true) {
    const result = await source.read();
    if (result.done) break;
    features.push(result.value);
  }
  return features;
}

// RDH shapefile zips often bundle multiple variants of the same state's data,
// one per office (e.g. `_cong_prec`, `_sldl_prec`, `_sldu_prec`, `_all_prec`).
// We want the "all offices" superset. These are tried in order; the first
// substring that matches a candidate path wins.
export const SHAPEFILE_PREFERENCES: readonly string[] = [
  "_all_prec",
  "_no_splits_prec",
  "_all_pber",
  "_all_tx_vtd",
  "_st_prec",
  "_st_"
];

// Recursive walk. Skips dotfiles and the __MACOSX directory that zip tools
// sometimes leave behind. If `preferences` is supplied, matches whose path
// contains an earlier preference substring win over later ones; otherwise the
// first file found in depth-first order is returned.
export function findFileInDir(
  dir: string,
  extension: string,
  preferences?: readonly string[]
): string {
  const matches: string[] = [];
  function walk(d: string) {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || entry.name === "__MACOSX") continue;
      const full = join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.toLowerCase().endsWith(extension.toLowerCase())) matches.push(full);
    }
  }
  walk(dir);
  if (matches.length === 0) throw new Error(`No ${extension} file found in ${dir}`);
  if (preferences && preferences.length > 0) {
    for (const pref of preferences) {
      const lowered = pref.toLowerCase();
      const hit = matches.find(m => m.toLowerCase().includes(lowered));
      if (hit) return hit;
    }
  }
  return matches[0];
}

// Locate a shapefile triplet (shp/dbf/prj) in an extracted zip. The dbf and
// prj are resolved as siblings of the chosen shp, which is important for RDH
// zips where each office-specific sub-shapefile lives in its own subdirectory
// alongside its own dbf/prj.
export function findShapefile(
  dir: string,
  preferences: readonly string[] = SHAPEFILE_PREFERENCES
): { readonly shpPath: string; readonly dbfPath: string; readonly prjPath?: string } {
  const shpPath = findFileInDir(dir, ".shp", preferences);
  const stem = shpPath.replace(/\.shp$/i, "");
  const dbfPath = existsSync(`${stem}.dbf`)
    ? `${stem}.dbf`
    : findFileInDir(dir, ".dbf", preferences);
  const prjPath = existsSync(`${stem}.prj`) ? `${stem}.prj` : undefined;
  return { shpPath, dbfPath, prjPath };
}

// Extract vote columns grouped by office code, also detect election year
// Column format: G20PRERTRU — {electionType}{YY}{office3}{party1}{name3}
export function extractVotingData(props: Record<string, any>): {
  byOffice: Record<string, { democrat: number; republican: number; other: number }>;
  electionYear: string;
} {
  const byOffice: Record<string, { democrat: number; republican: number; other: number }> = {};
  let electionYear = "";

  for (const [key, value] of Object.entries(props)) {
    // Match vote columns: letter + 2 digits + 3-letter office + party + name
    const match = key.match(/^[GPCRS](\d{2})([A-Z]{3})([DRLGIOCNSMPUAWBETH])/);
    if (!match) continue;

    const year = match[1];
    const office = match[2];
    const partyCode = match[3];
    const votes = typeof value === "number" ? value : parseInt(String(value)) || 0;

    if (!electionYear) electionYear = year;

    if (!byOffice[office]) {
      byOffice[office] = { democrat: 0, republican: 0, other: 0 };
    }

    if (partyCode === "D") {
      byOffice[office].democrat += votes;
    } else if (partyCode === "R") {
      byOffice[office].republican += votes;
    } else {
      byOffice[office].other += votes;
    }
  }

  return { byOffice, electionYear };
}

// Apportion an integer total into parts proportional to ratios,
// using largest-remainder method to preserve the sum
export function apportion(total: number, ratios: number[]): number[] {
  const sum = ratios.reduce((a, b) => a + b, 0);
  if (sum === 0) return ratios.map(() => 0);

  const exact = ratios.map(r => (total * r) / sum);
  const floored = exact.map(Math.floor);
  const remainder = total - floored.reduce((a, b) => a + b, 0);

  // Distribute remainder to entries with largest fractional parts
  const fractionals = exact.map((e, i) => ({ i, frac: e - floored[i] }));
  fractionals.sort((a, b) => b.frac - a.frac);
  for (let j = 0; j < remainder; j++) {
    floored[fractionals[j].i]++;
  }

  return floored;
}

// Reproject a GeoJSON feature's coordinates from source CRS to WGS84
export function reprojectFeature(feature: GeoJSON.Feature, projDef: string): GeoJSON.Feature {
  // Check if already geographic (NAD83 or WGS84)
  if (projDef.startsWith("GEOGCS") && !projDef.includes("PROJCS")) {
    return feature; // Already in geographic coordinates
  }

  const converter = proj4(projDef, "EPSG:4326");

  function reprojectCoords(coords: any): any {
    if (typeof coords[0] === "number") {
      // It's a point [x, y]
      const [lng, lat] = converter.forward(coords as [number, number]);
      return [lng, lat];
    }
    return coords.map(reprojectCoords);
  }

  return {
    ...feature,
    geometry: {
      ...feature.geometry,
      coordinates: reprojectCoords((feature.geometry as any).coordinates)
    } as any
  };
}

export function abbrev(id: string): string {
  return `${id}-abbrev`;
}

const UINT8_MAX = 255;
const UINT16_MAX = 65535;
const INT8_MIN = -128;
const INT8_MAX = 127;
const INT16_MIN = -32768;
const INT16_MAX = 32767;

// Makes an appropriately-sized typed array for the given data.
// Uses reduce instead of Math.max/min to avoid call stack limits on large arrays.
export function mkTypedArray(data: readonly number[]): TypedArray {
  const maxVal = data.reduce((max, v) => (max >= v ? max : v), -Infinity);
  const minVal = data.reduce((min, v) => (min <= v ? min : v), Infinity);
  return minVal >= 0
    ? maxVal <= UINT8_MAX
      ? new Uint8Array(data)
      : maxVal <= UINT16_MAX
        ? new Uint16Array(data)
        : new Uint32Array(data)
    : minVal >= INT8_MIN && maxVal <= INT8_MAX
      ? new Int8Array(data)
      : minVal >= INT16_MIN && maxVal <= INT16_MAX
        ? new Int16Array(data)
        : new Int32Array(data);
}
