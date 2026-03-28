import { Args, Command, Flags } from "@oclif/core";
import {
  writeFileSync,
  readFileSync,
  mkdirSync,
  existsSync,
  readdirSync,
  createWriteStream,
  createReadStream
} from "fs";
import { JsonStreamStringify } from "json-stream-stringify";
import { dirname, join } from "path";
import { tmpdir } from "os";
import * as shapefile from "shapefile";
import * as unzipper from "unzipper";
import RBush from "rbush";
import * as proj4Module from "proj4";
const proj4 = (proj4Module as any).default || proj4Module;
import { GeosHelper } from "../lib/geos-helper";

// Simple bbox from GeoJSON coordinates (no library needed)
function featureBbox(f: GeoJSON.Feature): [number, number, number, number] {
  const coords = (f.geometry as any).coordinates;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
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

// Simple centroid from GeoJSON coordinates
function featureCentroid(f: GeoJSON.Feature): [number, number] {
  const coords = (f.geometry as any).coordinates;
  let sumX = 0, sumY = 0, count = 0;
  function walk(c: any) {
    if (typeof c[0] === "number") {
      sumX += c[0]; sumY += c[1]; count++;
    } else {
      for (const sub of c) walk(sub);
    }
  }
  walk(coords);
  return [sumX / count, sumY / count];
}

// Reproject a GeoJSON feature's coordinates from source CRS to WGS84
function reprojectFeature(
  feature: GeoJSON.Feature,
  projDef: string
): GeoJSON.Feature {
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
import {
  Feature,
  FeatureCollection,
  MultiPolygon,
  Polygon
} from "geojson";

async function extractZipToDir(zipBuffer: Buffer, dir: string): Promise<void> {
  mkdirSync(dir, { recursive: true });
  const zip = await unzipper.Open.buffer(zipBuffer);
  await zip.extract({ path: dir });
}

async function readShapefile(
  shpPath: string,
  dbfPath?: string
): Promise<GeoJSON.Feature[]> {
  const features: GeoJSON.Feature[] = [];
  const source = await shapefile.open(shpPath, dbfPath || null);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const result = await source.read();
    if (result.done) break;
    features.push(result.value);
  }
  return features;
}

function findFileInDir(dir: string, extension: string): string {
  const files = readdirSync(dir) as string[];
  const found = files.find((f: string) => f.endsWith(extension));
  if (!found) throw new Error(`No ${extension} file found in ${dir}`);
  return join(dir, found);
}

// R-tree item for spatial index
interface RTreeItem {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  index: number;
}

// Extract vote columns grouped by office code, also detect election year
// Column format: G20PRERTRU — {electionType}{YY}{office3}{party1}{name3}
function extractVotingData(
  props: Record<string, any>
): { byOffice: Record<string, { democrat: number; republican: number; other: number }>; electionYear: string } {
  const byOffice: Record<
    string,
    { democrat: number; republican: number; other: number }
  > = {};
  let electionYear = "";

  for (const [key, value] of Object.entries(props)) {
    // Match vote columns: letter + 2 digits + 3-letter office + party + name
    const match = key.match(/^[GPCRS](\d{2})([A-Z]{3})([DRLGIOCNSMPUAWBETH])/);
    if (!match) continue;

    const year = match[1];
    const office = match[2];
    const partyCode = match[3];
    const votes =
      typeof value === "number" ? value : parseInt(String(value)) || 0;

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
function apportion(total: number, ratios: number[]): number[] {
  const sum = ratios.reduce((a, b) => a + b, 0);
  if (sum === 0) return ratios.map(() => 0);

  const exact = ratios.map(r => (total * r) / sum);
  const floored = exact.map(Math.floor);
  let remainder = total - floored.reduce((a, b) => a + b, 0);

  // Distribute remainder to entries with largest fractional parts
  const fractionals = exact.map((e, i) => ({ i, frac: e - floored[i] }));
  fractionals.sort((a, b) => b.frac - a.frac);
  for (let j = 0; j < remainder; j++) {
    floored[fractionals[j].i]++;
  }

  return floored;
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
      description: "VEST shapefile field name for precinct ID",
      required: true
    }),
    output: Flags.string({
      char: "o",
      description: "Output GeoJSON file path",
      default: "dev-data/output.geojson"
    }),
    censusCache: Flags.string({
      char: "c",
      description:
        "Path to cache Census blocks+demographics GeoJSON (skips download if exists)"
    }),
    additionalVest: Flags.string({
      char: "a",
      description:
        "Additional VEST zips for other election years, comma-separated as precinctField:path pairs",
      default: ""
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
      const rl = require("readline").createInterface({ // eslint-disable-line
        input: createReadStream(cacheFeaturesPath),
        crlfDelay: Infinity
      });
      for await (const line of rl) {
        if (line.trim()) blockFeatures.push(JSON.parse(line));
      }
      // Demographics and county names are small enough for JSON.parse
      blockDemographics = new Map(Object.entries(JSON.parse(readFileSync(cacheDemoPath, "utf-8"))));
      countyNames = new Map(Object.entries(JSON.parse(readFileSync(cacheCountyPath, "utf-8"))));
      this.log(`   ${blockFeatures.length} blocks, ${blockDemographics.size} demographics loaded from cache`);
    } else {
      // Download Census block shapefile
      this.log("\n1a. Downloading Census 2020 block shapefile...");
      const tigerUrl = `https://www2.census.gov/geo/tiger/TIGER2020/TABBLOCK20/tl_2020_${stateFips}_tabblock20.zip`;
      const tigerResp = await fetch(tigerUrl);
      if (!tigerResp.ok)
        throw new Error(`Failed to download TIGER data: ${tigerResp.status}`);
      const tigerBuffer = Buffer.from(await tigerResp.arrayBuffer());
      this.log(
        `   Downloaded ${(tigerBuffer.length / 1024 / 1024).toFixed(1)}MB`
      );

      const tigerDir = join(tmp, "tiger");
      await extractZipToDir(tigerBuffer, tigerDir);
      const shpFile = findFileInDir(tigerDir, ".shp");
      const dbfFile = findFileInDir(tigerDir, ".dbf");
      blockFeatures = await readShapefile(shpFile, dbfFile);
      this.log(`   ${blockFeatures.length} blocks loaded`);

      // Fetch demographics from Census API
      this.log("\n1b. Fetching demographics from Census API...");
      const censusUrl = `https://api.census.gov/data/2020/dec/pl?get=P1_001N,P1_003N,P1_004N,P1_006N,P2_002N,P3_001N,P3_003N,P3_004N,P3_006N,P4_002N&for=block:*&in=state:${stateFips}&in=county:*&in=tract:*`;
      const censusResp = await fetch(censusUrl);
      if (!censusResp.ok)
        throw new Error(`Census API failed: ${censusResp.status}`);
      const censusData: string[][] = await censusResp.json();

      blockDemographics = new Map();
      for (let i = 1; i < censusData.length; i++) {
        const [pop, white, black, asian, hispanic,
               vap, vapWhite, vapBlack, vapAsian, vapHispanic,
               state, county, tract, block] =
          censusData[i];
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
        blockDemographics.set(geoId, {
          population: popN,
          white: whiteN,
          black: blackN,
          asian: asianN,
          hispanic: hispanicN,
          other: otherN,
          vap: vapN,
          vap_white: vapWhiteN,
          vap_black: vapBlackN,
          vap_asian: vapAsianN,
          vap_hispanic: vapHispanicN,
          vap_other: vapOtherN
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

    // ── Step 2: Load VEST precinct polygons with geometry ──
    this.log("\n2. Loading VEST precinct polygons...");
    const vestPath = flags.vest.replace("~", process.env.HOME || "");
    const vestBuffer = readFileSync(vestPath);
    const vestDir = join(tmp, "vest");
    await extractZipToDir(vestBuffer, vestDir);
    const vestShp = findFileInDir(vestDir, ".shp");
    const vestDbf = findFileInDir(vestDir, ".dbf");
    let vestFeatures = await readShapefile(vestShp, vestDbf);
    this.log(`   ${vestFeatures.length} VEST precincts loaded`);

    // Reproject VEST features to WGS84 if needed
    const prjFiles = readdirSync(vestDir).filter(f => f.endsWith(".prj"));
    if (prjFiles.length > 0) {
      const prjContent = readFileSync(join(vestDir, prjFiles[0]), "utf-8").trim();
      const isProjected = prjContent.startsWith("PROJCS");
      if (isProjected) {
        this.log(`   Reprojecting from projected CRS to WGS84...`);
        vestFeatures = vestFeatures.map(f => reprojectFeature(f, prjContent));
        this.log(`   Reprojection complete`);
      } else {
        this.log(`   CRS is geographic (no reprojection needed)`);
      }
    }

    // Extract precinct IDs and voting data
    const precinctField = flags.vestPrecinctField;
    const precinctVoting = new Map<
      number,
      {
        precinctId: string;
        votes: Record<
          string,
          { democrat: number; republican: number; other: number }
        >;
      }
    >();
    const officesFound = new Set<string>();

    let detectedYear = "";
    for (let i = 0; i < vestFeatures.length; i++) {
      const props = vestFeatures[i].properties as Record<string, any>;
      const precinctId = String(props[precinctField] ?? `vest_${i}`);
      const { byOffice, electionYear } = extractVotingData(props);
      if (electionYear && !detectedYear) detectedYear = electionYear;
      for (const office of Object.keys(byOffice)) officesFound.add(office);
      precinctVoting.set(i, { precinctId, votes: byOffice });
    }
    this.log(
      `   Election year: 20${detectedYear}`
    );
    this.log(
      `   Offices found: ${Array.from(officesFound).sort().join(", ")}`
    );

    // ── Step 3: Initialize GEOS + build spatial index ──
    this.log("\n3. Initializing GEOS and building spatial index...");
    const geosHelper = new GeosHelper();
    await geosHelper.init();

    // Convert precinct geometries to GEOS and prepare them for fast containment checks
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
          const fixed = geosHelper.makeValid(g);
          geosHelper.free(g);
          g = fixed;
        }
        precinctGeoms.push(g);
        // Prepare both exact and buffered versions:
        // - Exact for intersection math when splitting
        // - Buffered (~1m tolerance) for containment check to absorb reprojection noise
        preparedPrecincts.push(geosHelper.prepare(geosHelper.buffer(g, 0.0001)));
        precinctBboxes.push(featureBbox(vestFeatures[i]));
      } catch {
        precinctGeoms.push(null);
        preparedPrecincts.push(null);
        precinctBboxes.push([0, 0, 0, 0]);
      }
    }

    // Grid index for O(1) candidate lookup
    const GRID_SIZE = 200;
    let sMinX = Infinity, sMinY = Infinity, sMaxX = -Infinity, sMaxY = -Infinity;
    for (const f of blockFeatures) {
      const [a, b, c, d] = featureBbox(f);
      if (a < sMinX) sMinX = a;
      if (b < sMinY) sMinY = b;
      if (c > sMaxX) sMaxX = c;
      if (d > sMaxY) sMaxY = d;
    }
    const gridW = (sMaxX - sMinX) / GRID_SIZE;
    const gridH = (sMaxY - sMinY) / GRID_SIZE;
    const grid: number[][] = new Array(GRID_SIZE * GRID_SIZE);
    for (let i = 0; i < grid.length; i++) grid[i] = [];

    for (let pi = 0; pi < vestFeatures.length; pi++) {
      const [pMinX, pMinY, pMaxX, pMaxY] = precinctBboxes[pi];
      if (pMinX === 0 && pMaxX === 0) continue;
      const cMinXi = Math.max(0, Math.min(GRID_SIZE - 1, Math.floor((pMinX - sMinX) / gridW)));
      const cMinYi = Math.max(0, Math.min(GRID_SIZE - 1, Math.floor((pMinY - sMinY) / gridH)));
      const cMaxXi = Math.max(0, Math.min(GRID_SIZE - 1, Math.floor((pMaxX - sMinX) / gridW)));
      const cMaxYi = Math.max(0, Math.min(GRID_SIZE - 1, Math.floor((pMaxY - sMinY) / gridH)));
      for (let gy = cMinYi; gy <= cMaxYi; gy++) {
        for (let gx = cMinXi; gx <= cMaxXi; gx++) {
          grid[gy * GRID_SIZE + gx].push(pi);
        }
      }
    }

    // R-tree fallback for blocks outside the grid
    const tree = new RBush<RTreeItem>();
    const rTreeItems: RTreeItem[] = [];
    for (let i = 0; i < vestFeatures.length; i++) {
      const [minX, minY, maxX, maxY] = precinctBboxes[i];
      if (minX === 0 && maxX === 0) continue;
      rTreeItems.push({ minX, minY, maxX, maxY, index: i });
    }
    tree.load(rTreeItems);

    this.log(`   ${precinctGeoms.filter(g => g !== null).length} precincts prepared (GEOS + ${GRID_SIZE}x${GRID_SIZE} grid)`);

    // ── Step 4: Spatial join — assign blocks to precincts ──
    this.log("\n4. Performing spatial join (blocks → precincts)...");
    const outputFeatures: GeoJSON.Feature[] = [];
    let singlePrecinct = 0;
    let splitBlocks = 0;
    let noMatch = 0;
    let totalSubBlocks = 0;

    for (let bi = 0; bi < blockFeatures.length; bi++) {
      if (bi % 50000 === 0 && bi > 0) {
        this.log(
          `   Progress: ${bi}/${blockFeatures.length} blocks (${singlePrecinct} single, ${splitBlocks} split, ${noMatch} unmatched)`
        );
      }

      const blockFeature = blockFeatures[bi];
      const blockProps = blockFeature.properties as Record<string, any>;
      const geoId = blockProps.GEOID20 as string;
      const countyFp = blockProps.COUNTYFP20 as string;
      const demo = blockDemographics.get(geoId);

      if (!demo) continue;

      // Find candidate precincts via grid
      const [bMinX, bMinY, bMaxX, bMaxY] = featureBbox(blockFeature);
      const bcx = (bMinX + bMaxX) / 2;
      const bcy = (bMinY + bMaxY) / 2;
      const gx = Math.max(0, Math.min(GRID_SIZE - 1, Math.floor((bcx - sMinX) / gridW)));
      const gy = Math.max(0, Math.min(GRID_SIZE - 1, Math.floor((bcy - sMinY) / gridH)));
      const gridCandidates = grid[gy * GRID_SIZE + gx];

      // Filter to precincts whose bbox overlaps this block's bbox
      const candidates: number[] = [];
      for (const pi of gridCandidates) {
        const [pMinX, pMinY, pMaxX, pMaxY] = precinctBboxes[pi];
        if (bMaxX >= pMinX && bMinX <= pMaxX && bMaxY >= pMinY && bMinY <= pMaxY) {
          candidates.push(pi);
        }
      }

      if (candidates.length === 0) {
        noMatch++;
        // R-tree fallback
        const wider = tree.search({ minX: bcx - 0.1, minY: bcy - 0.1, maxX: bcx + 0.1, maxY: bcy + 0.1 });
        if (wider.length > 0) {
          const pData = precinctVoting.get(wider[0].index)!;
          outputFeatures.push({
            type: "Feature",
            geometry: blockFeature.geometry,
            properties: buildBlockProps(geoId, pData.precinctId, countyFp, countyNames, demo, pData.votes, officesFound, detectedYear)
          });
        }
        continue;
      }

      // Convert block to GEOS geometry
      let blockGeom: number;
      try {
        blockGeom = geosHelper.fromGeoJSON(blockFeature.geometry as Polygon | MultiPolygon);
        if (!geosHelper.isValid(blockGeom)) {
          const fixed = geosHelper.makeValid(blockGeom);
          geosHelper.free(blockGeom);
          blockGeom = fixed;
        }
      } catch {
        noMatch++;
        continue;
      }

      // Check containment with prepared precinct geometries
      let containingPrecinct: number | null = null;
      for (const pi of candidates) {
        const prep = preparedPrecincts[pi];
        if (!prep) continue;
        try {
          if (geosHelper.preparedContains(prep, blockGeom)) {
            containingPrecinct = pi;
            break;
          }
        } catch { /* skip */ }
      }

      if (containingPrecinct !== null) {
        singlePrecinct++;
        geosHelper.free(blockGeom);
        const pData = precinctVoting.get(containingPrecinct)!;
        outputFeatures.push({
          type: "Feature",
          geometry: blockFeature.geometry,
          properties: buildBlockProps(geoId, pData.precinctId, countyFp, countyNames, demo, pData.votes, officesFound, detectedYear)
        });
        continue;
      }

      // Not fully contained — compute intersections for splitting
      const intersections: { precinctIdx: number; area: number; geom: number }[] = [];
      const blockArea = geosHelper.area(blockGeom);

      for (const pi of candidates) {
        const pGeom = precinctGeoms[pi];
        if (!pGeom) continue;
        try {
          const inter = geosHelper.intersection(blockGeom, pGeom);
          if (inter) {
            const intArea = geosHelper.area(inter);
            if (intArea > 0) {
              intersections.push({ precinctIdx: pi, area: intArea, geom: inter });
            } else {
              geosHelper.free(inter);
            }
          }
        } catch { /* skip */ }
      }

      if (intersections.length === 0) {
        noMatch++;
        geosHelper.free(blockGeom);
        // Assign to first candidate as fallback
        if (candidates.length > 0) {
          const pData = precinctVoting.get(candidates[0])!;
          outputFeatures.push({
            type: "Feature",
            geometry: blockFeature.geometry,
            properties: buildBlockProps(geoId, pData.precinctId, countyFp, countyNames, demo, pData.votes, officesFound, detectedYear)
          });
        }
        continue;
      }

      if (intersections.length === 1) {
        // Only one precinct overlaps
        const dominant = intersections[0];
        singlePrecinct++;
        const pData = precinctVoting.get(dominant.precinctIdx)!;
        outputFeatures.push({
          type: "Feature",
          geometry: blockFeature.geometry,
          properties: buildBlockProps(geoId, pData.precinctId, countyFp, countyNames, demo, pData.votes, officesFound, detectedYear)
        });
        for (const int of intersections) geosHelper.free(int.geom);
        geosHelper.free(blockGeom);
        continue;
      }

      // Block straddles multiple precincts — split, but filter out slivers
      // too small to be visually selectable on the map.
      // Higher threshold for zero-pop blocks (parks, water) since splitting
      // them precisely doesn't affect redistricting.
      const MIN_AREA_RATIO = demo.population === 0 ? 0.05 : 0.005;
      const demoKeys = ["population", "white", "black", "asian", "hispanic", "other", "vap", "vap_white", "vap_black", "vap_asian", "vap_hispanic", "vap_other"];

      // Check which intersections are large enough to keep
      const viable: typeof intersections = [];
      const slivers: typeof intersections = [];
      for (const int of intersections) {
        if (blockArea > 0 && int.area / blockArea >= MIN_AREA_RATIO) {
          viable.push(int);
        } else {
          slivers.push(int);
        }
      }

      if (viable.length <= 1) {
        // All slivers except maybe one — assign whole block to dominant piece
        singlePrecinct++;
        const best = viable.length === 1 ? viable[0] : intersections.reduce((a, b) => a.area > b.area ? a : b);
        const pData = precinctVoting.get(best.precinctIdx)!;
        outputFeatures.push({
          type: "Feature",
          geometry: blockFeature.geometry,
          properties: buildBlockProps(geoId, pData.precinctId, countyFp, countyNames, demo, pData.votes, officesFound, detectedYear)
        });
        for (const int of intersections) geosHelper.free(int.geom);
        geosHelper.free(blockGeom);
        continue;
      }

      // Multiple viable sub-blocks — merge sliver demographics into the largest viable piece
      splitBlocks++;
      const areaRatios = viable.map(int => int.area);
      const sliverArea = slivers.reduce((s, int) => s + int.area, 0);
      // Add sliver area to the largest viable piece for apportionment
      const largestIdx = areaRatios.indexOf(Math.max(...areaRatios));
      areaRatios[largestIdx] += sliverArea;

      const apportioned: Record<string, number[]> = {};
      for (const key of demoKeys) {
        apportioned[key] = apportion(demo[key], areaRatios);
      }

      const suffixes = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
      for (let si = 0; si < viable.length; si++) {
        totalSubBlocks++;
        const suffix = si < suffixes.length ? suffixes[si] : String(si);
        const subBlockId = `${geoId}-${suffix}`;
        const pi = viable[si].precinctIdx;
        const pData = precinctVoting.get(pi)!;

        const subDemo: Record<string, number> = {};
        for (const key of demoKeys) {
          subDemo[key] = apportioned[key][si];
        }

        const intGeoJSON = geosHelper.toGeoJSON(viable[si].geom);

        outputFeatures.push({
          type: "Feature",
          geometry: intGeoJSON || blockFeature.geometry as any,
          properties: buildBlockProps(subBlockId, pData.precinctId, countyFp, countyNames, subDemo, pData.votes, officesFound, detectedYear)
        });
      }

      for (const int of intersections) geosHelper.free(int.geom);
      geosHelper.free(blockGeom);
    }

    // Clean up GEOS resources
    for (const p of preparedPrecincts) if (p) geosHelper.freePrepared(p);
    for (const g of precinctGeoms) if (g) geosHelper.free(g);
    geosHelper.destroy();

    this.log(
      `\n   Spatial join complete:`
    );
    this.log(`     Single precinct: ${singlePrecinct}`);
    this.log(`     Split blocks:    ${splitBlocks} (${totalSubBlocks} sub-blocks)`);
    this.log(`     No match:        ${noMatch} (assigned via fallback)`);
    this.log(`     Total features:  ${outputFeatures.length}`);

    // ── Step 5: Process additional election years ──
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
          outputFeatures,
          addVestPath.replace("~", process.env.HOME || ""),
          addPrecinctField,
          tmp
        );
      }
    }

    // ── Step 6: Write output ──
    const output: FeatureCollection = {
      type: "FeatureCollection",
      features: outputFeatures
    };

    const outputPath = flags.output.replace("~", process.env.HOME || "");
    mkdirSync(dirname(outputPath), { recursive: true });

    // Stream JSON to disk to avoid Node's max string length limit for large states
    this.log(`\nWriting ${outputFeatures.length} features to ${outputPath}...`);
    await new Promise<void>((resolve, reject) => {
      const stream = new JsonStreamStringify(output);
      const fileStream = createWriteStream(outputPath);
      stream.pipe(fileStream);
      fileStream.on("finish", resolve);
      stream.on("error", reject);
      fileStream.on("error", reject);
    });
    const { statSync: statSyncFn } = require("fs"); // eslint-disable-line
    const fileSizeMB = (statSyncFn(outputPath).size / 1024 / 1024).toFixed(1);
    this.log(`Wrote ${fileSizeMB}MB`);

    const totalPop = outputFeatures.reduce(
      (sum, f) => sum + ((f.properties as any).population || 0),
      0
    );
    const counties = new Set(
      outputFeatures.map(f => (f.properties as any).county)
    );
    const precincts = new Set(
      outputFeatures.map(f => (f.properties as any).precinct)
    );
    this.log(`\nSummary:`);
    this.log(`  Population: ${totalPop.toLocaleString()}`);
    this.log(`  Counties: ${counties.size}`);
    this.log(`  Precincts: ${precincts.size}`);
    this.log(`  Features: ${outputFeatures.length}`);
    this.log(
      `  Offices: ${Array.from(officesFound).sort().join(", ")}`
    );
  }

  /**
   * Add voting data from an additional election year to existing output features.
   * Does a full spatial join against the additional year's VEST precincts,
   * blending per-capita voting rates by area overlap for straddling blocks.
   */
  async addVotingYear(
    outputFeatures: GeoJSON.Feature[],
    vestZipPath: string,
    precinctField: string,
    tmpDir: string
  ): Promise<void> {
    this.log(`\n── Adding voting year from ${vestZipPath} ──`);

    // Load VEST shapefile
    const vestBuffer = readFileSync(vestZipPath);
    const vestDir = join(tmpDir, `vest-add-${Date.now()}`);
    await extractZipToDir(vestBuffer, vestDir);
    const vestShp = findFileInDir(vestDir, ".shp");
    const vestDbf = findFileInDir(vestDir, ".dbf");
    let vestFeatures = await readShapefile(vestShp, vestDbf);
    this.log(`   ${vestFeatures.length} precincts loaded`);

    // Reproject if needed
    const prjFiles = readdirSync(vestDir).filter(f => f.endsWith(".prj"));
    if (prjFiles.length > 0) {
      const prjContent = readFileSync(join(vestDir, prjFiles[0]), "utf-8").trim();
      if (prjContent.startsWith("PROJCS")) {
        this.log(`   Reprojecting...`);
        vestFeatures = vestFeatures.map(f => reprojectFeature(f, prjContent));
      }
    }

    // Extract voting data and detect year
    const precinctData = new Map<number, {
      votes: Record<string, { democrat: number; republican: number; other: number }>;
      totalVotes: Record<string, number>;
    }>();
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

    // Initialize GEOS and prepare precinct geometries
    const geosHelper = new GeosHelper();
    await geosHelper.init();

    const precinctGeoms: (number | null)[] = [];
    const preparedPrecincts: (number | null)[] = [];
    const precinctBboxes: [number, number, number, number][] = [];

    for (let i = 0; i < vestFeatures.length; i++) {
      const geom = vestFeatures[i].geometry;
      if (!geom) { precinctGeoms.push(null); preparedPrecincts.push(null); precinctBboxes.push([0, 0, 0, 0]); continue; }
      try {
        let g = geosHelper.fromGeoJSON(geom as Polygon | MultiPolygon);
        if (!geosHelper.isValid(g)) { const f = geosHelper.makeValid(g); geosHelper.free(g); g = f; }
        precinctGeoms.push(g);
        preparedPrecincts.push(geosHelper.prepare(geosHelper.buffer(g, 0.0001)));
        precinctBboxes.push(featureBbox(vestFeatures[i]));
      } catch { precinctGeoms.push(null); preparedPrecincts.push(null); precinctBboxes.push([0, 0, 0, 0]); }
    }

    // Build grid index
    const GRID_SIZE = 200;
    let gsMinX = Infinity, gsMinY = Infinity, gsMaxX = -Infinity, gsMaxY = -Infinity;
    for (const f of outputFeatures) {
      const [a, b, c, d] = featureBbox(f);
      if (a < gsMinX) gsMinX = a; if (b < gsMinY) gsMinY = b;
      if (c > gsMaxX) gsMaxX = c; if (d > gsMaxY) gsMaxY = d;
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
        for (let gx = x0; gx <= x1; gx++)
          grid[gy * GRID_SIZE + gx].push(pi);
    }

    // Join: for each output feature, assign voting data from this year
    this.log(`   Joining ${outputFeatures.length} features...`);
    const yy = electionYear;
    let single = 0, blended = 0, noMatchCount = 0;

    // Track for reconciliation: precinctIdx → office → [{featureIdx, weight}]
    const precinctAssigned = new Map<number, Map<string, { featureIdx: number; weight: number }[]>>();

    for (let fi = 0; fi < outputFeatures.length; fi++) {
      if (fi % 50000 === 0 && fi > 0) {
        this.log(`   Progress: ${fi}/${outputFeatures.length}`);
      }

      const feat = outputFeatures[fi];
      const props = feat.properties as Record<string, any>;
      const pop = props.population || 0;

      // Find candidates via grid
      const [bMinX, bMinY, bMaxX, bMaxY] = featureBbox(feat);
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

      // Convert feature to GEOS
      let featGeom: number;
      try {
        featGeom = geosHelper.fromGeoJSON(feat.geometry as Polygon | MultiPolygon);
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
        } catch { /* skip */ }
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
          pa.get(office)!.push({ featureIdx: fi, weight: 1.0 });
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
        } catch { /* skip */ }
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
        let bDem = 0, bRep = 0, bOther = 0;
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
        const w = totalArea > 0 ? int.area / totalArea : 0;
        for (const office of Array.from(officesFound)) {
          if (!pa.has(office)) pa.set(office, []);
          pa.get(office)!.push({ featureIdx: fi, weight: w });
        }
      }
    }

    // Clean up GEOS
    for (const p of preparedPrecincts) if (p) geosHelper.freePrepared(p);
    for (const g of precinctGeoms) if (g) geosHelper.free(g);
    geosHelper.destroy();

    this.log(`   Join: ${single} single, ${blended} blended, ${noMatchCount} no match`);

    // Reconcile precinct totals
    this.log(`   Reconciling precinct totals...`);
    let reconciled = 0;
    for (const [pi, officeMap] of Array.from(precinctAssigned.entries())) {
      const pd = precinctData.get(pi)!;
      for (const [office, assignments] of Array.from(officeMap.entries())) {
        const v = pd.votes[office] || { democrat: 0, republican: 0, other: 0 };
        const prefix = office === "PRE" ? "" : `${office}_`;
        for (const party of ["democrat", "republican", "other"] as const) {
          const fieldName = `${prefix}${party}${yy}`;
          const expected = v[party];
          const actual = assignments.reduce((sum, a) =>
            sum + ((outputFeatures[a.featureIdx].properties as any)[fieldName] || 0), 0);
          const diff = expected - actual;
          if (diff === 0) continue;
          reconciled++;
          const weights = assignments.map(a => a.weight);
          const adjustments = apportion(Math.abs(diff), weights);
          const sign = diff > 0 ? 1 : -1;
          for (let i = 0; i < assignments.length; i++) {
            (outputFeatures[assignments[i].featureIdx].properties as any)[fieldName] += sign * adjustments[i];
          }
        }
      }
    }
    this.log(`   Reconciled ${reconciled} precinct-party totals`);
  }
}

function buildBlockProps(
  blockId: string,
  precinctId: string,
  countyFp: string,
  countyNames: Map<string, string>,
  demo: Record<string, number>,
  votes: Record<string, { democrat: number; republican: number; other: number }>,
  officesFound: Set<string>,
  electionYear: string
): Record<string, any> {
  const props: Record<string, any> = {
    block: blockId,
    precinct: precinctId,
    county: countyFp,
    county_name: countyNames.get(countyFp) || countyFp,
    ...demo
  };

  // Add voting data for all offices, suffixed by year
  // Presidential (PRE) uses bare names: democrat20, republican20 (for PVI calculation)
  // Other offices use prefixed names: USS_democrat20, GOV_democrat20, etc.
  const yy = electionYear; // e.g. "20" for 2020
  for (const office of Array.from(officesFound)) {
    const v = votes[office] || { democrat: 0, republican: 0, other: 0 };
    const prefix = office === "PRE" ? "" : `${office}_`;
    props[`${prefix}democrat${yy}`] = v.democrat;
    props[`${prefix}republican${yy}`] = v.republican;
    props[`${prefix}other${yy}`] = v.other;
  }

  return props;
}
