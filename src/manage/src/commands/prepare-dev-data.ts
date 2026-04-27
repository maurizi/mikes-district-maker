// SPDX-License-Identifier: AGPL-3.0-or-later
// © 2026 Michael Maurizi Jr.

import { Args, Command, Flags } from "@oclif/core";
import {
  writeFileSync,
  readFileSync,
  readdirSync,
  mkdirSync,
  existsSync,
  createWriteStream,
  createReadStream,
  writeSync
} from "fs";
import { parseBlockDistrictCsv } from "../../../shared/csv-import";
import { dirname, join } from "path";
import { tmpdir } from "os";
import RBush from "rbush";
import { type MultiPolygon, type Polygon } from "geojson";

import { GeosHelper } from "../lib/geos-helper";
import {
  extractZipToDir,
  readShapefile,
  findFileInDir,
  findShapefile,
  extractVotingData,
  apportion,
  reprojectFeature,
  reprojectGeoJSONGeom,
  disaggregateBlockVotes,
  reconcilePrecinctVotes,
  proj4,
  type Proj4Converter
} from "../lib/voting-data";
import { getStateProjection } from "../lib/state-projections";
import { createInterface } from "readline";

// Simple bbox from GeoJSON coordinates (no library needed)
function featureBbox(f: GeoJSON.Feature): [number, number, number, number] {
  const coords = (f.geometry as any).coordinates;
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  function walk(c: any) {
    if (typeof c[0] === "number") {
      if (c[0] < minX) minX = c[0];
      if (c[0] > maxX) maxX = c[0];
      if (c[1] < minY) minY = c[1];
      if (c[1] > maxY) maxY = c[1];
    } else {
      for (const sub of c) walk(sub);
    }
  }
  walk(coords);
  return [minX, minY, maxX, maxY];
}

// R-tree item for spatial index
interface RTreeItem {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  index: number;
}

// Try to find a county-FIPS/name column in a feature's properties. VEST's
// schema varies by state; we auto-detect from a short list of common names.
const COUNTY_FIELD_CANDIDATES = [
  "COUNTYFP",
  "COUNTYFP20",
  "COUNTY_FP",
  "COUNTYFIPS",
  "CNTY_FIPS",
  "CTY_FIPS",
  "COUNTY",
  "CNTY_NAME",
  "COUNTY_NAM",
  "COUNTY_NAME"
];
function detectCountyField(props: Record<string, any>): string | null {
  for (const f of COUNTY_FIELD_CANDIDATES) if (f in props) return f;
  return null;
}

// Resolve placeholder VEST features — duplicate-ID groups where every
// member has zero/null votes. States like CA and FL use placeholder
// precinct IDs (e.g. SRPREC_KEY=60857000, PRECINCT=0000, NAME="NA") for
// administrative catch-all categories, and commonly split them into
// dozens or hundreds of polygon fragments under a single ID.
//
// Two behaviors per member feature:
//   * small (< SLIVER_AREA_M2): absorbed into its nearest real-precinct
//     neighbor in the same county (geographic merge; keeps every square
//     meter covered)
//   * larger: kept as its own distinct precinct with a synthetic
//     uniquified ID (`${precinctId}-${seq}`), so the sanity check
//     passes without losing geographic fidelity. Zero-vote but real
//     land area.
function centroidOf(geom: Polygon | MultiPolygon | null | undefined): [number, number] | null {
  if (!geom) return null;
  let sx = 0;
  let sy = 0;
  let n = 0;
  const walk = (c: any): void => {
    if (typeof c[0] === "number") {
      sx += c[0];
      sy += c[1];
      n++;
    } else for (const sub of c) walk(sub);
  };
  walk((geom as any).coordinates);
  if (n === 0) return null;
  return [sx / n, sy / n];
}
// Shoelace-formula ring area. For projected coords returns m²; for lat/lon
// returns (deg²) which we convert via a latitude correction.
function ringArea(ring: number[][]): number {
  let a = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    a += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  }
  return Math.abs(a) / 2;
}
function geomAreaSqM(
  geom: Polygon | MultiPolygon | null | undefined,
  isGeographic: boolean
): number {
  if (!geom) return 0;
  const polys = geom.type === "Polygon" ? [geom.coordinates] : geom.coordinates;
  let total = 0;
  let latSum = 0;
  let latN = 0;
  for (const poly of polys) {
    if (!poly[0]) continue;
    const outer = ringArea(poly[0]);
    let holes = 0;
    for (let i = 1; i < poly.length; i++) holes += ringArea(poly[i]);
    total += outer - holes;
    if (isGeographic) {
      for (const [, y] of poly[0]) {
        latSum += y;
        latN++;
      }
    }
  }
  if (!isGeographic) return total;
  // Convert deg² → m² using approximate equirectangular scaling at the mean
  // latitude of the outer rings. Good enough for the small/large sliver
  // classification; we don't need precision.
  const meanLat = latN > 0 ? (latSum / latN) * (Math.PI / 180) : 0;
  return total * 110574 * 111320 * Math.cos(meanLat);
}
function detectIsGeographic(features: GeoJSON.Feature[]): boolean {
  for (const f of features) {
    if (!f.geometry) continue;
    const first = (function probe(c: any): any {
      return typeof c[0] === "number" ? c : probe(c[0]);
    })((f.geometry as any).coordinates);
    return Math.abs(first[0]) <= 180;
  }
  return true;
}

function resolvePlaceholderDuplicates(
  features: GeoJSON.Feature[],
  precinctField: string,
  log: (s: string) => void
): GeoJSON.Feature[] {
  if (features.length === 0) return features;
  const countyField = detectCountyField(features[0].properties || {});
  const isGeographic = detectIsGeographic(features);
  const groups = new Map<string, GeoJSON.Feature[]>();
  for (const f of features) {
    const props = (f.properties || {}) as Record<string, any>;
    const county = countyField ? String(props[countyField] ?? "") : "";
    const precinct = String(props[precinctField] ?? "");
    const key = `${county}|${precinct}`;
    let arr = groups.get(key);
    if (!arr) {
      arr = [];
      groups.set(key, arr);
    }
    arr.push(f);
  }
  const voteRx = /^[GPCRS]\d{2}[A-Z]{3}/;
  const hasRealVotes = (f: GeoJSON.Feature): boolean => {
    const p = (f.properties || {}) as Record<string, any>;
    for (const k of Object.keys(p)) {
      if (!voteRx.test(k)) continue;
      const v = p[k];
      if (typeof v === "number" && v > 0) return true;
    }
    return false;
  };
  // Pieces below this area are too small to be a real precinct (<32m ×
  // 32m on a side) and get absorbed into their nearest real-precinct
  // neighbor. Larger pieces are kept as distinct precincts with a
  // synthesized uniquified id.
  const SLIVER_AREA_M2 = 1000;

  // Partition each group: keep single-feature groups + groups where any
  // member has real votes. For zero-vote duplicate groups, classify each
  // member as "sliver" (→ absorb) or "big" (→ promote to its own precinct).
  const kept: GeoJSON.Feature[] = [];
  const slivers: GeoJSON.Feature[] = [];
  const splitStats: Array<{ key: string; big: number; sliver: number }> = [];
  const warnings: string[] = [];
  for (const [key, group] of groups) {
    if (group.length === 1) {
      kept.push(group[0]);
      continue;
    }
    if (group.some(hasRealVotes)) {
      for (const f of group) kept.push(f);
      warnings.push(`${key} (${group.length} feats; has real votes, kept all)`);
      continue;
    }
    // Zero-vote dup group — classify each member by size.
    let big = 0;
    let sliver = 0;
    for (let idx = 0; idx < group.length; idx++) {
      const f = group[idx];
      const area = geomAreaSqM(f.geometry as Polygon | MultiPolygon | null, isGeographic);
      if (area < SLIVER_AREA_M2) {
        slivers.push(f);
        sliver++;
      } else {
        // Promote to its own precinct with a synthesized uniquified id —
        // append an index suffix so each big piece has a distinct
        // (county, precinctId) key. Preserves the original id for
        // debuggability (`originalPrecinctId_seq`).
        const origProps = (f.properties || {}) as Record<string, any>;
        const origId = String(origProps[precinctField] ?? "");
        const newProps = { ...origProps, [precinctField]: `${origId}-${idx + 1}` };
        kept.push({ ...f, properties: newProps });
        big++;
      }
    }
    splitStats.push({ key, big, sliver });
  }

  // Merge each sliver's geometry into the nearest same-county real
  // neighbor by centroid distance. Nearest-neighbor here is cheap (sliver
  // count is small and precincts are localized).
  const attachTo = new Map<GeoJSON.Feature, Polygon[]>();
  let unmatched = 0;
  if (slivers.length > 0) {
    const keptByCounty = new Map<string, GeoJSON.Feature[]>();
    for (const f of kept) {
      const county = countyField ? String((f.properties as any)?.[countyField] ?? "") : "";
      let arr = keptByCounty.get(county);
      if (!arr) {
        arr = [];
        keptByCounty.set(county, arr);
      }
      arr.push(f);
    }
    const keptCentroids = new Map<GeoJSON.Feature, [number, number]>();
    for (const f of kept) {
      const c = centroidOf(f.geometry as Polygon | MultiPolygon | null);
      if (c) keptCentroids.set(f, c);
    }
    for (const sv of slivers) {
      const svCentroid = centroidOf(sv.geometry as Polygon | MultiPolygon | null);
      if (!svCentroid) {
        unmatched++;
        continue;
      }
      const county = countyField ? String((sv.properties as any)?.[countyField] ?? "") : "";
      const candidates = keptByCounty.get(county) ?? kept;
      if (candidates.length === 0) {
        unmatched++;
        continue;
      }
      let bestKept: GeoJSON.Feature | null = null;
      let bestDistSq = Infinity;
      for (const k of candidates) {
        const kc = keptCentroids.get(k);
        if (!kc) continue;
        const dx = kc[0] - svCentroid[0];
        const dy = kc[1] - svCentroid[1];
        const d = dx * dx + dy * dy;
        if (d < bestDistSq) {
          bestDistSq = d;
          bestKept = k;
        }
      }
      if (!bestKept) {
        unmatched++;
        continue;
      }
      const g = sv.geometry as Polygon | MultiPolygon | null;
      if (!g) continue;
      let arr = attachTo.get(bestKept);
      if (!arr) {
        arr = [];
        attachTo.set(bestKept, arr);
      }
      if (g.type === "Polygon") arr.push(g);
      else for (const p of g.coordinates) arr.push({ type: "Polygon", coordinates: p });
    }
  }

  // Apply the sliver absorptions to their neighbors' geometries.
  const out: GeoJSON.Feature[] = [];
  for (const k of kept) {
    const attached = attachTo.get(k);
    if (!attached || attached.length === 0) {
      out.push(k);
      continue;
    }
    const polys: number[][][][] = [];
    const g = k.geometry as Polygon | MultiPolygon | null;
    if (g) {
      if (g.type === "Polygon") polys.push(g.coordinates);
      else for (const p of g.coordinates) polys.push(p);
    }
    for (const ph of attached) polys.push(ph.coordinates);
    const geom: Polygon | MultiPolygon =
      polys.length === 1
        ? { type: "Polygon", coordinates: polys[0] }
        : { type: "MultiPolygon", coordinates: polys };
    out.push({ ...k, geometry: geom });
  }

  if (splitStats.length > 0) {
    log(
      `   Resolved ${splitStats.length} zero-vote duplicate precinct groups ` +
        `(county field=${countyField ?? "none"}, sliver threshold=${SLIVER_AREA_M2} m²):`
    );
    for (const { key, big, sliver } of splitStats) {
      log(`     ${key}: ${big} promoted to distinct precincts, ${sliver} absorbed as slivers`);
    }
  }
  if (unmatched > 0) {
    log(`   WARNING: ${unmatched} sliver features had no nearest neighbor; dropped`);
  }
  if (warnings.length > 0) {
    log(`   WARNING: ${warnings.length} duplicate-ID groups have votes and were kept:`);
    for (const w of warnings.slice(0, 10)) log(`     ${w}`);
    if (warnings.length > 10) log(`     ... and ${warnings.length - 10} more`);
  }
  return out;
}

// ── Topology helpers used by the rescue-detection step ──
// countPieces returns the number of polygons in a (possibly Multi)Polygon.
function countPieces(geom: Polygon | MultiPolygon | null | undefined): number {
  if (!geom) return 0;
  if (geom.type === "Polygon") return 1;
  if (geom.type === "MultiPolygon") return geom.coordinates.length;
  return 0;
}

// Canonicalize a segment between two points so both orientations of a
// shared edge map to the same key.
function canonSegment(a: number[], b: number[]): string {
  const ax = a[0];
  const ay = a[1];
  const bx = b[0];
  const by = b[1];
  if (ax < bx || (ax === bx && ay < by)) return `${ax},${ay}|${bx},${by}`;
  return `${bx},${by}|${ax},${ay}`;
}

// countComponents: number of connected components across all polygons in the
// given geometries, where two polygons are connected iff they share at least
// one boundary segment. MultiPolygon geoms are flattened to their constituent
// polygons. TIGER blocks share exact boundary coords with their neighbors,
// so segment-hash adjacency gives the same result as GEOS unaryUnion +
// GetNumGeometries at a fraction of the cost. Mirrors the approach used by
// verify-precinct-topology.
function countComponents(geoms: (Polygon | MultiPolygon)[]): number {
  const polys: number[][][][] = [];
  for (const g of geoms) {
    if (g.type === "Polygon") polys.push(g.coordinates);
    else for (const p of g.coordinates) polys.push(p);
  }
  if (polys.length <= 1) return polys.length;

  const segToPolys = new Map<string, number[]>();
  for (let pi = 0; pi < polys.length; pi++) {
    for (const ring of polys[pi]) {
      for (let i = 0; i < ring.length - 1; i++) {
        const key = canonSegment(ring[i], ring[i + 1]);
        const list = segToPolys.get(key);
        if (list === undefined) segToPolys.set(key, [pi]);
        else if (list[list.length - 1] !== pi) list.push(pi);
      }
    }
  }

  const parent = new Int32Array(polys.length);
  for (let i = 0; i < parent.length; i++) parent[i] = i;
  const find = (x: number): number => {
    let cur = x;
    while (parent[cur] !== cur) {
      parent[cur] = parent[parent[cur]];
      cur = parent[cur];
    }
    return cur;
  };
  const unite = (x: number, y: number): void => {
    const rx = find(x);
    const ry = find(y);
    if (rx !== ry) parent[rx] = ry;
  };
  for (const list of segToPolys.values()) {
    if (list.length < 2) continue;
    for (let i = 1; i < list.length; i++) unite(list[0], list[i]);
  }

  const roots = new Set<number>();
  for (let i = 0; i < polys.length; i++) roots.add(find(i));
  return roots.size;
}

export default class PrepareDevData extends Command {
  static description =
    "Download Census 2020 block data and demographics, spatially join VEST voting data, and output GeoJSON for process-geojson";

  static flags = {
    vest: Flags.string({
      char: "v",
      description: "Path to VEST election shapefile zip (required)",
      required: true
    }),
    vestPrecinctField: Flags.string({
      char: "p",
      description:
        "VEST shapefile field name for precinct ID; optionally `idField:nameField` " +
        "to pull a human-readable display name from a separate column",
      required: true
    }),
    output: Flags.string({
      char: "o",
      description: "Output GeoJSON file path",
      default: "dev-data/output.geojson"
    }),
    censusCache: Flags.string({
      char: "c",
      description: "Path to cache Census blocks+demographics GeoJSON (skips download if exists)"
    }),
    additionalVest: Flags.string({
      char: "a",
      description:
        "Additional VEST zips for other election years, comma-separated as precinctField:path pairs",
      default: ""
    }),
    befDir: Flags.string({
      description:
        "Directory containing per-state BEF CSV subdirectories (e.g. dev-data/befs). Blocks referenced in any CSV under <befDir>/<stateAbbr>/ are allowed to fall back to the nearest precinct when outside precinct coverage; all other blocks outside precinct coverage are dropped."
    }),
    adjDir: Flags.string({
      description:
        "Directory containing normalized adjusted-PL CSVs (e.g. dev-data/adjusted-pl). " +
        "If <adjDir>/<STATE>.csv exists, adjusted population fields (adj_population, etc.) " +
        "are merged into block demographics."
    })
  };

  static args = {
    stateFips: Args.string({
      description: "2-digit state FIPS code (e.g. 10 for Delaware)",
      required: true
    }),
    stateAbbr: Args.string({
      description: "State abbreviation (e.g. DE)",
      required: true
    })
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(PrepareDevData);
    const stateFips = args.stateFips.padStart(2, "0");
    const stateAbbr = args.stateAbbr.toUpperCase();
    const tmp = join(tmpdir(), `census-${stateAbbr}`);
    mkdirSync(tmp, { recursive: true });

    this.log(`Preparing dev data for ${stateAbbr} (FIPS ${stateFips})`);

    // Per-state projection: assignment + rescue work in meter-based Cartesian
    // coords so GEOS intersection / area math is geodetically sound. Outputs
    // are reprojected back to WGS84 before write.
    const stateProjDef = getStateProjection(stateAbbr);
    const toLocal: Proj4Converter = proj4("EPSG:4326", stateProjDef);
    const toWgs84: Proj4Converter = proj4(stateProjDef, "EPSG:4326");
    this.log(`Local projection: ${stateProjDef}`);

    // Load block GEOIDs referenced in official district CSVs for this state.
    // Blocks in this set are allowed to fall back to nearest-precinct when
    // outside real precinct coverage (needed so official district imports
    // cover stray water blocks). Blocks not in this set are dropped when
    // outside coverage, and we fail loudly if a dropped block carries
    // population data.
    const blocksInBef = new Set<string>();
    if (flags.befDir) {
      const stateBefDir = join(flags.befDir, stateAbbr);
      if (!existsSync(stateBefDir)) {
        this.log(
          `   WARNING: --befDir set but ${stateBefDir} does not exist; running in strict mode (no nearest-precinct fallback)`
        );
      } else {
        const csvFiles = readdirSync(stateBefDir).filter(
          f => f.endsWith(".csv") && !f.includes("_district_names")
        );
        for (const f of csvFiles) {
          const records = parseBlockDistrictCsv(readFileSync(join(stateBefDir, f), "utf-8"));
          for (const [blockId] of records) blocksInBef.add(blockId);
        }
        this.log(
          `   Loaded ${blocksInBef.size} block GEOIDs from ${csvFiles.length} BEF CSVs in ${stateBefDir}`
        );
      }
    } else {
      this.log("   No --befDir provided; running in strict mode (no nearest-precinct fallback)");
    }

    // ── Step 1: Get Census blocks + demographics ──
    let blockFeatures: GeoJSON.Feature[];
    let blockDemographics: Map<string, Record<string, number>>;
    let countyNames: Map<string, string>;

    // Census cache uses separate files: features are in a geojsonseq file (one per line),
    // demographics and county names in smaller JSON files
    const cacheDir = flags.censusCache ? dirname(flags.censusCache) : "";
    const cacheBase = flags.censusCache ? flags.censusCache.replace(/\.geojson$/, "") : "";
    const cacheFeaturesPath = cacheBase + ".features.geojsonseq";
    const cacheDemoPath = cacheBase + ".demographics.json";
    const cacheCountyPath = cacheBase + ".counties.json";
    const cacheExists = cacheBase && existsSync(cacheFeaturesPath) && existsSync(cacheDemoPath);

    if (cacheExists) {
      this.log("\n1. Loading Census data from cache...");
      // Read features line by line (geojsonseq) to avoid string length limit
      blockFeatures = [];
      const rl = createInterface({
        input: createReadStream(cacheFeaturesPath),
        crlfDelay: Infinity
      });
      for await (const line of rl) {
        if (line.trim()) blockFeatures.push(JSON.parse(line));
      }
      // Demographics and county names are small enough for JSON.parse
      blockDemographics = new Map(Object.entries(JSON.parse(readFileSync(cacheDemoPath, "utf-8"))));
      countyNames = new Map(Object.entries(JSON.parse(readFileSync(cacheCountyPath, "utf-8"))));
      this.log(
        `   ${blockFeatures.length} blocks, ${blockDemographics.size} demographics loaded from cache`
      );

      // Backfill VAP_MOD for caches written before the prison adjustment was added.
      const sampleDemo = blockDemographics.values().next().value;
      if (sampleDemo && sampleDemo.VAP_MOD === undefined) {
        this.log("   Cache missing VAP_MOD; fetching P5_003N to backfill...");
        const prisonUrl = `https://api.census.gov/data/2020/dec/pl?get=P5_003N&for=block:*&in=state:${stateFips}&in=county:*&in=tract:*`;
        const prisonResp = await fetch(prisonUrl);
        if (!prisonResp.ok) throw new Error(`Census P5 API failed: ${prisonResp.status}`);
        const prisonData: string[][] = await prisonResp.json();
        for (let i = 1; i < prisonData.length; i++) {
          const [prisonAdult, st, cty, tr, blk] = prisonData[i];
          const geoId = `${st}${cty}${tr}${blk}`;
          const demo = blockDemographics.get(geoId);
          if (demo) demo.VAP_MOD = Math.max(0, (demo.VAP || 0) - (parseInt(prisonAdult) || 0));
        }
        writeFileSync(cacheDemoPath, JSON.stringify(Object.fromEntries(blockDemographics)));
        this.log(`   VAP_MOD backfilled and cache rewritten`);
      }
    } else {
      // Download Census block shapefile
      this.log("\n1a. Downloading Census 2020 block shapefile...");
      const tigerUrl = `https://www2.census.gov/geo/tiger/TIGER2020/TABBLOCK20/tl_2020_${stateFips}_tabblock20.zip`;
      const tigerResp = await fetch(tigerUrl);
      if (!tigerResp.ok) throw new Error(`Failed to download TIGER data: ${tigerResp.status}`);
      const tigerBuffer = Buffer.from(await tigerResp.arrayBuffer());
      this.log(`   Downloaded ${(tigerBuffer.length / 1024 / 1024).toFixed(1)}MB`);

      const tigerDir = join(tmp, "tiger");
      await extractZipToDir(tigerBuffer, tigerDir);
      const shpFile = findFileInDir(tigerDir, ".shp");
      const dbfFile = findFileInDir(tigerDir, ".dbf");
      blockFeatures = await readShapefile(shpFile, dbfFile);
      this.log(`   ${blockFeatures.length} blocks loaded`);

      // Fetch demographics from Census API
      this.log("\n1b. Fetching demographics from Census API...");
      // P5_003N = adult correctional facilities group quarters. Used to
      // compute VAP_MOD = VAP - prison, which weights vote disaggregation.
      // Incarcerated adults are counted in VAP but can't vote, so VAP-weighted
      // disaggregation still over-allocates votes to blocks housing prisons.
      // VAP_MOD fixes that. Matches RDH's approach.
      const censusUrl = `https://api.census.gov/data/2020/dec/pl?get=P1_001N,P1_003N,P1_004N,P1_006N,P2_002N,P3_001N,P3_003N,P3_004N,P3_006N,P4_002N,P5_003N&for=block:*&in=state:${stateFips}&in=county:*&in=tract:*`;
      const censusResp = await fetch(censusUrl);
      if (!censusResp.ok) throw new Error(`Census API failed: ${censusResp.status}`);
      const censusData: string[][] = await censusResp.json();

      blockDemographics = new Map();
      for (let i = 1; i < censusData.length; i++) {
        const [
          pop,
          white,
          black,
          asian,
          hispanic,
          vap,
          vapWhite,
          vapBlack,
          vapAsian,
          vapHispanic,
          prisonAdult,
          state,
          county,
          tract,
          block
        ] = censusData[i];
        const geoId = `${state}${county}${tract}${block}`;
        const popN = parseInt(pop) || 0;
        const whiteN = parseInt(white) || 0;
        const blackN = parseInt(black) || 0;
        const asianN = parseInt(asian) || 0;
        const hispanicN = parseInt(hispanic) || 0;
        const otherN = Math.max(0, popN - whiteN - blackN - asianN - hispanicN);
        const vapN = parseInt(vap) || 0;
        const vapWhiteN = parseInt(vapWhite) || 0;
        const vapBlackN = parseInt(vapBlack) || 0;
        const vapAsianN = parseInt(vapAsian) || 0;
        const vapHispanicN = parseInt(vapHispanic) || 0;
        const vapOtherN = Math.max(0, vapN - vapWhiteN - vapBlackN - vapAsianN - vapHispanicN);
        const prisonN = parseInt(prisonAdult) || 0;
        blockDemographics.set(geoId, {
          population: popN,
          white: whiteN,
          black: blackN,
          asian: asianN,
          hispanic: hispanicN,
          other: otherN,
          VAP: vapN,
          "VAP White": vapWhiteN,
          "VAP Black": vapBlackN,
          "VAP Asian": vapAsianN,
          "VAP Hispanic": vapHispanicN,
          "VAP Other": vapOtherN,
          VAP_MOD: Math.max(0, vapN - prisonN)
        });
      }
      this.log(`   ${blockDemographics.size} block demographics loaded`);

      // Fetch county names
      this.log("   Fetching county names...");
      const countyNamesUrl = `https://api.census.gov/data/2020/dec/pl?get=NAME&for=county:*&in=state:${stateFips}`;
      const countyNamesResp = await fetch(countyNamesUrl);
      const countyNamesData: string[][] = await countyNamesResp.json();
      countyNames = new Map();
      for (let i = 1; i < countyNamesData.length; i++) {
        const [name, , countyFp] = countyNamesData[i];
        countyNames.set(countyFp, name.split(",")[0].trim());
      }
      this.log(`   ${countyNames.size} county names loaded`);

      // Fetch CVAP data from ACS 5-year estimates at tract level.
      // B05003 is NOT published at block-group level — the API returns nulls
      // for block-group queries. Tract is the finest geography available.
      this.log("\n1c. Fetching CVAP data from ACS 5-year estimates...");
      // B05003 race iterations: total (B05003), White non-Hispanic (H), Black (B), Asian (D), Hispanic (I)
      // CVAP = Male 18+ Native (_009) + Male 18+ Naturalized (_011) + Female 18+ Native (_020) + Female 18+ Naturalized (_022)
      const cvapTables = [
        { prefix: "B05003", key: "cvapTotal" },
        { prefix: "B05003H", key: "cvapWhite" },
        { prefix: "B05003B", key: "cvapBlack" },
        { prefix: "B05003D", key: "cvapAsian" },
        { prefix: "B05003I", key: "cvapHispanic" }
      ];
      const cvapVars = cvapTables.flatMap(t => [
        `${t.prefix}_009E`,
        `${t.prefix}_011E`,
        `${t.prefix}_020E`,
        `${t.prefix}_022E`
      ]);
      const acsUrl = `https://api.census.gov/data/2022/acs/acs5?get=${cvapVars.join(",")}&for=tract:*&in=state:${stateFips}&in=county:*`;
      const acsResp = await fetch(acsUrl);
      if (!acsResp.ok) throw new Error(`ACS API failed: ${acsResp.status}`);
      const acsData: string[][] = await acsResp.json();

      // Parse CVAP by tract
      const tractCvap = new Map<
        string,
        {
          cvapTotal: number;
          cvapWhite: number;
          cvapBlack: number;
          cvapAsian: number;
          cvapHispanic: number;
          cvapOther: number;
        }
      >();
      for (let i = 1; i < acsData.length; i++) {
        const row = acsData[i];
        // Each table has 4 vars: _009E, _011E, _020E, _022E
        const vals: Record<string, number> = {};
        let colIdx = 0;
        for (const t of cvapTables) {
          const v009 = parseInt(row[colIdx++]) || 0;
          const v011 = parseInt(row[colIdx++]) || 0;
          const v020 = parseInt(row[colIdx++]) || 0;
          const v022 = parseInt(row[colIdx++]) || 0;
          vals[t.key] = v009 + v011 + v020 + v022;
        }
        // Geography columns are at the end: state, county, tract
        const tState = row[colIdx++];
        const tCounty = row[colIdx++];
        const tTract = row[colIdx++];
        const tractId = `${tState}${tCounty}${tTract}`;
        const cvapOther = Math.max(
          0,
          vals.cvapTotal - vals.cvapWhite - vals.cvapBlack - vals.cvapAsian - vals.cvapHispanic
        );
        tractCvap.set(tractId, {
          cvapTotal: vals.cvapTotal,
          cvapWhite: vals.cvapWhite,
          cvapBlack: vals.cvapBlack,
          cvapAsian: vals.cvapAsian,
          cvapHispanic: vals.cvapHispanic,
          cvapOther
        });
      }
      this.log(`   ${tractCvap.size} tracts with CVAP data`);

      // Compute VAP totals per tract for proportional distribution
      const tractVapTotals = new Map<string, number>();
      for (const [geoId, demo] of blockDemographics) {
        // Tract = first 11 chars of block GeoID (state2 + county3 + tract6)
        const tractId = geoId.substring(0, 11);
        tractVapTotals.set(tractId, (tractVapTotals.get(tractId) || 0) + demo.VAP);
      }

      // Distribute CVAP to blocks proportionally by VAP
      let cvapMatched = 0;
      let cvapUnmatched = 0;
      for (const [geoId, demo] of blockDemographics) {
        const tractId = geoId.substring(0, 11);
        const cvap = tractCvap.get(tractId);
        const tractVap = tractVapTotals.get(tractId) || 0;
        if (cvap && tractVap > 0) {
          const ratio = demo.VAP / tractVap;
          demo.CVAP = Math.round(cvap.cvapTotal * ratio);
          demo["CVAP White"] = Math.round(cvap.cvapWhite * ratio);
          demo["CVAP Black"] = Math.round(cvap.cvapBlack * ratio);
          demo["CVAP Asian"] = Math.round(cvap.cvapAsian * ratio);
          demo["CVAP Hispanic"] = Math.round(cvap.cvapHispanic * ratio);
          demo["CVAP Other"] = Math.round(cvap.cvapOther * ratio);
          cvapMatched++;
        } else {
          demo.CVAP = 0;
          demo["CVAP White"] = 0;
          demo["CVAP Black"] = 0;
          demo["CVAP Asian"] = 0;
          demo["CVAP Hispanic"] = 0;
          demo["CVAP Other"] = 0;
          cvapUnmatched++;
        }
      }
      this.log(`   CVAP distributed: ${cvapMatched} blocks matched, ${cvapUnmatched} unmatched`);

      // Save cache as separate files to avoid string length limits
      if (cacheBase) {
        mkdirSync(cacheDir, { recursive: true });
        // Features as geojsonseq (one per line)
        const featFd = require("fs").openSync(cacheFeaturesPath, "w"); // eslint-disable-line
        for (const f of blockFeatures) {
          require("fs").writeSync(featFd, JSON.stringify(f) + "\n"); // eslint-disable-line
        }
        require("fs").closeSync(featFd); // eslint-disable-line
        // Demographics and county names are small
        writeFileSync(cacheDemoPath, JSON.stringify(Object.fromEntries(blockDemographics)));
        writeFileSync(cacheCountyPath, JSON.stringify(Object.fromEntries(countyNames)));
        this.log(`   Saved cache to ${cacheBase}.*`);
      }
    }

    // Load adjusted population data if available (runs regardless of cache)
    const adjCsvPath = flags.adjDir ? join(flags.adjDir, `${stateAbbr}.csv`) : "";
    if (adjCsvPath && existsSync(adjCsvPath)) {
      this.log(`\nLoading adjusted population from ${adjCsvPath}...`);
      const adjContent = readFileSync(adjCsvPath, "utf-8");
      const adjLines = adjContent
        .split("\n")
        .map(l => l.replace(/\r$/, ""))
        .filter(l => l.trim());
      const adjHeader = adjLines[0].split(",");
      const adjGeoidIdx = adjHeader.indexOf("GEOID");
      let adjMatched = 0;
      let adjUnmatched = 0;
      for (let i = 1; i < adjLines.length; i++) {
        const cols = adjLines[i].split(",");
        const geoid = cols[adjGeoidIdx];
        const demo = blockDemographics.get(geoid);
        if (demo) {
          for (let c = 0; c < adjHeader.length; c++) {
            const field = adjHeader[c];
            if (field !== "GEOID") {
              // Allow negative values (expected for some prison reallocation blocks)
              demo[field] = Math.round(parseFloat(cols[c]) || 0);
            }
          }
          adjMatched++;
        } else {
          adjUnmatched++;
        }
      }
      this.log(`   Adjusted pop merged: ${adjMatched} blocks matched, ${adjUnmatched} unmatched`);
    }

    // Reproject block features from WGS84 to the per-state local CRS so the
    // assignment and rescue steps below work in meters; we reproject geoms
    // back to WGS84 only at write-out.
    this.log(`\nReprojecting ${blockFeatures.length} blocks to local CRS...`);
    for (let i = 0; i < blockFeatures.length; i++) {
      const geom = blockFeatures[i].geometry as Polygon | MultiPolygon | null;
      if (!geom) continue;
      blockFeatures[i] = {
        ...blockFeatures[i],
        geometry: reprojectGeoJSONGeom(geom, toLocal)
      };
    }

    // ── Step 2: Load VEST precinct polygons with geometry ──
    this.log("\n2. Loading VEST precinct polygons...");
    const vestPath = flags.vest.replace("~", process.env.HOME || "");
    const vestBuffer = readFileSync(vestPath);
    const vestDir = join(tmp, "vest");
    await extractZipToDir(vestBuffer, vestDir);
    const { shpPath: vestShp, dbfPath: vestDbf, prjPath: vestPrj } = findShapefile(vestDir);
    let vestFeatures = await readShapefile(vestShp, vestDbf);
    this.log(`   ${vestFeatures.length} VEST precincts loaded (${vestShp})`);

    // Reproject VEST features directly to the per-state local CRS. When
    // the VEST .prj is already geographic (NAD83/WGS84) we project from
    // EPSG:4326; otherwise we project from the source .prj directly, so
    // we only transform coordinates once.
    if (vestPrj) {
      const prjContent = readFileSync(vestPrj, "utf-8").trim();
      const isProjected = prjContent.startsWith("PROJCS");
      if (isProjected) {
        this.log(`   Reprojecting VEST from projected CRS to local CRS...`);
        vestFeatures = vestFeatures.map(f => reprojectFeature(f, prjContent, stateProjDef));
      } else {
        this.log(`   Reprojecting VEST from geographic to local CRS...`);
        vestFeatures = vestFeatures.map(f => reprojectFeature(f, "EPSG:4326", stateProjDef));
      }
    } else {
      // No .prj: assume WGS84 and project to local.
      this.log(`   No VEST .prj; assuming WGS84 and reprojecting to local CRS...`);
      vestFeatures = vestFeatures.map(f => reprojectFeature(f, "EPSG:4326", stateProjDef));
    }

    // The `--vestPrecinctField` flag accepts an optional `id:name` syntax —
    // `id` is the unique-per-county identifier used for the precinct key
    // (must disambiguate every VEST row); `name` is an optional separate
    // human-readable column whose value goes into `precinct_name` for
    // display. Without `:name`, the precinct id itself (with any -N
    // promotion suffix) is used as the name.
    const colonIdx = flags.vestPrecinctField.indexOf(":");
    const precinctField =
      colonIdx >= 0 ? flags.vestPrecinctField.substring(0, colonIdx) : flags.vestPrecinctField;
    const precinctNameField = colonIdx >= 0 ? flags.vestPrecinctField.substring(colonIdx + 1) : "";

    // Resolve zero-vote duplicate precinct groups: big pieces become their
    // own distinct precincts (synthesized unique id), slivers get absorbed
    // into the nearest real-precinct neighbor. Keeps geographic fidelity
    // for substantial areas (like CA's 41 km² pieces under SRPREC_KEY=
    // 60855000) while cleaning out truly tiny placeholder artifacts.
    vestFeatures = resolvePlaceholderDuplicates(vestFeatures, precinctField, s => this.log(s));

    // Extract precinct IDs and voting data
    const precinctVoting = new Map<
      number,
      {
        precinctId: string;
        precinctName: string;
        votes: Record<string, { democrat: number; republican: number; other: number }>;
        totalVotes: Record<string, number>;
      }
    >();
    const officesFound = new Set<string>();

    let detectedYear = "";
    for (let i = 0; i < vestFeatures.length; i++) {
      const props = vestFeatures[i].properties as Record<string, any>;
      const precinctId = String(props[precinctField] ?? `vest-${i + 1}`);
      // If `id:name` was passed, prefer the human-readable name field;
      // otherwise the within-county-unique precinctId (with any -N
      // promotion suffix) doubles as the display name.
      const precinctName = precinctNameField
        ? String(props[precinctNameField] ?? precinctId)
        : precinctId;
      const { byOffice, electionYear } = extractVotingData(props);
      if (electionYear && !detectedYear) detectedYear = electionYear;
      for (const office of Object.keys(byOffice)) officesFound.add(office);
      const totalVotes: Record<string, number> = {};
      for (const [office, v] of Object.entries(byOffice)) {
        totalVotes[office] = v.democrat + v.republican + v.other;
      }
      precinctVoting.set(i, { precinctId, precinctName, votes: byOffice, totalVotes });
    }
    this.log(`   Election year: 20${detectedYear}`);
    this.log(`   Offices found: ${Array.from(officesFound).sort().join(", ")}`);

    // ── Step 3: Build precinct GEOS geometries ──
    // All spatial work below runs in the per-state local CRS (meters), set up
    // above. Block features were already reprojected; do the same for VEST.
    this.log("\n3. Building precinct GEOS geometries...");
    const geosHelper = new GeosHelper();
    geosHelper.init();

    const precinctGeoms: any[] = [];
    for (let pi = 0; pi < vestFeatures.length; pi++) {
      const geom = vestFeatures[pi].geometry;
      if (!geom) {
        precinctGeoms.push(null);
        continue;
      }
      try {
        let g = geosHelper.fromGeoJSON(geom as Polygon | MultiPolygon);
        if (!geosHelper.isValid(g)) {
          const fixed = geosHelper.makeValid(g);
          geosHelper.free(g);
          g = fixed;
        }
        precinctGeoms.push(g);
      } catch {
        precinctGeoms.push(null);
      }
    }

    // R-tree over precinct bboxes for fast block→precinct candidate lookup.
    const precinctTree = new RBush<RTreeItem>();
    {
      const items: RTreeItem[] = [];
      for (let pi = 0; pi < vestFeatures.length; pi++) {
        if (!precinctGeoms[pi]) continue;
        const [minX, minY, maxX, maxY] = featureBbox(vestFeatures[pi]);
        items.push({ minX, minY, maxX, maxY, index: pi });
      }
      precinctTree.load(items);
    }

    // ── Step 4: Build block GEOS geometries ──
    this.log("\n4. Building block GEOS geometries...");
    const blockGeoms: any[] = new Array(blockFeatures.length).fill(null);
    const validBlocks = new Set<number>();
    for (let bi = 0; bi < blockFeatures.length; bi++) {
      if (bi % 20000 === 0 && bi > 0) {
        this.log(`   ${bi}/${blockFeatures.length} blocks built...`);
      }
      const geom = blockFeatures[bi].geometry;
      if (!geom) continue;
      try {
        let g = geosHelper.fromGeoJSON(geom as Polygon | MultiPolygon);
        if (!geosHelper.isValid(g)) {
          const fixed = geosHelper.makeValid(g);
          geosHelper.free(g);
          g = fixed;
        }
        blockGeoms[bi] = g;
        validBlocks.add(bi);
      } catch {
        /* skip */
      }
    }
    this.log(`   ${validBlocks.size}/${blockFeatures.length} blocks have valid geometry`);

    // R-tree over block bboxes — used by step 7 (rescue) to find candidate
    // blocks per target precinct in O(log n + k) instead of scanning all
    // valid blocks per rescue. Builds once; reused for every rescue.
    const blockTree = new RBush<RTreeItem>();
    {
      const items: RTreeItem[] = [];
      for (const bi of validBlocks) {
        const [minX, minY, maxX, maxY] = featureBbox(blockFeatures[bi]);
        items.push({ minX, minY, maxX, maxY, index: bi });
      }
      blockTree.load(items);
    }

    // Canonical edge key (direction-independent). Two blocks sharing edge
    // (A,B) both produce the same key, so we can find who's on the other
    // side of any given segment.
    const canonEdgeKey = (a: number[], b: number[]): string => {
      if (a[0] < b[0] || (a[0] === b[0] && a[1] < b[1])) {
        return `${a[0]},${a[1]}|${b[0]},${b[1]}`;
      }
      return `${b[0]},${b[1]}|${a[0]},${a[1]}`;
    };
    // Note: edge → neighbor-blocks lookup is built lazily per split parent in
    // step 7.5 via blockTree + local edge map. Building it globally would
    // exceed V8's per-Map 2^24-entry cap on large states (CA ~25M edges).

    // ── Step 5: Assign each block to its majority-area precinct ──
    // For each block: query R-tree for candidate precincts, intersect+area
    // each candidate, assign to the one with the largest overlap. BEF blocks
    // (referenced in official district CSVs) outside any precinct fall back
    // to nearest-precinct by bbox-center distance — they need to survive even
    // when sitting in water or edge cases. Other unassigned blocks are dropped,
    // with a hard error if they carry demographic data.
    this.log("\n5. Assigning blocks to precincts (majority-area overlap)...");
    const SEARCH_BUFFER_M = 100;
    const NEAREST_SEARCH_M = 100000;
    const assignment = new Map<number, number>();
    let nearestFallbacks = 0;
    {
      let processed = 0;
      for (const bi of validBlocks) {
        if (processed % 20000 === 0 && processed > 0) {
          this.log(`   ${processed}/${validBlocks.size} blocks assigned...`);
        }
        processed++;
        const blockGeom = blockGeoms[bi];
        const [bMinX, bMinY, bMaxX, bMaxY] = featureBbox(blockFeatures[bi]);
        const cands = precinctTree.search({
          minX: bMinX - SEARCH_BUFFER_M,
          minY: bMinY - SEARCH_BUFFER_M,
          maxX: bMaxX + SEARCH_BUFFER_M,
          maxY: bMaxY + SEARCH_BUFFER_M
        });
        let bestPi = -1;
        let bestArea = 0;
        for (const cand of cands) {
          const inter = geosHelper.intersection(blockGeom, precinctGeoms[cand.index]);
          if (!inter) continue;
          const a = geosHelper.area(inter);
          geosHelper.free(inter);
          if (a > bestArea) {
            bestArea = a;
            bestPi = cand.index;
          }
        }
        if (bestPi === -1) {
          // No precinct overlaps. Fall back to nearest precinct by bbox-center
          // distance, but only for blocks referenced in an official district CSV.
          const blockProps = blockFeatures[bi].properties as Record<string, any>;
          const geoId = blockProps.GEOID20 as string;
          if (blocksInBef.has(geoId)) {
            const cx = (bMinX + bMaxX) / 2;
            const cy = (bMinY + bMaxY) / 2;
            let bestDist = Infinity;
            const fallbackCands = precinctTree.search({
              minX: cx - NEAREST_SEARCH_M,
              minY: cy - NEAREST_SEARCH_M,
              maxX: cx + NEAREST_SEARCH_M,
              maxY: cy + NEAREST_SEARCH_M
            });
            for (const c of fallbackCands) {
              const pcx = (c.minX + c.maxX) / 2;
              const pcy = (c.minY + c.maxY) / 2;
              const d = (pcx - cx) ** 2 + (pcy - cy) ** 2;
              if (d < bestDist) {
                bestDist = d;
                bestPi = c.index;
              }
            }
            if (bestPi !== -1) nearestFallbacks++;
          }
        }
        if (bestPi !== -1) assignment.set(bi, bestPi);
      }
    }
    this.log(
      `   Assigned ${assignment.size}/${validBlocks.size} blocks (${nearestFallbacks} BEF nearest-precinct fallbacks)`
    );

    // Hard-fail any blocks with demographic data that didn't land on a precinct.
    // These are usually a sign the BEF set is incomplete (an official district
    // CSV is missing a stray water/coastline block) or a data prep bug worth
    // surfacing rather than silently dropping.
    {
      const dropped: string[] = [];
      for (const bi of validBlocks) {
        if (assignment.has(bi)) continue;
        const geoId = (blockFeatures[bi].properties as Record<string, any>).GEOID20 as string;
        const demo = blockDemographics.get(geoId);
        if (!demo) continue;
        const hasData =
          (demo.population || 0) > 0 ||
          (demo.VAP || 0) > 0 ||
          (demo.CVAP || 0) > 0 ||
          (demo.white || 0) > 0 ||
          (demo.black || 0) > 0 ||
          (demo.asian || 0) > 0 ||
          (demo.hispanic || 0) > 0 ||
          (demo.other || 0) > 0;
        if (hasData) dropped.push(geoId);
      }
      if (dropped.length > 0) {
        this.error(
          `${dropped.length} blocks with demographic data have no precinct coverage` +
            ` (e.g. ${dropped.slice(0, 5).join(", ")}). Add them to a BEF CSV under` +
            ` --befDir, or investigate why they lack precinct coverage.`
        );
      }
    }

    // ── Step 6: Detect precincts that need a topological rescue split ──
    // Compare each VEST precinct's piece count to the connected-component count
    // of its assigned blocks. Any inequality (orphan, lost-pieces, fragmented)
    // means whole-block assignment lost topological fidelity, and we need to
    // split a block to restore parity. TIGER blocks share exact boundary
    // coordinates with their neighbors, so segment-hash adjacency gives the
    // same connected-component count as GEOS unaryUnion at a fraction of the
    // cost — see verify-precinct-topology for the same approach.
    this.log("\n6. Detecting precincts that need rescue splits...");
    const blocksByPrecinct = new Map<number, number[]>();
    for (const [bi, pi] of assignment) {
      let arr = blocksByPrecinct.get(pi);
      if (!arr) {
        arr = [];
        blocksByPrecinct.set(pi, arr);
      }
      arr.push(bi);
    }

    type Rescue = {
      precinctIdx: number;
      reason: "orphan" | "fragmented" | "lost-pieces";
      vestPieces: number;
      assignedPieces: number;
    };
    const rescues: Rescue[] = [];
    for (let pi = 0; pi < vestFeatures.length; pi++) {
      if (!precinctGeoms[pi]) continue;
      const vestGeom = vestFeatures[pi].geometry as Polygon | MultiPolygon | null;
      const vestN = countPieces(vestGeom);
      const blockIdxs = blocksByPrecinct.get(pi) || [];
      if (blockIdxs.length === 0) {
        rescues.push({
          precinctIdx: pi,
          reason: "orphan",
          vestPieces: vestN,
          assignedPieces: 0
        });
        continue;
      }
      const geomList: (Polygon | MultiPolygon)[] = [];
      for (const bi of blockIdxs) {
        const g = blockFeatures[bi].geometry;
        if (g) geomList.push(g as Polygon | MultiPolygon);
      }
      const assignedN = countComponents(geomList);
      if (assignedN < vestN) {
        rescues.push({
          precinctIdx: pi,
          reason: "lost-pieces",
          vestPieces: vestN,
          assignedPieces: assignedN
        });
      } else if (assignedN > vestN) {
        rescues.push({
          precinctIdx: pi,
          reason: "fragmented",
          vestPieces: vestN,
          assignedPieces: assignedN
        });
      }
    }
    if (rescues.length > 0) {
      this.log(`   ${rescues.length} precinct(s) need rescue:`);
      for (const r of rescues.slice(0, 20)) {
        const props = vestFeatures[r.precinctIdx].properties as Record<string, any>;
        const pid = String(props?.[precinctField] ?? `vest_${r.precinctIdx}`);
        this.log(
          `     ${r.reason.padEnd(12)} ${pid}  (vest=${r.vestPieces}, assigned=${r.assignedPieces})`
        );
      }
      if (rescues.length > 20) this.log(`     ... and ${rescues.length - 20} more`);
    } else {
      this.log(`   No rescue splits needed`);
    }
    // Each rescue splits ~1 block, so rescues/blocks ≈ fraction of blocks split.
    // Real states top out around 0.05% (PA); 0.5% would be a strong signal that
    // either the VEST shapefile is misaligned with TIGER or majority-area
    // assignment is failing on this state's geometry.
    const rescueRatio = validBlocks.size > 0 ? rescues.length / validBlocks.size : 0;
    if (rescueRatio > 0.005) {
      this.log(
        `   WARNING: ${rescues.length} rescues across ${validBlocks.size} blocks` +
          ` (${(rescueRatio * 100).toFixed(2)}%) — well above the expected <0.1%.` +
          ` Investigate before relying on output.`
      );
    }

    // ── Step 7: Perform rescue splits ──
    // For each rescue: find the block with the largest overlap with the target
    // precinct, then call nodeAndSplit on that block with all overlapping
    // precincts. The resulting sub-blocks replace the parent in the assignment.
    this.log("\n7. Performing rescue splits...");
    type SubBlock = {
      parentBlockIdx: number;
      subBlockId: string;
      geom: Polygon | MultiPolygon;
      precinctIdx: number;
      areaShare: number;
    };
    const subBlocks: SubBlock[] = [];
    const splitParents = new Set<number>();
    // Tracks precinctIdxs that have received a sub-block from ANY rescue
    // so far (either their own or as a byproduct of another target's
    // rescue). When we split block X for precinct A, nodeAndSplit emits
    // sub-blocks for every precinct that overlaps X — so B, C, ... may
    // end up covered too even if their own rescue hasn't run yet. Use
    // this set to skip rescues whose target is already covered, silently,
    // instead of emitting a misleading "no neighbor blocks" warning.
    const coveredByRescue = new Set<number>();
    let silentlySkipped = 0;
    let unnecessaryRescues = 0;
    let doubledEdgeRescues = 0;
    let multiSplitRescues = 0; // rescues that committed >1 split
    let redundantSplitsDetected = 0; // Phase 3 warning count
    let tinyTargetRejections = 0; // candidates rejected for too-small largest part
    let missingParentVertRescues = 0; // candidates rejected for missing a parent-ring vertex in all siblings
    for (const rescue of rescues) {
      const targetPi = rescue.precinctIdx;
      const targetGeom = precinctGeoms[targetPi];
      if (!targetGeom) continue;
      if (coveredByRescue.has(targetPi)) {
        silentlySkipped++;
        continue;
      }

      // Find blocks bbox-overlapping the precinct via the block R-tree, then
      // keep ones with real GEOS-area overlap that are NOT already assigned
      // to the target (a block already in the target wouldn't add a new
      // piece to it). R-tree query is O(log n + k) per rescue — crucial for
      // states with thousands of rescues (CA ~4k).
      const [pMinX, pMinY, pMaxX, pMaxY] = featureBbox(vestFeatures[targetPi]);
      const candidates: { bi: number; overlap: number }[] = [];
      const bboxCandidates = blockTree.search({
        minX: pMinX,
        minY: pMinY,
        maxX: pMaxX,
        maxY: pMaxY
      });
      for (const bc of bboxCandidates) {
        const bi = bc.index;
        if (splitParents.has(bi)) continue; // already split for another rescue
        if (assignment.get(bi) === targetPi) continue; // already in target — splitting wouldn't help
        const inter = geosHelper.intersection(blockGeoms[bi], targetGeom);
        if (!inter) continue;
        const a = geosHelper.area(inter);
        geosHelper.free(inter);
        if (a > 0) candidates.push({ bi, overlap: a });
      }
      candidates.sort((a, b) => b.overlap - a.overlap);
      if (candidates.length === 0) {
        const props = vestFeatures[targetPi].properties as Record<string, any>;
        const pid = String(props?.[precinctField] ?? `vest_${targetPi}`);
        this.log(
          `   WARNING: precinct ${pid} has no neighbor blocks to split for rescue; skipping`
        );
        continue;
      }

      // Phase 2: greedy-add splits one at a time until target's topology
      // matches VEST's or no helpful candidate remains. Each iteration
      // picks the first candidate in overlap-area order that both
      //   (a) moves target closer to vestN in the correct direction, and
      //   (b) doesn't produce the sibling-double-edge pattern.
      // For precincts needing multiple splits to restore topology, this
      // will commit all of them in a single rescue.
      const MAX_CANDIDATES_TO_TRY = 20;
      const thisRescueSplits: number[] = [];
      const rejectedCands = new Set<number>();
      greedy: while (true) {
        // Check current target topology — are we satisfied yet?
        const currentGeoms: (Polygon | MultiPolygon)[] = [];
        for (const bi of blocksByPrecinct.get(targetPi) || []) {
          if (splitParents.has(bi)) continue;
          const g = blockFeatures[bi].geometry as Polygon | MultiPolygon | null;
          if (g) currentGeoms.push(g);
        }
        for (const sb of subBlocks) {
          if (sb.precinctIdx === targetPi) currentGeoms.push(sb.geom);
        }
        const currComp = countComponents(currentGeoms);
        const vestN = rescue.vestPieces;
        const needsMore =
          (rescue.reason === "orphan" && currComp === 0) ||
          (rescue.reason === "fragmented" && currComp > vestN) ||
          (rescue.reason === "lost-pieces" && currComp < vestN);
        if (!needsMore) break greedy;

        let madeProgress = false;
        for (
          let candIdx = 0;
          candIdx < Math.min(candidates.length, MAX_CANDIDATES_TO_TRY);
          candIdx++
        ) {
          const candBi = candidates[candIdx].bi;
          if (rejectedCands.has(candBi)) continue;
          if (splitParents.has(candBi)) continue;
          if (assignment.get(candBi) === targetPi) continue;
          const splitBi = candBi;
          const splitGeom = blockGeoms[splitBi];
          const splitProps = blockFeatures[splitBi].properties as Record<string, any>;
          const splitGeoId = splitProps.GEOID20 as string;
          const splitDemo = blockDemographics.get(splitGeoId);
          if (!splitDemo) {
            this.log(`   WARNING: block ${splitGeoId} has no demographics; skipping rescue`);
            continue;
          }

          // Include every precinct that bbox-overlaps and geometrically touches
          // the block, so nodeAndSplit sees the full partition and doesn't drop
          // any face (dropping = attributing area to the wrong precinct). Slivers
          // from 3rd/4th precincts that barely clip a corner get merged into the
          // previous assignee below, so the final sub-blocks are the two we care
          // about (target + prev) with no micro-pieces.
          const previousAssignee = assignment.get(splitBi);
          if (previousAssignee === undefined || previousAssignee === targetPi) {
            // Candidate sweep already filters assignment.get(bi) === targetPi,
            // so this would only trip if the assignment map is unexpectedly
            // missing the chosen block. Skip rather than guess.
            this.log(
              `   WARNING: block ${splitGeoId} has no usable previous assignee; skipping rescue`
            );
            continue;
          }
          const intersectingPrecincts: { geom: any; idx: number }[] = [];
          const seenPrecinctIdx = new Set<number>();
          const includePrecinct = (idx: number): void => {
            if (seenPrecinctIdx.has(idx)) return;
            const pg = precinctGeoms[idx];
            if (!pg) return;
            intersectingPrecincts.push({ geom: pg, idx });
            seenPrecinctIdx.add(idx);
          };
          includePrecinct(targetPi);
          includePrecinct(previousAssignee);
          const [bMinX, bMinY, bMaxX, bMaxY] = featureBbox(blockFeatures[splitBi]);
          const blockCands = precinctTree.search({
            minX: bMinX - SEARCH_BUFFER_M,
            minY: bMinY - SEARCH_BUFFER_M,
            maxX: bMaxX + SEARCH_BUFFER_M,
            maxY: bMaxY + SEARCH_BUFFER_M
          });
          for (const cand of blockCands) {
            if (seenPrecinctIdx.has(cand.index)) continue;
            const pg = precinctGeoms[cand.index];
            if (!pg) continue;
            const inter = geosHelper.intersection(splitGeom, pg);
            if (!inter) continue;
            const a = geosHelper.area(inter);
            geosHelper.free(inter);
            if (a > 0) includePrecinct(cand.index);
          }

          // Use previousAssignee as the fallback precinct for any face
          // inside the block but outside all supplied precincts (happens when
          // a block extends into water or off-map areas). This guarantees
          // the sub-blocks tile the parent with no area loss.
          const rawFaces = geosHelper.nodeAndSplit(
            splitGeom,
            intersectingPrecincts,
            previousAssignee
          );
          if (rawFaces.length === 0) {
            this.log(`   WARNING: nodeAndSplit produced no faces for ${splitGeoId}; skipping`);
            continue;
          }
          // GEOS polygonize can emit sub-m² sliver faces from float drift along
          // precinct/block boundary intersections. They carry no meaningful
          // assignment but survive into the output MultiPolygon, where
          // topojson quantization can snap them into siblings or neighbors and
          // produce visible overlaps. Drop anything below 1 m² — real precinct
          // slivers are orders of magnitude larger.
          const FACE_NOISE_M2 = 1;
          const faces: typeof rawFaces = [];
          for (const f of rawFaces) {
            if (f.area < FACE_NOISE_M2) geosHelper.free(f.geom);
            else faces.push(f);
          }
          if (faces.length === 0) {
            this.log(
              `   WARNING: nodeAndSplit produced only sliver faces for ${splitGeoId}; skipping`
            );
            continue;
          }
          const totalSubArea = faces.reduce((s, f) => s + f.area, 0);
          if (totalSubArea === 0) {
            for (const f of faces) geosHelper.free(f.geom);
            continue;
          }

          // Sanity: sub-blocks must now tile the parent — if not, something
          // went wrong (e.g., a face's representative point was on the
          // boundary so it got dropped). Log and skip rather than emit a
          // lossy split.
          const parentArea = geosHelper.area(splitGeom);
          if (parentArea > 0) {
            const drift = Math.abs(totalSubArea - parentArea) / parentArea;
            if (drift > 0.01) {
              this.log(
                `   SKIP: block ${splitGeoId} rescue still drifts ${(drift * 100).toFixed(1)}%` +
                  ` despite fallback (parent=${parentArea.toFixed(0)} m²,` +
                  ` sub-sum=${totalSubArea.toFixed(0)} m²); target precinct stays as-is`
              );
              for (const f of faces) geosHelper.free(f.geom);
              continue;
            }
          }

          // Group faces by precinct (a precinct may take multiple disjoint pieces
          // of the block); emit one sub-block per precinct.
          const facesByPrecinct = new Map<number, { geom: any; area: number }[]>();
          for (const f of faces) {
            let arr = facesByPrecinct.get(f.precinctIdx);
            if (!arr) {
              arr = [];
              facesByPrecinct.set(f.precinctIdx, arr);
            }
            arr.push({ geom: f.geom, area: f.area });
          }

          // Merge sub-block slivers into the largest non-sliver group. Slivers
          // (sub-mm² up to a few hundred m²) come from precinct boundaries just
          // clipping a corner of the block — they collapse in downstream
          // simplification and can erase a precinct from the rendered map.
          // The target precinct is always protected (even if its face is small,
          // we need it to survive the rescue).
          const MIN_SUB_AREA_M2 = 100;
          const precinctAreas = new Map<number, number>();
          for (const [pi, pFaces] of facesByPrecinct) {
            precinctAreas.set(
              pi,
              pFaces.reduce((s, f) => s + f.area, 0)
            );
          }
          let largestPi = -1;
          let largestArea = 0;
          for (const [pi, a] of precinctAreas) {
            if (a > largestArea) {
              largestArea = a;
              largestPi = pi;
            }
          }
          if (largestPi !== -1) {
            const slivers: number[] = [];
            for (const [pi, a] of precinctAreas) {
              if (pi === largestPi || pi === targetPi) continue;
              if (a < MIN_SUB_AREA_M2) slivers.push(pi);
            }
            for (const sliverPi of slivers) {
              const sliverFaces = facesByPrecinct.get(sliverPi)!;
              const largestFaces = facesByPrecinct.get(largestPi)!;
              for (const f of sliverFaces) largestFaces.push(f);
              facesByPrecinct.delete(sliverPi);
            }
          }
          // Per-face target sliver merge: if target has multiple disconnected
          // faces and some are below the threshold, reassign the tiny faces to
          // the largest non-target precinct's face group. Parent block stays
          // fully tiled — just a different precinct owns each tiny piece, so we
          // avoid emitting a target sub-block with artifact-prone micro parts.
          // The largest target face is always kept (it's the actual bridge).
          const targetFacesInit = facesByPrecinct.get(targetPi);
          if (targetFacesInit && targetFacesInit.length > 1) {
            // Find the largest non-target precinct (best candidate to absorb slivers)
            let absorbPi = -1;
            let absorbArea = 0;
            for (const [pi, a] of precinctAreas) {
              if (pi === targetPi) continue;
              if (!facesByPrecinct.has(pi)) continue; // already merged away
              if (a > absorbArea) {
                absorbArea = a;
                absorbPi = pi;
              }
            }
            if (absorbPi !== -1) {
              targetFacesInit.sort((a, b) => b.area - a.area);
              const keep: typeof targetFacesInit = [targetFacesInit[0]]; // always keep largest
              const reassign: typeof targetFacesInit = [];
              for (let i = 1; i < targetFacesInit.length; i++) {
                if (targetFacesInit[i].area < MIN_SUB_AREA_M2) reassign.push(targetFacesInit[i]);
                else keep.push(targetFacesInit[i]);
              }
              if (reassign.length > 0) {
                const absorbFaces = facesByPrecinct.get(absorbPi)!;
                for (const f of reassign) absorbFaces.push(f);
                facesByPrecinct.set(targetPi, keep);
              }
            }
          }
          // Build a lookup of the parent block's exact vertex coords so we can
          // snap sub-block vertices to them. GEOS polygonize inside nodeAndSplit
          // drifts coords by ~1 ULP relative to the parent's reprojection-only
          // path; the resulting float mismatch breaks topojson's shared-junction
          // detection at the county layer and leaves degenerate "spike" holes.
          // Key granularity is 0.1 µm — orders of magnitude above ULP (~0.1 nm at
          // UTM easting magnitudes), orders of magnitude below any real vertex
          // separation, so collisions are impossible.
          const parentGeomForSnap = blockFeatures[splitBi].geometry as Polygon | MultiPolygon;
          const parentVertMap = new Map<string, number[]>();
          const pPolysSnap =
            parentGeomForSnap.type === "Polygon"
              ? [parentGeomForSnap.coordinates]
              : parentGeomForSnap.coordinates;
          for (const poly of pPolysSnap) {
            for (const ring of poly) {
              for (const v of ring) {
                parentVertMap.set(`${Math.round(v[0] * 1e7)},${Math.round(v[1] * 1e7)}`, v);
              }
            }
          }
          // Signed shoelace area (used to test whether an inner spike loop is
          // zero-area noise or a real sub-polygon).
          const ringSignedArea = (r: number[][]): number => {
            let a = 0;
            for (let i = 0, n = r.length - 1; i < n; i++) {
              a += r[i][0] * r[i + 1][1] - r[i + 1][0] * r[i][1];
            }
            return a / 2;
          };

          const snapRing = (ring: number[][]): number[][] => {
            let snapped = ring.map(v => {
              const k = `${Math.round(v[0] * 1e7)},${Math.round(v[1] * 1e7)}`;
              return parentVertMap.get(k) ?? v;
            });
            // Pass 1: drop consecutive duplicates (introduced when snap collapses
            // multiple GEOS-drifted verts onto one parent vertex).
            const dedup: number[][] = [snapped[0]];
            for (let i = 1; i < snapped.length; i++) {
              const prev = dedup[dedup.length - 1];
              if (snapped[i][0] !== prev[0] || snapped[i][1] !== prev[1]) dedup.push(snapped[i]);
            }
            // Pass 2: remove zero-width spikes. When a precinct cut coincides with
            // a parent block boundary edge, polygonize emits the adjacent face
            // with a self-touching outer ring like ...X, B, A, B, Y... — the
            // ring dips out to A and comes back to B with zero enclosed area.
            // Detect non-consecutive duplicate vertices, and if the loop between
            // them has near-zero signed area, splice it out. Iterate because
            // there can be nested spikes.
            snapped = dedup;
            while (true) {
              const seen = new Map<string, number>();
              let pinchStart = -1;
              let pinchEnd = -1;
              for (let i = 0; i < snapped.length - 1; i++) {
                const key = `${snapped[i][0]},${snapped[i][1]}`;
                const prev = seen.get(key);
                if (prev !== undefined && i - prev > 1) {
                  pinchStart = prev;
                  pinchEnd = i;
                  break;
                }
                seen.set(key, i);
              }
              if (pinchStart < 0) break;
              const inner = snapped.slice(pinchStart, pinchEnd + 1);
              if (Math.abs(ringSignedArea(inner)) > 1e-6) {
                // Non-zero-area loop — topology-preserving, don't splice out.
                // We could emit as a separate polygon here, but haven't seen a
                // real case yet; log and bail on the splice.
                break;
              }
              snapped = [...snapped.slice(0, pinchStart + 1), ...snapped.slice(pinchEnd + 1)];
            }
            // Pass 3: drop collinear overshoot vertices. Pattern is ...A, B, C...
            // where C lies strictly between A and B on line A-B — the ring walks
            // past C to B then backtracks to C. GEOS polygonize emits this when a
            // precinct-cut vertex is collinear with a parent-edge segment and the
            // noder doesn't split at it. Neighbors visit the same 4 verts in the
            // topologically correct order ...A, C, B..., so under topojson's
            // per-arc dedup the two sides don't match and the county boundary
            // gets a tiny spurious hole. Dropping B makes the sub-block's order
            // match the neighbor's (...A, C, next).
            let overshootChanged = true;
            while (overshootChanged) {
              overshootChanged = false;
              for (let i = 0; i + 2 < snapped.length; i++) {
                const a = snapped[i];
                const b = snapped[i + 1];
                const c = snapped[i + 2];
                const cross = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
                if (Math.abs(cross) > 1e-14) continue;
                const dx = b[0] - a[0];
                const dy = b[1] - a[1];
                if (dx === 0 && dy === 0) continue;
                const t = Math.abs(dx) > Math.abs(dy) ? (c[0] - a[0]) / dx : (c[1] - a[1]) / dy;
                if (t > 1e-9 && t < 1 - 1e-9) {
                  snapped.splice(i + 1, 1);
                  overshootChanged = true;
                  break;
                }
              }
            }
            // Ring must close — if closure dropped, restore.
            if (snapped.length < 4) return snapped;
            const first = snapped[0];
            const last = snapped[snapped.length - 1];
            if (first[0] !== last[0] || first[1] !== last[1]) snapped.push(first);
            return snapped;
          };

          // Convert all face GEOS geoms to snapped GeoJSON upfront — we need the
          // target's geometry for the verification check below before we decide
          // whether to commit, and if we skip, we need to free the GEOS handles.
          type SnappedFace = { polys: number[][][][]; area: number };
          const facesGjByPrecinct = new Map<number, SnappedFace>();
          for (const [pi, pFaces] of facesByPrecinct) {
            const polys: number[][][][] = [];
            let area = 0;
            for (const f of pFaces) {
              const gj = geosHelper.toGeoJSON(f.geom);
              geosHelper.free(f.geom);
              if (!gj) continue;
              const snapPoly = (poly: number[][][]): number[][][] => poly.map(snapRing);
              if (gj.type === "Polygon") polys.push(snapPoly(gj.coordinates));
              else for (const p of gj.coordinates) polys.push(snapPoly(p));
              area += f.area;
            }
            if (polys.length > 0) facesGjByPrecinct.set(pi, { polys, area });
          }

          // Cross-sibling vertex unification. snapRing handles verts that match a
          // parent vertex, but sub-blocks often share GEOS-computed verts (new
          // intersection points where precinct cuts hit parent boundary) that
          // aren't parent verts. GEOS can emit 1-ULP-apart floats for the same
          // geometric point in different faces; if siblings get different floats
          // for a shared vert, their mutual cut boundary arc won't dedupe in
          // topojson. Collapse to a single canonical value per 0.1 µm bucket.
          {
            const crossSibMap = new Map<string, number[]>();
            for (const [, bundle] of facesGjByPrecinct) {
              for (const poly of bundle.polys) {
                for (const ring of poly) {
                  for (const v of ring) {
                    const k = `${Math.round(v[0] * 1e7)},${Math.round(v[1] * 1e7)}`;
                    if (!crossSibMap.has(k)) crossSibMap.set(k, v);
                  }
                }
              }
            }
            for (const [, bundle] of facesGjByPrecinct) {
              for (const poly of bundle.polys) {
                for (let ri = 0; ri < poly.length; ri++) {
                  poly[ri] = poly[ri].map(v => {
                    const k = `${Math.round(v[0] * 1e7)},${Math.round(v[1] * 1e7)}`;
                    return crossSibMap.get(k) ?? v;
                  });
                }
              }
            }
          }

          // ── Verify the rescue actually helps the target precinct's topology ──
          // Count target precinct's current connected components (with splitBi
          // removed from its own blocks — it's assigned to previousAssignee, not
          // target — and with prior-rescue sub-blocks included). Then count the
          // components we'd have after adding the target's proposed sub-block.
          // A rescue only makes sense if:
          //  • orphan: always (adds the first piece)
          //  • fragmented (assigned > vest): after-count < before-count (bridges)
          //  • lost-pieces (assigned < vest): after-count > before-count (adds)
          // Otherwise the rescue is just adding complexity — its sub-blocks cause
          // the kind of topojson arc-dedup artifacts we've been tracking without
          // improving the topology it was meant to restore.
          const targetFaceBundle = facesGjByPrecinct.get(targetPi);
          if (!targetFaceBundle) {
            // nodeAndSplit didn't emit a face for the target — nothing to verify
            // or commit; fall through to skip without counting as unnecessary.
            continue;
          }
          // Candidate gate: target's *largest part* must be ≥ threshold. Total
          // area would be misleading if it's dominated by a big part plus
          // artifact-prone slivers. Require at least one meaningfully-sized
          // bridge piece to justify the split.
          //
          // Exception for orphan rescues: the target currently has ZERO blocks.
          // If we reject all candidates, the precinct vanishes entirely from the
          // output — worse than keeping a sliver-sized sub-block. Orphans bypass
          // both this gate and the sibling-double-edge check below.
          const MIN_TARGET_PART_M2 = 100;
          const isOrphan = rescue.reason === "orphan";
          let targetLargestPartArea = 0;
          for (const poly of targetFaceBundle.polys) {
            const partArea = Math.abs(ringSignedArea(poly[0]));
            if (partArea > targetLargestPartArea) targetLargestPartArea = partArea;
          }
          if (!isOrphan && targetLargestPartArea < MIN_TARGET_PART_M2) {
            tinyTargetRejections++;
            rejectedCands.add(splitBi); // deterministic — won't help in later greedy iters
            continue;
          }
          const targetSubGeom: Polygon | MultiPolygon =
            targetFaceBundle.polys.length === 1
              ? { type: "Polygon", coordinates: targetFaceBundle.polys[0] }
              : { type: "MultiPolygon", coordinates: targetFaceBundle.polys };
          const currentTargetGeoms: (Polygon | MultiPolygon)[] = [];
          const targetBlockIdxs = blocksByPrecinct.get(targetPi) || [];
          for (const bi of targetBlockIdxs) {
            if (bi === splitBi) continue;
            if (splitParents.has(bi)) continue; // already split by a prior rescue
            const g = blockFeatures[bi].geometry as Polygon | MultiPolygon | null;
            if (g) currentTargetGeoms.push(g);
          }
          for (const sb of subBlocks) {
            if (sb.precinctIdx === targetPi) currentTargetGeoms.push(sb.geom);
          }
          const compBefore = countComponents(currentTargetGeoms);
          const compAfter = countComponents([...currentTargetGeoms, targetSubGeom]);
          const rescueHelps =
            rescue.reason === "orphan" ||
            (rescue.reason === "fragmented" && compAfter < compBefore) ||
            (rescue.reason === "lost-pieces" && compAfter > compBefore);
          if (!rescueHelps) {
            continue; // try next candidate
          }

          // ── Sibling-double-edge check ──
          // Siblings legitimately share their mutual precinct-cut boundary (their
          // interior shared edge, traversed in opposite directions). But they
          // should NEVER both include a segment of the *parent's outer boundary*
          // in their rings — when a precinct cut runs near-coincident with a
          // parent block edge, polygonize can emit both siblings claiming that
          // edge, which later causes topojson arc-dedup to leave degenerate
          // spike holes in the dissolved county boundary.
          //
          // Detection: collect shared segments across sibling pairs, then filter
          // to those lying on the parent outer boundary (collinear with a parent
          // ring segment, strictly between its endpoints — so subdivided parent
          // edges are caught too). If any shared segment is parent-lying, reject.
          {
            const canonSeg = (a: number[], b: number[]): string => {
              if (a[0] < b[0] || (a[0] === b[0] && a[1] < b[1])) {
                return `${a[0]},${a[1]}|${b[0]},${b[1]}`;
              }
              return `${b[0]},${b[1]}|${a[0]},${a[1]}`;
            };
            // Build per-sibling segment sets (each keyed by canonSeg).
            const siblingSegs: { set: Set<string>; segs: [number[], number[]][] }[] = [];
            for (const [, bundle] of facesGjByPrecinct) {
              const set = new Set<string>();
              const segs: [number[], number[]][] = [];
              for (const poly of bundle.polys) {
                for (const ring of poly) {
                  for (let i = 0; i < ring.length - 1; i++) {
                    const k = canonSeg(ring[i], ring[i + 1]);
                    if (!set.has(k)) {
                      set.add(k);
                      segs.push([ring[i], ring[i + 1]]);
                    }
                  }
                }
              }
              siblingSegs.push({ set, segs });
            }
            // Find segments that appear in 2+ siblings.
            const sharedKeys = new Set<string>();
            for (let i = 0; i < siblingSegs.length; i++) {
              for (let j = i + 1; j < siblingSegs.length; j++) {
                for (const k of siblingSegs[i].set) {
                  if (siblingSegs[j].set.has(k)) sharedKeys.add(k);
                }
              }
            }
            // Parent outer-boundary segments (for the collinearity check).
            const parentSegs: [number[], number[]][] = [];
            for (const poly of pPolysSnap) {
              for (const ring of poly) {
                for (let i = 0; i < ring.length - 1; i++) parentSegs.push([ring[i], ring[i + 1]]);
              }
            }
            // Is point p on (or nearly on) the closed segment a→b? We use
            // perpendicular-distance tolerance (|cross|/seg_length ≤ 5 mm), not a
            // fixed cross tolerance, because GEOS's computed intersection points
            // can drift up to a few mm off the true line — the drift is bigger
            // on longer parent segments, so we need a per-segment normalized
            // tolerance. 5 mm is well below TIGER's ~10 cm vertex spacing (no
            // false positives on distinct legit verts) and comfortably above
            // GEOS's precision-model drift observed in real data (~2 mm max).
            const MAX_PERP_M = 0.005;
            const pointOnParentSeg = (p: number[], a: number[], b: number[]): boolean => {
              const dx = b[0] - a[0];
              const dy = b[1] - a[1];
              const segLenSq = dx * dx + dy * dy;
              if (segLenSq === 0) return false;
              const cross = (p[0] - a[0]) * dy - (p[1] - a[1]) * dx;
              if (cross * cross > MAX_PERP_M * MAX_PERP_M * segLenSq) return false;
              const t = Math.abs(dx) > Math.abs(dy) ? (p[0] - a[0]) / dx : (p[1] - a[1]) / dy;
              return t >= -1e-9 && t <= 1 + 1e-9;
            };
            // For each shared segment, check if BOTH its endpoints lie on the
            // parent ring path (any parent segment, not necessarily the same).
            // The legitimate shared-segment case (precinct cut between siblings)
            // has interior endpoints not on ∂P; the bug case has both endpoints
            // on ∂P (one typically at a parent corner, the other at a cut ∩ ∂P
            // intersection point which sits on a parent segment).
            // Minor concern: interior cuts that go vertex-to-vertex through the
            // parent interior would also match (both endpoints are parent corners).
            // That's rare and, if it does happen, rejecting the rescue and trying
            // the next candidate is a safe conservative response.
            const pointOnAnyParentSeg = (pt: number[]): boolean => {
              for (const [p, q] of parentSegs) {
                if (pointOnParentSeg(pt, p, q)) return true;
              }
              return false;
            };
            const checkedKeys = new Set<string>();
            let doubledParentEdge = false;
            outer: for (const sib of siblingSegs) {
              for (const [a, b] of sib.segs) {
                const key = canonSeg(a, b);
                if (!sharedKeys.has(key) || checkedKeys.has(key)) continue;
                checkedKeys.add(key);
                if (pointOnAnyParentSeg(a) && pointOnAnyParentSeg(b)) {
                  doubledParentEdge = true;
                  break outer;
                }
              }
            }
            // DEBUG: log decision for the specific parents that produced holes
            // in recent runs — helps verify whether check is firing correctly.
            const debugBlocks = new Set([
              "010199557012006",
              "010330208012007",
              "010259579022002",
              "010259579012014"
            ]);
            if (debugBlocks.has(splitGeoId)) {
              this.log(
                `   DEBUG ${splitGeoId} (target=${targetPi}, cand=${candIdx}): sharedKeys=${sharedKeys.size}, doubledParentEdge=${doubledParentEdge}, parentSegs=${parentSegs.length}`
              );
              // Helper: min cross-product magnitude from pt to any parent seg.
              const minCrossToParent = (pt: number[]): number => {
                let min = Infinity;
                for (const [p, q] of parentSegs) {
                  const cross = (pt[0] - p[0]) * (q[1] - p[1]) - (pt[1] - p[1]) * (q[0] - p[0]);
                  const abs = Math.abs(cross);
                  if (abs < min) min = abs;
                }
                return min;
              };
              const reported = new Set<string>();
              for (const sib of siblingSegs) {
                for (const [a, b] of sib.segs) {
                  const key = canonSeg(a, b);
                  if (!sharedKeys.has(key) || reported.has(key)) continue;
                  reported.add(key);
                  const aOnParent = pointOnAnyParentSeg(a);
                  const bOnParent = pointOnAnyParentSeg(b);
                  if (!aOnParent && !bOnParent) continue;
                  const aCross = minCrossToParent(a);
                  const bCross = minCrossToParent(b);
                  this.log(
                    `     shared seg [${a[0].toFixed(3)},${a[1].toFixed(3)}]→[${b[0].toFixed(3)},${b[1].toFixed(3)}] aOnParent=${aOnParent}(minCross=${aCross.toExponential(2)}) bOnParent=${bOnParent}(minCross=${bCross.toExponential(2)})`
                  );
                }
              }
            }
            // Orphans bypass this gate too — see comment on MIN_TARGET_PART_M2.
            if (doubledParentEdge && !isOrphan) {
              doubledEdgeRescues++;
              rejectedCands.add(splitBi); // deterministic rejection; don't retry in greedy
              continue; // try next candidate
            }
          }

          // ── Per-sibling parent-ring-path check ──
          // For each sibling's outer ring, for each pair of consecutive parent-
          // vertices in that ring, the parent ring path between them must be
          // fully represented in the sibling's ring (all intermediate parent
          // verts present, in order). If sub-block ring has Q → MID → R but
          // parent ring has Q → P → R, the sub-block skipped P and leaves
          // triangle Q-P-R unassigned → county-layer artifact hole.
          //
          // Direction detection: between two parent verts, there are two
          // parent-ring paths (forward and reverse around the cyclic ring).
          // The sub-block follows ONE of them (or takes an interior cut, with
          // no intermediate parent verts on the path it's actually following).
          // We pick the direction with FEWER intermediate parent verts as the
          // hypothesis. If even that shorter path has a parent vert the
          // sub-block is missing, reject.
          //
          // Orphans bypass this check.
          if (!isOrphan) {
            const parentOuterRing = pPolysSnap[0]?.[0];
            if (parentOuterRing && parentOuterRing.length > 3) {
              // Build index of parent outer ring verts by coord key (0.1 µm)
              const parentVertIdx = new Map<string, number>();
              const parentLen = parentOuterRing.length - 1; // exclude closing dup
              for (let i = 0; i < parentLen; i++) {
                const v = parentOuterRing[i];
                const key = `${Math.round(v[0] * 1e7)},${Math.round(v[1] * 1e7)}`;
                if (!parentVertIdx.has(key)) parentVertIdx.set(key, i);
              }
              let missingOnPath = false;
              outerSib: for (const [, bundle] of facesGjByPrecinct) {
                for (const poly of bundle.polys) {
                  const ring = poly[0];
                  if (!ring || ring.length < 4) continue;
                  // Sub-block ring verts with parent-ring positions
                  const pvHits: { ringPos: number; parentPos: number; key: string }[] = [];
                  for (let i = 0; i < ring.length - 1; i++) {
                    const v = ring[i];
                    const key = `${Math.round(v[0] * 1e7)},${Math.round(v[1] * 1e7)}`;
                    const pi = parentVertIdx.get(key);
                    if (pi !== undefined) pvHits.push({ ringPos: i, parentPos: pi, key });
                  }
                  if (pvHits.length < 2) continue;
                  // Build set of sibling ring vert-keys for quick membership tests
                  const ringKeys = new Set<string>();
                  for (let i = 0; i < ring.length - 1; i++) {
                    const v = ring[i];
                    ringKeys.add(`${Math.round(v[0] * 1e7)},${Math.round(v[1] * 1e7)}`);
                  }
                  // For each consecutive pair of parent-vert occurrences (cyclic)
                  for (let k = 0; k < pvHits.length; k++) {
                    const A = pvHits[k];
                    const B = pvHits[(k + 1) % pvHits.length];
                    if (A.parentPos === B.parentPos) continue;
                    // Gather parent verts on FWD and REV paths
                    const fwd: number[][] = [];
                    for (
                      let i = (A.parentPos + 1) % parentLen;
                      i !== B.parentPos;
                      i = (i + 1) % parentLen
                    ) {
                      fwd.push(parentOuterRing[i]);
                      if (fwd.length > parentLen) break;
                    }
                    const rev: number[][] = [];
                    for (
                      let i = (A.parentPos - 1 + parentLen) % parentLen;
                      i !== B.parentPos;
                      i = (i - 1 + parentLen) % parentLen
                    ) {
                      rev.push(parentOuterRing[i]);
                      if (rev.length > parentLen) break;
                    }
                    // Sub-block's between-verts (exclusive of A, B)
                    const subBetweenKeys = new Set<string>();
                    if (A.ringPos < B.ringPos) {
                      for (let m = A.ringPos + 1; m < B.ringPos; m++) {
                        const v = ring[m];
                        subBetweenKeys.add(`${Math.round(v[0] * 1e7)},${Math.round(v[1] * 1e7)}`);
                      }
                    } else {
                      for (let m = A.ringPos + 1; m < ring.length - 1; m++) {
                        const v = ring[m];
                        subBetweenKeys.add(`${Math.round(v[0] * 1e7)},${Math.round(v[1] * 1e7)}`);
                      }
                      for (let m = 0; m < B.ringPos; m++) {
                        const v = ring[m];
                        subBetweenKeys.add(`${Math.round(v[0] * 1e7)},${Math.round(v[1] * 1e7)}`);
                      }
                    }
                    // Determine which parent-ring direction the sibling is
                    // tracing: whichever path has MORE of its verts present in
                    // sub-block's between-range. "Shorter path" is the wrong
                    // heuristic — for sub-blocks that cover most of the parent,
                    // the sibling traces the LONG way, and verts on the short
                    // path legitimately belong to another sibling.
                    const countMatches = (path: number[][]) =>
                      path.filter(v =>
                        subBetweenKeys.has(`${Math.round(v[0] * 1e7)},${Math.round(v[1] * 1e7)}`)
                      ).length;
                    const fwdMatches = countMatches(fwd);
                    const revMatches = countMatches(rev);
                    const actual = fwdMatches >= revMatches ? fwd : rev;
                    // If any parent vert on the actual traversed path is NOT
                    // between A and B in sub-block ring, sub-block skipped it.
                    for (const pv of actual) {
                      const pkey = `${Math.round(pv[0] * 1e7)},${Math.round(pv[1] * 1e7)}`;
                      if (!subBetweenKeys.has(pkey)) {
                        missingOnPath = true;
                        break outerSib;
                      }
                    }
                  }
                }
              }
              if (missingOnPath) {
                missingParentVertRescues++;
                rejectedCands.add(splitBi);
                continue; // try next candidate
              }
            }
          }

          let subIdx = 0;
          for (const [pi, bundle] of facesGjByPrecinct) {
            subIdx++;
            const subBlockId = `${splitGeoId}-${subIdx}`;
            const areaShare = bundle.area / totalSubArea;
            if (bundle.polys.length === 0) continue;
            const subGeom: Polygon | MultiPolygon =
              bundle.polys.length === 1
                ? { type: "Polygon", coordinates: bundle.polys[0] }
                : { type: "MultiPolygon", coordinates: bundle.polys };
            subBlocks.push({
              parentBlockIdx: splitBi,
              subBlockId,
              geom: subGeom,
              precinctIdx: pi,
              areaShare
            });
            coveredByRescue.add(pi);
          }
          // Keep blocksByPrecinct current so subsequent rescues see the
          // post-commit state: splitBi is no longer whole-assigned to anyone.
          const prevAssigneeBlocks = blocksByPrecinct.get(previousAssignee);
          if (prevAssigneeBlocks) {
            const idx = prevAssigneeBlocks.indexOf(splitBi);
            if (idx >= 0) prevAssigneeBlocks.splice(idx, 1);
          }
          splitParents.add(splitBi);
          assignment.delete(splitBi);
          thisRescueSplits.push(splitBi);
          madeProgress = true;
          break; // back to greedy while loop for next iteration
        }
        if (!madeProgress) break greedy; // no helpful candidate; stop
      }
      if (thisRescueSplits.length === 0) {
        unnecessaryRescues++;
      } else if (thisRescueSplits.length > 1) {
        multiSplitRescues++;
        // Phase 3 (report-only): is any committed split redundant — i.e.,
        // could we drop its target-sub-block and still match vestN? Greedy
        // shouldn't commit redundant splits (each must improve component
        // count), so a non-zero count here would signal a logic bug.
        // Reverting is complex because one split produces sub-blocks for
        // multiple precincts (target + byproducts); so just report.
        const finalTargetGeoms: (Polygon | MultiPolygon)[] = [];
        for (const bi of blocksByPrecinct.get(targetPi) || []) {
          if (splitParents.has(bi)) continue;
          const g = blockFeatures[bi].geometry as Polygon | MultiPolygon | null;
          if (g) finalTargetGeoms.push(g);
        }
        const targetSubByParent = new Map<number, Polygon | MultiPolygon>();
        for (const sb of subBlocks) {
          if (sb.precinctIdx !== targetPi) continue;
          finalTargetGeoms.push(sb.geom);
          if (thisRescueSplits.includes(sb.parentBlockIdx)) {
            targetSubByParent.set(sb.parentBlockIdx, sb.geom);
          }
        }
        const finalComp = countComponents(finalTargetGeoms);
        for (const splitBi of thisRescueSplits) {
          const sbGeom = targetSubByParent.get(splitBi);
          if (!sbGeom) continue;
          const without = finalTargetGeoms.filter(g => g !== sbGeom);
          if (countComponents(without) === finalComp) redundantSplitsDetected++;
        }
      }
    }
    this.log(
      `   Produced ${subBlocks.length} sub-block(s) from ${splitParents.size} parent block(s)` +
        (silentlySkipped > 0
          ? ` (${silentlySkipped} skipped: target covered by prior rescue)`
          : "") +
        (unnecessaryRescues > 0
          ? ` (${unnecessaryRescues} skipped: no candidate improved target's component count)`
          : "") +
        (multiSplitRescues > 0
          ? ` (${multiSplitRescues} rescues needed >1 split to reach vestN)`
          : "") +
        (doubledEdgeRescues > 0
          ? ` (${doubledEdgeRescues} candidate rejections: would double-claim parent boundary)`
          : "") +
        (tinyTargetRejections > 0
          ? ` (${tinyTargetRejections} candidate rejections: target sub-block's largest part < ${100} m²)`
          : "") +
        (missingParentVertRescues > 0
          ? ` (${missingParentVertRescues} candidate rejections: some parent vertex missing from all siblings)`
          : "") +
        (redundantSplitsDetected > 0
          ? ` (${redundantSplitsDetected} redundant splits detected — logic bug)`
          : "")
    );

    // ── Step 7.5: Patch neighbor blocks with sub-block intersection vertices ──
    // When nodeAndSplit produces sub-blocks, their outer rings carry new
    // vertices where precinct boundaries crossed the parent block's edge.
    // These vertices ARE shared with the adjacent (un-split) TIGER neighbor
    // on the other side of that parent edge, but the neighbor's ring doesn't
    // contain them. After topojson's arc-sharing + quantization, the
    // mismatch shows up as m²-scale gaps/overlaps between the sub-blocks
    // and that neighbor. Insert each new vertex into the matching neighbor
    // ring so the shared edge has matching vertex sequences on both sides.
    this.log("\n7.5. Patching neighbor blocks with sub-block intersection vertices...");
    {
      const COLLINEAR_EPS = 0.01; // 1cm² cross product in local meters
      // Parametric t for point p on segment a→b, using whichever axis has
      // more extent (avoids /0 for vertical/horizontal segments).
      const paramT = (p: number[], a: number[], b: number[]): number => {
        const dx = b[0] - a[0];
        const dy = b[1] - a[1];
        return Math.abs(dx) > Math.abs(dy) ? (p[0] - a[0]) / dx : (p[1] - a[1]) / dy;
      };
      // Returns t if p lies strictly between a and b on a straight line, else -1.
      const pointOnSegment = (p: number[], a: number[], b: number[]): number => {
        const cross = (p[0] - a[0]) * (b[1] - a[1]) - (p[1] - a[1]) * (b[0] - a[0]);
        if (Math.abs(cross) > COLLINEAR_EPS) return -1;
        const t = paramT(p, a, b);
        return t > 1e-9 && t < 1 - 1e-9 ? t : -1;
      };

      // Group sub-blocks by their parent so we can collect all
      // intersection vertices per parent in one pass.
      const subsByParent = new Map<number, SubBlock[]>();
      for (const sb of subBlocks) {
        let arr = subsByParent.get(sb.parentBlockIdx);
        if (!arr) {
          arr = [];
          subsByParent.set(sb.parentBlockIdx, arr);
        }
        arr.push(sb);
      }

      // Accumulate insertions: neighborIdx → edgeKey → array of points (in
      // local CRS). Dedup within each edge to avoid double-insertion when
      // multiple siblings share the same intersection point.
      const patchesByNeighbor = new Map<number, Map<string, number[][]>>();

      for (const [parentIdx, sibs] of subsByParent) {
        const parentGeom = blockFeatures[parentIdx].geometry;
        if (!parentGeom) continue;
        // Collect parent's original outer-ring vertex set + its segments.
        const pVerts = new Set<string>();
        const pSegs: Array<[number[], number[]]> = [];
        const pPolys =
          parentGeom.type === "Polygon"
            ? [parentGeom.coordinates]
            : (parentGeom as MultiPolygon).coordinates;
        for (const poly of pPolys) {
          for (const ring of poly) {
            for (const v of ring) pVerts.add(`${v[0]},${v[1]}`);
            for (let i = 0; i < ring.length - 1; i++) pSegs.push([ring[i], ring[i + 1]]);
          }
        }

        // Build a LOCAL edge → blocks map from only the bbox-nearby blocks.
        // A full global index would exceed V8's Map size cap for big states.
        // We only need to know which neighbor block shares any given parent
        // boundary edge; those neighbors are bbox-adjacent to the parent.
        const [pMinX, pMinY, pMaxX, pMaxY] = featureBbox(blockFeatures[parentIdx]);
        const localEdgeToBlocks = new Map<string, number[]>();
        const nearbyBlocks = blockTree.search({
          minX: pMinX,
          minY: pMinY,
          maxX: pMaxX,
          maxY: pMaxY
        });
        for (const nb of nearbyBlocks) {
          const bi = nb.index;
          if (bi === parentIdx) continue;
          const bg = blockFeatures[bi].geometry;
          if (!bg) continue;
          const bPolys =
            bg.type === "Polygon" ? [bg.coordinates] : (bg as MultiPolygon).coordinates;
          for (const poly of bPolys) {
            for (const ring of poly) {
              for (let i = 0; i < ring.length - 1; i++) {
                const k = canonEdgeKey(ring[i], ring[i + 1]);
                let arr = localEdgeToBlocks.get(k);
                if (!arr) {
                  arr = [];
                  localEdgeToBlocks.set(k, arr);
                }
                if (arr[arr.length - 1] !== bi) arr.push(bi);
              }
            }
          }
        }

        for (const sb of sibs) {
          const sbPolys = sb.geom.type === "Polygon" ? [sb.geom.coordinates] : sb.geom.coordinates;
          for (const poly of sbPolys) {
            for (const ring of poly) {
              for (const v of ring) {
                const key = `${v[0]},${v[1]}`;
                if (pVerts.has(key)) continue;
                // Vertex is NOT an original parent vertex — check if it
                // lies on one of the parent's outer-ring segments.
                for (const [a, b] of pSegs) {
                  if (pointOnSegment(v, a, b) < 0) continue;
                  const edgeKey = canonEdgeKey(a, b);
                  const blocksOnEdge = localEdgeToBlocks.get(edgeKey);
                  if (!blocksOnEdge) break;
                  for (const otherBi of blocksOnEdge) {
                    if (otherBi === parentIdx) continue;
                    let byEdge = patchesByNeighbor.get(otherBi);
                    if (!byEdge) {
                      byEdge = new Map();
                      patchesByNeighbor.set(otherBi, byEdge);
                    }
                    let arr = byEdge.get(edgeKey);
                    if (!arr) {
                      arr = [];
                      byEdge.set(edgeKey, arr);
                    }
                    // Coarse-key dedup (0.1 µm in local meters): when two
                    // sibling sub-blocks have near-duplicate floats for the
                    // same geometric vertex (different float reps of the same
                    // point emitted by GEOS in different faces), exact-float
                    // comparison lets both through and we end up inserting
                    // two 1-ULP-apart verts consecutively into the neighbor's
                    // ring. Rounded key collapses them to one.
                    const vKey = `${Math.round(v[0] * 1e7)},${Math.round(v[1] * 1e7)}`;
                    if (
                      !arr.some(p => `${Math.round(p[0] * 1e7)},${Math.round(p[1] * 1e7)}` === vKey)
                    ) {
                      arr.push(v);
                    }
                  }
                  break;
                }
              }
            }
          }
        }
      }

      // Apply patches — for each neighbor, rewrite its rings with the new
      // vertices inserted in parametric order along each affected segment.
      let patchedBlocks = 0;
      let insertedVerts = 0;
      for (const [nbrIdx, byEdge] of patchesByNeighbor) {
        const origGeom = blockFeatures[nbrIdx].geometry;
        if (!origGeom) continue;
        const rewriteRing = (ring: number[][]): number[][] => {
          const out: number[][] = [ring[0]];
          for (let i = 0; i < ring.length - 1; i++) {
            const a = ring[i];
            const b = ring[i + 1];
            const extras = byEdge.get(canonEdgeKey(a, b));
            if (extras && extras.length > 0) {
              const sorted = extras.map(x => ({ x, t: paramT(x, a, b) })).sort((p, q) => p.t - q.t);
              for (const e of sorted) {
                out.push(e.x);
                insertedVerts++;
              }
            }
            out.push(b);
          }
          return out;
        };
        let newGeom: Polygon | MultiPolygon;
        if (origGeom.type === "Polygon") {
          newGeom = {
            type: "Polygon",
            coordinates: origGeom.coordinates.map(rewriteRing)
          };
        } else {
          newGeom = {
            type: "MultiPolygon",
            coordinates: (origGeom as MultiPolygon).coordinates.map(poly => poly.map(rewriteRing))
          };
        }
        blockFeatures[nbrIdx] = { ...blockFeatures[nbrIdx], geometry: newGeom };
        patchedBlocks++;
      }
      this.log(
        `   Inserted ${insertedVerts} shared-edge vertices into ${patchedBlocks} neighbor blocks`
      );
    }

    // ── Step 8: Build output features ──
    // Stream geometries to a temp file (avoids in-memory peak for big states)
    // and keep properties in memory for primary-year reconciliation and the
    // additional-year spatial joins downstream.
    this.log("\n8. Building output features...");
    const outputPath = flags.output.replace("~", process.env.HOME || "");
    mkdirSync(dirname(outputPath), { recursive: true });
    const geomTempPath = outputPath + ".geomseq";
    const geomFd = require("fs").openSync(geomTempPath, "w"); // eslint-disable-line
    // writeSync on Linux returns a partial byte count for EINTR or when the
    // kernel chunks a large write; we must loop until the full buffer is
    // flushed or the temp file ends up with interleaved half-geometries
    // that crash JSON.parse during the final write-out.
    const writeAll = (s: string): void => {
      const buf = Buffer.from(s, "utf8");
      let off = 0;
      while (off < buf.length) off += writeSync(geomFd, buf, off, buf.length - off);
    };
    const featureProps: Record<string, any>[] = [];

    // Adjusted-population fields are state-specific; detect what's present.
    const adjFieldCandidates = [
      "adj_population",
      "adj_white",
      "adj_black",
      "adj_asian",
      "adj_hispanic",
      "adj_other"
    ];
    const firstDemo = blockDemographics.values().next().value;
    const adjFields = firstDemo ? adjFieldCandidates.filter(f => f in firstDemo) : [];
    if (adjFields.length > 0) this.log(`   Adjusted fields detected: ${adjFields.join(", ")}`);
    const demoKeys = [
      "population",
      "white",
      "black",
      "asian",
      "hispanic",
      "other",
      ...adjFields,
      "VAP",
      "VAP White",
      "VAP Black",
      "VAP Asian",
      "VAP Hispanic",
      "VAP Other",
      "VAP_MOD",
      "CVAP",
      "CVAP White",
      "CVAP Black",
      "CVAP Asian",
      "CVAP Hispanic",
      "CVAP Other"
    ];

    // Track per-precinct features for primary-year vote reconciliation.
    const primaryAssigned = new Map<
      number,
      Map<string, { featureIdx: number; weight: number }[]>
    >();
    const trackAssignment = (pi: number, fi: number, weight: number): void => {
      let officeMap = primaryAssigned.get(pi);
      if (!officeMap) {
        officeMap = new Map();
        primaryAssigned.set(pi, officeMap);
      }
      for (const office of officesFound) {
        let arr = officeMap.get(office);
        if (!arr) {
          arr = [];
          officeMap.set(office, arr);
        }
        arr.push({ featureIdx: fi, weight });
      }
    };

    const toWgsGeom = (
      g: Polygon | MultiPolygon | null | undefined
    ): Polygon | MultiPolygon | null => (g ? reprojectGeoJSONGeom(g, toWgs84) : null);

    // Whole-block features (everything in assignment except parents that were
    // split out for a rescue).
    for (const bi of validBlocks) {
      if (splitParents.has(bi)) continue;
      const pi = assignment.get(bi);
      if (pi === undefined) continue;
      const blockProps = blockFeatures[bi].properties as Record<string, any>;
      const geoId = blockProps.GEOID20 as string;
      const countyFp = blockProps.COUNTYFP20 as string;
      const demo = blockDemographics.get(geoId);
      if (!demo) continue;
      const pData = precinctVoting.get(pi)!;
      const props = buildBlockProps(
        geoId,
        pData.precinctId,
        pData.precinctName,
        countyFp,
        countyNames,
        demo,
        pData.votes,
        pData.totalVotes,
        officesFound,
        detectedYear
      );
      const wgsGeom = toWgsGeom(blockFeatures[bi].geometry as Polygon | MultiPolygon);
      writeAll(JSON.stringify(wgsGeom) + "\n");
      trackAssignment(pi, featureProps.length, demo.VAP_MOD || 0);
      featureProps.push(props);
    }

    // Sub-block features (rescue splits). Group by parent so apportion()
    // (largest-remainder) keeps Σ(sub demo) === parent demo per field — naive
    // independent rounding can drift the total by ±1 per field per parent.
    const subsByParent = new Map<number, SubBlock[]>();
    for (const sb of subBlocks) {
      let arr = subsByParent.get(sb.parentBlockIdx);
      if (!arr) {
        arr = [];
        subsByParent.set(sb.parentBlockIdx, arr);
      }
      arr.push(sb);
    }
    for (const [parentIdx, subs] of subsByParent) {
      const parentProps = blockFeatures[parentIdx].properties as Record<string, any>;
      const parentGeoId = parentProps.GEOID20 as string;
      const countyFp = parentProps.COUNTYFP20 as string;
      const parentDemo = blockDemographics.get(parentGeoId);
      if (!parentDemo) continue;
      const ratios = subs.map(s => s.areaShare);
      const apportioned: Record<string, number[]> = {};
      for (const k of demoKeys) apportioned[k] = apportion(parentDemo[k] || 0, ratios);
      for (let i = 0; i < subs.length; i++) {
        const sb = subs[i];
        const subDemo: Record<string, number> = {};
        for (const k of demoKeys) subDemo[k] = apportioned[k][i];
        const pData = precinctVoting.get(sb.precinctIdx)!;
        const props = buildBlockProps(
          sb.subBlockId,
          pData.precinctId,
          pData.precinctName,
          countyFp,
          countyNames,
          subDemo,
          pData.votes,
          pData.totalVotes,
          officesFound,
          detectedYear
        );
        const wgsGeom = toWgsGeom(sb.geom);
        writeAll(JSON.stringify(wgsGeom) + "\n");
        trackAssignment(sb.precinctIdx, featureProps.length, subDemo.VAP_MOD || 0);
        featureProps.push(props);
      }
    }
    require("fs").closeSync(geomFd); // eslint-disable-line

    // Reconcile primary-year votes against precinct totals (absorbs rounding
    // residuals from per-capita disaggregation).
    const primaryReconciled = reconcilePrecinctVotes(
      primaryAssigned,
      (pi: number) => precinctVoting.get(pi)!.votes,
      (idx, field) => featureProps[idx][field] || 0,
      (idx, field, value) => {
        featureProps[idx][field] = value;
      },
      detectedYear
    );
    this.log(`   Reconciled ${primaryReconciled} precinct-party totals (primary year)`);

    // Capture this before we clear vestFeatures for the precinct-survival check.
    const vestPrecinctCount = vestFeatures.length;

    // Free GEOS geometries before addVotingYear (which allocates more); keep
    // the helper alive so we don't re-register koffi types (segfaults).
    for (const g of blockGeoms) if (g) geosHelper.free(g);
    for (const g of precinctGeoms) if (g) geosHelper.free(g);
    blockFeatures.length = 0;
    vestFeatures.length = 0;
    blockDemographics.clear();
    precinctVoting.clear();
    primaryAssigned.clear();

    // Force glibc to release freed native pages back to the OS — without this
    // it holds onto multi-GB of GEOS heap.
    try {
      const libc = require("koffi").load("libc.so.6"); // eslint-disable-line
      const mallocTrim = libc.func("malloc_trim", "int", ["int"]);
      mallocTrim(0);
    } catch {
      /* non-critical */
    }

    this.log(`\n   Whole-block features: ${assignment.size}`);
    this.log(`   Sub-block features:   ${subBlocks.length}`);
    this.log(`   Total features:       ${featureProps.length}`);

    // Sanity check: every VEST precinct must survive to output.
    {
      const distinct = new Set(featureProps.map(p => p.precinct)).size;
      this.log(`   Distinct output precincts: ${distinct} / ${vestPrecinctCount} VEST`);
      if (distinct < vestPrecinctCount) {
        this.error(
          `Only ${distinct} of ${vestPrecinctCount} VEST precincts survived to output. ` +
            `This usually means --vestPrecinctField="${flags.vestPrecinctField}" is not unique enough ` +
            `to disambiguate VEST rows (even combined with county prefix). ` +
            `Inspect the VEST shapefile's DBF fields and pick one that has roughly one distinct value per row.`
        );
      }
    }

    // ── Step 5: Process additional election years ──
    // addVotingYear now works with the properties array (no geometry needed
    // for the reconciliation step). Geometry is read from disk on-demand
    // for the spatial join.
    if (flags.additionalVest) {
      const additionalPairs = flags.additionalVest
        .split(",")
        .filter(s => s.includes(":"))
        .map(s => {
          const idx = s.indexOf(":");
          return { precinctField: s.substring(0, idx), path: s.substring(idx + 1) };
        });

      for (const { precinctField: addPrecinctField, path: addVestPath } of additionalPairs) {
        await this.addVotingYear(
          featureProps,
          geomTempPath,
          addVestPath.replace("~", process.env.HOME || ""),
          addPrecinctField,
          tmp,
          geosHelper
        );
      }
    }

    geosHelper.destroy();

    // ── Step 6: Reassemble and write final output ──
    this.log(`\nWriting ${featureProps.length} features to ${outputPath}...`);
    const outStream = createWriteStream(outputPath);
    outStream.write('{"type":"FeatureCollection","features":[\n');
    const geomRL = createInterface({
      input: createReadStream(geomTempPath),
      crlfDelay: Infinity
    });
    let featureIdx = 0;
    for await (const line of geomRL) {
      if (!line.trim()) {
        featureIdx++;
        continue;
      }
      const geometry = JSON.parse(line);
      const feature = { type: "Feature", geometry, properties: featureProps[featureIdx] };
      if (featureIdx > 0) outStream.write(",\n");
      outStream.write(JSON.stringify(feature));
      featureIdx++;
    }
    outStream.write("\n]}");
    await new Promise<void>((resolve, reject) => {
      outStream.on("finish", resolve);
      outStream.on("error", reject);
      outStream.end();
    });
    // Clean up temp file
    require("fs").unlinkSync(geomTempPath); // eslint-disable-line
    const { statSync: statSyncFn } = require("fs"); // eslint-disable-line
    const fileSizeMB = (statSyncFn(outputPath).size / 1024 / 1024).toFixed(1);
    this.log(`Wrote ${fileSizeMB}MB`);

    const totalPop = featureProps.reduce((sum, p) => sum + (p.population || 0), 0);
    const counties = new Set(featureProps.map(p => p.county));
    const precincts = new Set(featureProps.map(p => p.precinct));
    this.log(`\nSummary:`);
    this.log(`  Population: ${totalPop.toLocaleString()}`);
    this.log(`  Counties: ${counties.size}`);
    this.log(`  Precincts: ${precincts.size}`);
    this.log(`  Features: ${featureProps.length}`);
    this.log(`  Offices: ${Array.from(officesFound).sort().join(", ")}`);
  }

  /**
   * Add voting data from an additional election year to existing output features.
   * Does a full spatial join against the additional year's VEST precincts,
   * blending per-capita voting rates by area overlap for straddling blocks.
   */
  async addVotingYear(
    featureProps: Record<string, any>[],
    geomTempPath: string,
    vestZipPath: string,
    precinctField: string,
    tmpDir: string,
    geosHelper: GeosHelper
  ): Promise<void> {
    this.log(`\n── Adding voting year from ${vestZipPath} ──`);

    // Load VEST shapefile
    const vestBuffer = readFileSync(vestZipPath);
    const vestDir = join(tmpDir, `vest-add-${Date.now()}`);
    await extractZipToDir(vestBuffer, vestDir);
    const { shpPath: vestShp, dbfPath: vestDbf, prjPath: vestPrj } = findShapefile(vestDir);
    let vestFeatures = await readShapefile(vestShp, vestDbf);
    this.log(`   ${vestFeatures.length} precincts loaded (${vestShp})`);

    // Reproject if needed
    if (vestPrj) {
      const prjContent = readFileSync(vestPrj, "utf-8").trim();
      if (prjContent.startsWith("PROJCS")) {
        this.log(`   Reprojecting...`);
        vestFeatures = vestFeatures.map(f => reprojectFeature(f, prjContent));
      }
    }

    // Extract voting data and detect year
    const precinctData = new Map<
      number,
      {
        votes: Record<string, { democrat: number; republican: number; other: number }>;
        totalVotes: Record<string, number>;
      }
    >();
    const officesFound = new Set<string>();
    let electionYear = "";

    for (let i = 0; i < vestFeatures.length; i++) {
      const props = vestFeatures[i].properties as Record<string, any>;
      const { byOffice, electionYear: yr } = extractVotingData(props);
      if (yr && !electionYear) electionYear = yr;
      for (const office of Object.keys(byOffice)) officesFound.add(office);
      const totalVotes: Record<string, number> = {};
      for (const [office, v] of Object.entries(byOffice)) {
        totalVotes[office] = v.democrat + v.republican + v.other;
      }
      precinctData.set(i, { votes: byOffice, totalVotes });
    }
    this.log(`   Year: 20${electionYear}, offices: ${Array.from(officesFound).sort().join(", ")}`);

    // Prepare precinct geometries using shared GEOS helper
    const precinctGeoms: (number | null)[] = [];
    const preparedPrecincts: (number | null)[] = [];
    const precinctBboxes: [number, number, number, number][] = [];

    for (let i = 0; i < vestFeatures.length; i++) {
      const geom = vestFeatures[i].geometry;
      if (!geom) {
        precinctGeoms.push(null);
        preparedPrecincts.push(null);
        precinctBboxes.push([0, 0, 0, 0]);
        continue;
      }
      try {
        let g = geosHelper.fromGeoJSON(geom as Polygon | MultiPolygon);
        if (!geosHelper.isValid(g)) {
          const f = geosHelper.makeValid(g);
          geosHelper.free(g);
          g = f;
        }
        precinctGeoms.push(g);
        const buffered = geosHelper.buffer(g, 0.0001);
        preparedPrecincts.push(geosHelper.prepare(buffered));
        // Don't free buffered — prepared geometry holds a reference to it
        precinctBboxes.push(featureBbox(vestFeatures[i]));
      } catch {
        precinctGeoms.push(null);
        preparedPrecincts.push(null);
        precinctBboxes.push([0, 0, 0, 0]);
      }
    }

    // Build grid index over precincts using precinct bboxes for grid extent
    const GRID_SIZE = 200;
    let gsMinX = Infinity,
      gsMinY = Infinity,
      gsMaxX = -Infinity,
      gsMaxY = -Infinity;
    for (const [pMinX, pMinY, pMaxX, pMaxY] of precinctBboxes) {
      if (pMinX === 0 && pMaxX === 0) continue;
      if (pMinX < gsMinX) gsMinX = pMinX;
      if (pMinY < gsMinY) gsMinY = pMinY;
      if (pMaxX > gsMaxX) gsMaxX = pMaxX;
      if (pMaxY > gsMaxY) gsMaxY = pMaxY;
    }
    const gW = (gsMaxX - gsMinX) / GRID_SIZE;
    const gH = (gsMaxY - gsMinY) / GRID_SIZE;
    const grid: number[][] = new Array(GRID_SIZE * GRID_SIZE);
    for (let i = 0; i < grid.length; i++) grid[i] = [];
    for (let pi = 0; pi < vestFeatures.length; pi++) {
      const [pMinX, pMinY, pMaxX, pMaxY] = precinctBboxes[pi];
      if (pMinX === 0 && pMaxX === 0) continue;
      const x0 = Math.max(0, Math.min(GRID_SIZE - 1, Math.floor((pMinX - gsMinX) / gW)));
      const y0 = Math.max(0, Math.min(GRID_SIZE - 1, Math.floor((pMinY - gsMinY) / gH)));
      const x1 = Math.max(0, Math.min(GRID_SIZE - 1, Math.floor((pMaxX - gsMinX) / gW)));
      const y1 = Math.max(0, Math.min(GRID_SIZE - 1, Math.floor((pMaxY - gsMinY) / gH)));
      for (let gy = y0; gy <= y1; gy++)
        for (let gx = x0; gx <= x1; gx++) grid[gy * GRID_SIZE + gx].push(pi);
    }

    // Join: stream geometry from disk, one feature at a time.
    // No pre-scan of geometry needed — bbox is computed inline per feature.
    this.log(`   Joining ${featureProps.length} features...`);
    const yy = electionYear;
    let single = 0,
      blended = 0,
      noMatchCount = 0;

    // Track for reconciliation: precinctIdx → office → [{featureIdx, weight}]
    const precinctAssigned = new Map<
      number,
      Map<string, { featureIdx: number; weight: number }[]>
    >();

    // Read geometry file line-by-line synchronously using a buffered reader.
    // Can't use readFileSync (string too long for TX) or async readline
    // (breaks in nested async contexts).
    const geomFdRead = require("fs").openSync(geomTempPath, "r"); // eslint-disable-line
    const LINE_BUF_SIZE = 256 * 1024; // 256KB per read chunk
    const lineBuf = Buffer.alloc(LINE_BUF_SIZE);
    let remainder = "";

    function readNextLine(): string {
      while (true) {
        const nlIdx = remainder.indexOf("\n");
        if (nlIdx !== -1) {
          const line = remainder.substring(0, nlIdx);
          remainder = remainder.substring(nlIdx + 1);
          return line;
        }
        const bytesRead = require("fs").readSync(geomFdRead, lineBuf, 0, LINE_BUF_SIZE); // eslint-disable-line
        if (bytesRead === 0) {
          const last = remainder;
          remainder = "";
          return last;
        }
        remainder += lineBuf.toString("utf-8", 0, bytesRead);
      }
    }

    for (let fi = 0; fi < featureProps.length; fi++) {
      if (fi % 50000 === 0 && fi > 0) {
        this.log(`   Progress: ${fi}/${featureProps.length}`);
      }

      const currentGeomLine = readNextLine();
      const props = featureProps[fi];
      // Vote disaggregation weight: VAP_MOD (VAP minus adult correctional
      // facility pop). Matches the primary-year weighting in buildBlockProps
      // and RDH's methodology. Named `pop` for historical reasons below.
      const pop = props.VAP_MOD || 0;

      // Parse geometry once — used for bbox, GEOS conversion, and candidate search
      const currentGeom = JSON.parse(currentGeomLine) as Polygon | MultiPolygon;
      const [bMinX, bMinY, bMaxX, bMaxY] = featureBbox({ geometry: currentGeom } as any);
      const bcx = (bMinX + bMaxX) / 2;
      const bcy = (bMinY + bMaxY) / 2;
      const gxi = Math.max(0, Math.min(GRID_SIZE - 1, Math.floor((bcx - gsMinX) / gW)));
      const gyi = Math.max(0, Math.min(GRID_SIZE - 1, Math.floor((bcy - gsMinY) / gH)));
      const gridCands = grid[gyi * GRID_SIZE + gxi];

      const candidates: number[] = [];
      for (const pi of gridCands) {
        const [pMinX, pMinY, pMaxX, pMaxY] = precinctBboxes[pi];
        if (bMaxX >= pMinX && bMinX <= pMaxX && bMaxY >= pMinY && bMinY <= pMaxY) {
          candidates.push(pi);
        }
      }

      if (candidates.length === 0) {
        noMatchCount++;
        for (const office of Array.from(officesFound)) {
          const prefix = office === "PRE" ? "" : `${office}_`;
          props[`${prefix}democrat${yy}`] = 0;
          props[`${prefix}republican${yy}`] = 0;
          props[`${prefix}other${yy}`] = 0;
        }
        continue;
      }

      // Convert to GEOS for spatial tests
      let featGeom: any;
      try {
        featGeom = geosHelper.fromGeoJSON(currentGeom);
        if (!geosHelper.isValid(featGeom)) {
          const fixed = geosHelper.makeValid(featGeom);
          geosHelper.free(featGeom);
          featGeom = fixed;
        }
      } catch {
        noMatchCount++;
        for (const office of Array.from(officesFound)) {
          const prefix = office === "PRE" ? "" : `${office}_`;
          props[`${prefix}democrat${yy}`] = 0;
          props[`${prefix}republican${yy}`] = 0;
          props[`${prefix}other${yy}`] = 0;
        }
        continue;
      }

      // Check containment with prepared geometries
      let containingPi: number | null = null;
      for (const pi of candidates) {
        const prep = preparedPrecincts[pi];
        if (!prep) continue;
        try {
          if (geosHelper.preparedContains(prep, featGeom)) {
            containingPi = pi;
            break;
          }
        } catch {
          /* skip */
        }
      }

      if (containingPi !== null) {
        single++;
        geosHelper.free(featGeom);
        const pd = precinctData.get(containingPi)!;
        for (const office of Array.from(officesFound)) {
          const v = pd.votes[office] || { democrat: 0, republican: 0, other: 0 };
          const total = pd.totalVotes[office] || 0;
          const prefix = office === "PRE" ? "" : `${office}_`;
          if (total > 0 && pop > 0) {
            props[`${prefix}democrat${yy}`] = Math.round((v.democrat / total) * pop);
            props[`${prefix}republican${yy}`] = Math.round((v.republican / total) * pop);
            props[`${prefix}other${yy}`] = Math.round((v.other / total) * pop);
          } else {
            props[`${prefix}democrat${yy}`] = 0;
            props[`${prefix}republican${yy}`] = 0;
            props[`${prefix}other${yy}`] = 0;
          }
        }
        // Track for reconciliation
        if (!precinctAssigned.has(containingPi)) precinctAssigned.set(containingPi, new Map());
        const pa = precinctAssigned.get(containingPi)!;
        for (const office of Array.from(officesFound)) {
          if (!pa.has(office)) pa.set(office, []);
          pa.get(office)!.push({ featureIdx: fi, weight: pop });
        }
        continue;
      }

      // Compute intersections for blending
      blended++;
      const intersections: { pi: number; area: number }[] = [];
      for (const pi of candidates) {
        const pGeom = precinctGeoms[pi];
        if (!pGeom) continue;
        try {
          const inter = geosHelper.intersection(featGeom, pGeom);
          if (inter) {
            const a = geosHelper.area(inter);
            geosHelper.free(inter);
            if (a > 0) intersections.push({ pi, area: a });
          }
        } catch {
          /* skip */
        }
      }
      geosHelper.free(featGeom);

      if (intersections.length === 0) {
        noMatchCount++;
        for (const office of Array.from(officesFound)) {
          const prefix = office === "PRE" ? "" : `${office}_`;
          props[`${prefix}democrat${yy}`] = 0;
          props[`${prefix}republican${yy}`] = 0;
          props[`${prefix}other${yy}`] = 0;
        }
        continue;
      }

      // Blend per-capita rates by area overlap
      const totalArea = intersections.reduce((s, i) => s + i.area, 0);

      for (const office of Array.from(officesFound)) {
        let bDem = 0,
          bRep = 0,
          bOther = 0;
        const prefix = office === "PRE" ? "" : `${office}_`;
        for (const int of intersections) {
          const pd = precinctData.get(int.pi)!;
          const v = pd.votes[office] || { democrat: 0, republican: 0, other: 0 };
          const total = pd.totalVotes[office] || 0;
          const w = totalArea > 0 ? int.area / totalArea : 0;
          if (total > 0) {
            bDem += w * (v.democrat / total);
            bRep += w * (v.republican / total);
            bOther += w * (v.other / total);
          }
        }
        props[`${prefix}democrat${yy}`] = Math.round(bDem * pop);
        props[`${prefix}republican${yy}`] = Math.round(bRep * pop);
        props[`${prefix}other${yy}`] = Math.round(bOther * pop);
      }

      // Track for reconciliation
      for (const int of intersections) {
        if (!precinctAssigned.has(int.pi)) precinctAssigned.set(int.pi, new Map());
        const pa = precinctAssigned.get(int.pi)!;
        const areaFrac = totalArea > 0 ? int.area / totalArea : 0;
        for (const office of Array.from(officesFound)) {
          if (!pa.has(office)) pa.set(office, []);
          pa.get(office)!.push({ featureIdx: fi, weight: areaFrac * pop });
        }
      }
    }

    require("fs").closeSync(geomFdRead); // eslint-disable-line
    // Clean up GEOS objects (but not the helper — shared across voting years)
    for (const p of preparedPrecincts) if (p) geosHelper.freePrepared(p);
    for (const g of precinctGeoms) if (g) geosHelper.free(g);

    this.log(`   Join: ${single} single, ${blended} blended, ${noMatchCount} no match`);

    // Reconcile precinct totals
    this.log(`   Reconciling precinct totals...`);
    const reconciled = reconcilePrecinctVotes(
      precinctAssigned,
      (pi: number) => precinctData.get(pi)!.votes,
      (idx, field) => featureProps[idx][field] || 0,
      (idx, field, value) => {
        featureProps[idx][field] = value;
      },
      yy
    );
    this.log(`   Reconciled ${reconciled} precinct-party totals`);
  }
}

function buildBlockProps(
  blockId: string,
  precinctId: string,
  precinctName: string,
  countyFp: string,
  countyNames: Map<string, string>,
  demo: Record<string, number>,
  votes: Record<string, { democrat: number; republican: number; other: number }>,
  totalVotes: Record<string, number>,
  officesFound: Set<string>,
  electionYear: string
): Record<string, any> {
  return {
    block: blockId,
    precinct: `${countyFp}-${precinctId}`,
    precinct_name: precinctName,
    county: countyFp,
    county_name: countyNames.get(countyFp) || countyFp,
    ...demo,
    ...disaggregateBlockVotes(votes, totalVotes, demo.VAP_MOD || 0, officesFound, electionYear)
  };
}
