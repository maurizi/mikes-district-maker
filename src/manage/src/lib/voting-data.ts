// SPDX-License-Identifier: AGPL-3.0-or-later
// © 2026 Michael Maurizi Jr.

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "fs";
import { type TypedArray } from "../../../shared/entities";
import { join } from "path";
import * as shapefile from "shapefile";
import * as unzipper from "unzipper";
import * as proj4Module from "proj4";
const proj4 = (proj4Module as any).default || proj4Module;

// Re-export proj4 so callers don't have to repeat the default-vs-namespace
// import dance that Node's CJS/ESM interop makes necessary.
export { proj4 };
export type Proj4Converter = {
  forward: (c: [number, number]) => [number, number];
  inverse: (c: [number, number]) => [number, number];
};

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

export type PartyVotes = { democrat: number; republican: number; other: number };

// Field name for an (office, party, year) triple. Matches the naming convention
// used by our .buf and topojson outputs: PRE uses bare names (democrat20),
// other offices use a prefix (USS_democrat20, GOV_democrat20, ...).
export function voteFieldName(
  office: string,
  party: "democrat" | "republican" | "other",
  electionYear: string
): string {
  const prefix = office === "PRE" ? "" : `${office}_`;
  return `${prefix}${party}${electionYear}`;
}

// Disaggregate one precinct's votes onto one block, weighted by that block's
// share of the precinct's voter-eligible population. Returns per-party rounded
// vote counts keyed by canonical field name. The caller MUST run
// reconcilePrecinctVotes afterward so rounding residuals don't drift the
// per-precinct totals.
//
// We weight by VAP_MOD (Voting Age Population minus adult correctional
// facility group quarters): kids and incarcerated adults can't vote, so
// weighting by total population over-allocates to child-heavy and
// prison-housing blocks. Matches RDH's election-disag methodology.
export function disaggregateBlockVotes(
  votes: Record<string, PartyVotes>,
  totalVotes: Record<string, number>,
  weight: number,
  officesFound: Iterable<string>,
  electionYear: string
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const office of officesFound) {
    const v = votes[office] || { democrat: 0, republican: 0, other: 0 };
    const total = totalVotes[office] || 0;
    for (const party of ["democrat", "republican", "other"] as const) {
      const f = voteFieldName(office, party, electionYear);
      out[f] = total > 0 && weight > 0 ? Math.round((v[party] / total) * weight) : 0;
    }
  }
  return out;
}

// Reconcile per-block votes so their sum matches each precinct's exact totals.
// Adjusts rounding residuals from disaggregateBlockVotes by apportioning the
// diff across the precinct's assigned blocks weighted by the same VAP_MOD used
// for disaggregation. Falls back to uniform weights when all blocks in a
// precinct have weight 0 (e.g. a nursing-home-only precinct) so votes don't
// silently drop.
//
// Generic over precinct key K (numeric pi or string precinct id) and the
// storage shape via getVote/setVote callbacks: callers pass arrows that read
// and write whichever data structure they're holding their per-block votes in
// (an array of feature props, a per-column array, etc.).
export function reconcilePrecinctVotes<K>(
  precinctAssigned: Map<K, Map<string, { featureIdx: number; weight: number }[]>>,
  getPrecinctVotes: (pi: K) => Record<string, PartyVotes>,
  getVote: (featureIdx: number, fieldName: string) => number,
  setVote: (featureIdx: number, fieldName: string, value: number) => void,
  electionYear: string
): number {
  let reconciled = 0;
  for (const [pi, officeMap] of Array.from(precinctAssigned.entries())) {
    const votes = getPrecinctVotes(pi);
    for (const [office, assignments] of Array.from(officeMap.entries())) {
      const v = votes[office] || { democrat: 0, republican: 0, other: 0 };
      for (const party of ["democrat", "republican", "other"] as const) {
        const fieldName = voteFieldName(office, party, electionYear);
        const expected = v[party];
        const actual = assignments.reduce((sum, a) => sum + getVote(a.featureIdx, fieldName), 0);
        const diff = expected - actual;
        if (diff === 0) continue;
        reconciled++;
        const rawWeights = assignments.map(a => a.weight);
        const weights = rawWeights.some(w => w > 0) ? rawWeights : rawWeights.map(() => 1);
        const adjustments = apportion(Math.abs(diff), weights);
        const sign = diff > 0 ? 1 : -1;
        for (let i = 0; i < assignments.length; i++) {
          const a = assignments[i];
          setVote(
            a.featureIdx,
            fieldName,
            getVote(a.featureIdx, fieldName) + sign * adjustments[i]
          );
        }
      }
    }
  }
  return reconciled;
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

// Reproject a GeoJSON feature's coordinates from source CRS to the target
// CRS (default WGS84). If the source is already geographic (NAD83/WGS84)
// AND the target is WGS84 we pass the feature through untouched — this
// preserves existing callers that always target WGS84 from a .prj string.
export function reprojectFeature(
  feature: GeoJSON.Feature,
  fromDef: string,
  toDef: string = "EPSG:4326"
): GeoJSON.Feature {
  if (toDef === "EPSG:4326" && fromDef.startsWith("GEOGCS") && !fromDef.includes("PROJCS")) {
    return feature;
  }

  const converter = proj4(fromDef, toDef);
  return {
    ...feature,
    geometry: {
      ...feature.geometry,
      coordinates: reprojectCoordsWith(converter, (feature.geometry as any).coordinates)
    } as any
  };
}

function reprojectCoordsWith(
  converter: { forward: (c: [number, number]) => [number, number] },
  coords: any
): any {
  if (typeof coords[0] === "number") {
    const [x, y] = converter.forward(coords as [number, number]);
    return [x, y];
  }
  return coords.map((c: any) => reprojectCoordsWith(converter, c));
}

// Reproject a bare GeoJSON Polygon/MultiPolygon using a pre-built proj4
// converter. The caller owns the converter, which lets the hot loop in
// prepare-dev-data reuse one converter per call site instead of rebuilding
// it per feature.
export function reprojectGeoJSONGeom<G extends GeoJSON.Polygon | GeoJSON.MultiPolygon>(
  geom: G,
  converter: { forward: (c: [number, number]) => [number, number] }
): G {
  return {
    ...geom,
    coordinates: reprojectCoordsWith(converter, geom.coordinates)
  } as G;
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
