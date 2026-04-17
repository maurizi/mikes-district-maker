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
  reprojectFeature
} from "../lib/voting-data";
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
      const censusUrl = `https://api.census.gov/data/2020/dec/pl?get=P1_001N,P1_003N,P1_004N,P1_006N,P2_002N,P3_001N,P3_003N,P3_004N,P3_006N,P4_002N&for=block:*&in=state:${stateFips}&in=county:*&in=tract:*`;
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
          "VAP Other": vapOtherN
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

    // ── Step 2: Load VEST precinct polygons with geometry ──
    this.log("\n2. Loading VEST precinct polygons...");
    const vestPath = flags.vest.replace("~", process.env.HOME || "");
    const vestBuffer = readFileSync(vestPath);
    const vestDir = join(tmp, "vest");
    await extractZipToDir(vestBuffer, vestDir);
    const { shpPath: vestShp, dbfPath: vestDbf, prjPath: vestPrj } = findShapefile(vestDir);
    let vestFeatures = await readShapefile(vestShp, vestDbf);
    this.log(`   ${vestFeatures.length} VEST precincts loaded (${vestShp})`);

    // Reproject VEST features to WGS84 if needed
    if (vestPrj) {
      const prjContent = readFileSync(vestPrj, "utf-8").trim();
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
        votes: Record<string, { democrat: number; republican: number; other: number }>;
        totalVotes: Record<string, number>;
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
      const totalVotes: Record<string, number> = {};
      for (const [office, v] of Object.entries(byOffice)) {
        totalVotes[office] = v.democrat + v.republican + v.other;
      }
      precinctVoting.set(i, { precinctId, votes: byOffice, totalVotes });
    }
    this.log(`   Election year: 20${detectedYear}`);
    this.log(`   Offices found: ${Array.from(officesFound).sort().join(", ")}`);

    // ── Step 3: Node everything ──
    // Union ALL block + precinct boundaries, polygonize, assign faces.
    // This ensures every edge is shared exactly, eliminating artifacts when
    // topojson later merges blocks into precincts/counties.
    //
    // All coordinates are scaled to integers (×1e7) before GEOS operations
    // to eliminate floating-point drift that creates sliver spike artifacts.
    // Scaled back to WGS84 for output.
    this.log("\n3. Noding all boundaries...");
    const geosHelper = new GeosHelper();
    geosHelper.init();
    const COORD_SCALE = 1e7; // 1e-7 degrees ≈ 1cm precision

    // Extract block boundaries, keeping only the boundaries (not full polygons)
    // to reduce memory. Full polygon geoms are rebuilt later for containment tests.
    this.log("   Extracting block boundaries...");
    const allBoundaries: any[] = [];
    const validBlocks = new Set<number>(); // track which blocks had valid geometry
    for (let bi = 0; bi < blockFeatures.length; bi++) {
      if (bi % 5000 === 0 && bi > 0) this.log(`   ${bi}/${blockFeatures.length} blocks...`);
      const geom = blockFeatures[bi].geometry;
      if (!geom) continue;
      try {
        let g = geosHelper.fromGeoJSONScaled(geom as Polygon | MultiPolygon, COORD_SCALE);
        if (!geosHelper.isValid(g)) {
          const fixed = geosHelper.makeValid(g);
          geosHelper.free(g);
          g = fixed;
        }
        const boundary = geosHelper.boundary(g);
        geosHelper.free(g); // Free polygon — only keep boundary
        allBoundaries.push(boundary);
        validBlocks.add(bi);
      } catch {
        /* skip */
      }
    }

    // Build R-tree over blocks for spatial lookup (uses original GeoJSON bboxes)
    const snapTree = new RBush<RTreeItem>();
    const snapTreeItems: RTreeItem[] = [];
    for (const bi of validBlocks) {
      const [minX, minY, maxX, maxY] = featureBbox(blockFeatures[bi]);
      snapTreeItems.push({ minX, minY, maxX, maxY, index: bi });
    }
    snapTree.load(snapTreeItems);

    // Snap tolerance in scaled space: 100 units = 100/1e7 degrees ≈ 1m
    const SNAP_TOLERANCE = 100;

    // Pre-extract block boundary WKT strings for snapping (avoids re-extracting
    // boundaries from freed polygon geoms in the snap loop)
    this.log("   Caching block boundary WKT for snapping...");
    const blockBoundaryWkt: (string | null)[] = new Array(blockFeatures.length).fill(null);
    // allBoundaries are in order of validBlocks iteration (Set preserves insertion order)
    {
      let idx = 0;
      for (const bi of validBlocks) {
        blockBoundaryWkt[bi] = geosHelper.toWkt(allBoundaries[idx]);
        idx++;
      }
    }

    this.log("   Extracting precinct boundaries (snapping to nearby block vertices)...");
    const precinctGeoms: any[] = [];
    for (let pi = 0; pi < vestFeatures.length; pi++) {
      if (pi % 100 === 0 && pi > 0) this.log(`   ${pi}/${vestFeatures.length} precincts...`);
      const geom = vestFeatures[pi].geometry;
      if (!geom) {
        precinctGeoms.push(null);
        continue;
      }
      try {
        let g = geosHelper.fromGeoJSONScaled(geom as Polygon | MultiPolygon, COORD_SCALE);
        if (!geosHelper.isValid(g)) {
          const fixed = geosHelper.makeValid(g);
          geosHelper.free(g);
          g = fixed;
        }
        // Find nearby blocks via R-tree and build a local snap target
        const [pMinX, pMinY, pMaxX, pMaxY] = featureBbox(vestFeatures[pi]);
        const nearby = snapTree.search({
          minX: pMinX - 0.001,
          minY: pMinY - 0.001,
          maxX: pMaxX + 0.001,
          maxY: pMaxY + 0.001
        });
        if (nearby.length > 0) {
          // Build snap target from cached boundary WKT (no re-extraction)
          const nearbyBoundaries = [];
          for (const n of nearby) {
            const wkt = blockBoundaryWkt[n.index];
            if (wkt) {
              nearbyBoundaries.push(
                (geosHelper as any)._WKTReader_read((geosHelper as any).reader, wkt)
              );
            }
          }
          if (nearbyBoundaries.length > 0) {
            const snapTarget = geosHelper.createCollection(nearbyBoundaries);
            // createCollection takes ownership of nearbyBoundaries
            const snapped = geosHelper.snap(g, snapTarget, SNAP_TOLERANCE);
            geosHelper.free(g);
            geosHelper.free(snapTarget);
            g = snapped;
            if (!geosHelper.isValid(g)) {
              const fixed = geosHelper.makeValid(g);
              geosHelper.free(g);
              g = fixed;
            }
          }
        }
        precinctGeoms.push(g);
        allBoundaries.push(geosHelper.boundary(g));
      } catch {
        precinctGeoms.push(null);
      }
    }

    this.log(`   Noding ${allBoundaries.length} boundaries (cascaded union)...`);
    const boundaryCollection = geosHelper.createCollection(allBoundaries);
    // Note: createCollection takes ownership of allBoundaries — don't free them
    const noded = geosHelper.unaryUnion(boundaryCollection);
    geosHelper.free(boundaryCollection);

    this.log("   Polygonizing...");
    const geomArray = [noded];
    const collection = (geosHelper as any)._Polygonize(geomArray, 1);
    geosHelper.free(noded);
    const numFaces = (geosHelper as any)._GetNumGeometries(collection);
    this.log(`   ${numFaces} faces created`);

    // Free cached WKT strings — no longer needed after snapping
    blockBoundaryWkt.length = 0;

    // ── Step 4: Assign faces to blocks + precincts ──
    this.log("\n4. Assigning faces...");
    // Rebuild block polygon geoms for containment tests (were freed to save memory during noding)
    this.log("   Rebuilding block geometries for containment...");
    const blockGeoms: any[] = new Array(blockFeatures.length).fill(null);
    for (const bi of validBlocks) {
      const geom = blockFeatures[bi].geometry;
      if (!geom) continue;
      try {
        let g = geosHelper.fromGeoJSONScaled(geom as Polygon | MultiPolygon, COORD_SCALE);
        if (!geosHelper.isValid(g)) {
          const fixed = geosHelper.makeValid(g);
          geosHelper.free(g);
          g = fixed;
        }
        blockGeoms[bi] = g;
      } catch {
        /* skip */
      }
    }

    // Build spatial index over blocks for fast face assignment
    const blockTree = new RBush<RTreeItem>();
    const blockRTreeItems: RTreeItem[] = [];
    for (const bi of validBlocks) {
      if (!blockGeoms[bi]) continue;
      const [minX, minY, maxX, maxY] = featureBbox(blockFeatures[bi]);
      blockRTreeItems.push({ minX, minY, maxX, maxY, index: bi });
    }
    blockTree.load(blockRTreeItems);

    const precinctTree = new RBush<RTreeItem>();
    const precinctRTreeItems: RTreeItem[] = [];
    for (let pi = 0; pi < vestFeatures.length; pi++) {
      if (!precinctGeoms[pi]) continue;
      const [minX, minY, maxX, maxY] = featureBbox(vestFeatures[pi]);
      precinctRTreeItems.push({ minX, minY, maxX, maxY, index: pi });
    }
    precinctTree.load(precinctRTreeItems);

    // Assign each face to a block and precinct
    type FaceInfo = { geom: any; area: number; blockIdx: number; precinctIdx: number };
    const facesByBlock = new Map<number, FaceInfo[]>();
    let assigned = 0;
    let unassigned = 0;
    let unassignedBlock = 0;
    let unassignedPrecinct = 0;
    // Faces where block was found but precinct wasn't — saved for second pass
    const deferredFaces: { geom: any; area: number; blockIdx: number }[] = [];

    for (let fi = 0; fi < numFaces; fi++) {
      if (fi % 50000 === 0 && fi > 0) this.log(`   ${fi}/${numFaces} faces...`);
      const face = (geosHelper as any)._GetGeometryN(collection, fi);

      const areaOut = [0];
      (geosHelper as any)._Area(face, areaOut);
      if (areaOut[0] <= 0) continue;

      const rp = geosHelper.pointOnSurface(face);
      if (!rp) continue;

      // Find block via R-tree + containment
      // RP is in scaled space; R-tree is in WGS84 space — unscale for search
      let blockIdx = -1;
      const rpWkt = geosHelper.toWkt(rp);
      // Extract coordinates from WKT like "POINT (x y)"
      const rpMatch = rpWkt?.match(/-?\d+\.?\d*/g);
      if (rpMatch && rpMatch.length >= 2) {
        const rpxScaled = parseFloat(rpMatch[0]);
        const rpyScaled = parseFloat(rpMatch[1]);
        const rpx = rpxScaled / COORD_SCALE;
        const rpy = rpyScaled / COORD_SCALE;
        const blockCands = blockTree.search({
          minX: rpx - 0.001,
          minY: rpy - 0.001,
          maxX: rpx + 0.001,
          maxY: rpy + 0.001
        });
        for (const bc of blockCands) {
          if ((geosHelper as any)._Contains(blockGeoms[bc.index], rp) === 1) {
            blockIdx = bc.index;
            break;
          }
        }
      }

      // Find precinct via R-tree + containment
      let precinctIdx = -1;
      if (rpMatch && rpMatch.length >= 2) {
        const rpxScaled = parseFloat(rpMatch[0]);
        const rpyScaled = parseFloat(rpMatch[1]);
        const rpx = rpxScaled / COORD_SCALE;
        const rpy = rpyScaled / COORD_SCALE;
        const precCands = precinctTree.search({
          minX: rpx - 0.001,
          minY: rpy - 0.001,
          maxX: rpx + 0.001,
          maxY: rpy + 0.001
        });
        for (const pc of precCands) {
          if ((geosHelper as any)._Contains(precinctGeoms[pc.index], rp) === 1) {
            precinctIdx = pc.index;
            break;
          }
        }
      }

      geosHelper.free(rp);

      if (blockIdx === -1) {
        unassigned++;
        unassignedBlock++;
        if (unassignedBlock + unassignedPrecinct <= 20) {
          this.log(
            `   Unassigned face: block=-1 precinct=${precinctIdx} rp=(${
              rpMatch ? (parseFloat(rpMatch[0]) / COORD_SCALE).toFixed(6) : "?"
            },${rpMatch ? (parseFloat(rpMatch[1]) / COORD_SCALE).toFixed(6) : "?"}) area=${areaOut[0].toExponential(3)}`
          );
        }
        continue;
      }

      if (precinctIdx === -1) {
        // Defer — will try to assign via block's dominant precinct in second pass
        const wkt = geosHelper.toWkt(face);
        const cloned = (geosHelper as any)._WKTReader_read((geosHelper as any).reader, wkt);
        deferredFaces.push({ geom: cloned, area: areaOut[0], blockIdx });
        continue;
      }

      // Clone face
      const wkt = geosHelper.toWkt(face);
      const cloned = (geosHelper as any)._WKTReader_read((geosHelper as any).reader, wkt);

      if (!facesByBlock.has(blockIdx)) facesByBlock.set(blockIdx, []);
      facesByBlock.get(blockIdx)!.push({
        geom: cloned,
        area: areaOut[0],
        blockIdx,
        precinctIdx
      });
      assigned++;
    }

    geosHelper.free(collection);

    // Second pass: assign deferred faces (block found, precinct not).
    // Only recover faces that actually intersect a precinct — this filters out
    // ocean/lake faces where precincts legitimately don't cover.
    if (deferredFaces.length > 0) {
      this.log(`   Second pass: ${deferredFaces.length} faces with block but no precinct...`);
      let recovered = 0;
      let stillUnassigned = 0;
      let outsidePrecinct = 0;
      for (const df of deferredFaces) {
        // Check if the face intersects any precinct geometry
        let intersectingPrecinct = -1;
        let fMinX = Infinity,
          fMinY = Infinity,
          fMaxX = -Infinity,
          fMaxY = -Infinity;
        const dfGJ = geosHelper.toGeoJSONScaled(df.geom, COORD_SCALE);
        if (dfGJ) {
          const rings =
            dfGJ.type === "Polygon"
              ? dfGJ.coordinates
              : dfGJ.type === "MultiPolygon"
                ? dfGJ.coordinates.flat()
                : [];
          for (const ring of rings) {
            for (const [x, y] of ring as number[][]) {
              if (x < fMinX) fMinX = x;
              if (y < fMinY) fMinY = y;
              if (x > fMaxX) fMaxX = x;
              if (y > fMaxY) fMaxY = y;
            }
          }
          const precCands = precinctTree.search({
            minX: fMinX - 0.001,
            minY: fMinY - 0.001,
            maxX: fMaxX + 0.001,
            maxY: fMaxY + 0.001
          });
          let bestArea = 0;
          for (const pc of precCands) {
            if ((geosHelper as any)._Intersects(precinctGeoms[pc.index], df.geom) === 1) {
              // Use the precinct with the largest existing area in this block,
              // or just the first intersecting one
              const blockFaces = facesByBlock.get(df.blockIdx);
              if (blockFaces) {
                const areaInBlock = blockFaces
                  .filter(f => f.precinctIdx === pc.index)
                  .reduce((s, f) => s + f.area, 0);
                if (areaInBlock > bestArea) {
                  bestArea = areaInBlock;
                  intersectingPrecinct = pc.index;
                }
              }
              if (intersectingPrecinct === -1) {
                intersectingPrecinct = pc.index;
              }
            }
          }
        }

        // Fallback: nearest precinct by R-tree bbox center distance. Only
        // applied to blocks that are referenced in an official district CSV
        // (blocksInBef) — they need to exist in the output even though they
        // sit outside real precinct coverage. Other blocks with no precinct
        // intersection are dropped in this pass.
        const deferredGeoId = (blockFeatures[df.blockIdx].properties as Record<string, any>)
          .GEOID20 as string;
        if (intersectingPrecinct === -1 && blocksInBef.has(deferredGeoId)) {
          const cx = (fMinX + fMaxX) / 2;
          const cy = (fMinY + fMaxY) / 2;
          let bestDist = Infinity;
          const allCands = precinctTree.search({
            minX: cx - 1.0,
            minY: cy - 1.0,
            maxX: cx + 1.0,
            maxY: cy + 1.0
          });
          for (const pc of allCands) {
            const pcx = (pc.minX + pc.maxX) / 2;
            const pcy = (pc.minY + pc.maxY) / 2;
            const d = (pcx - cx) ** 2 + (pcy - cy) ** 2;
            if (d < bestDist) {
              bestDist = d;
              intersectingPrecinct = pc.index;
            }
          }
        }

        if (intersectingPrecinct >= 0) {
          if (!facesByBlock.has(df.blockIdx)) facesByBlock.set(df.blockIdx, []);
          facesByBlock.get(df.blockIdx)!.push({
            geom: df.geom,
            area: df.area,
            blockIdx: df.blockIdx,
            precinctIdx: intersectingPrecinct
          });
          recovered++;
        } else {
          // Should be unreachable given the nearest-precinct fallback, but
          // kept for safety.
          unassigned++;
          unassignedPrecinct++;
          outsidePrecinct++;
          geosHelper.free(df.geom);
          stillUnassigned++;
        }
      }
      assigned += recovered;
      this.log(
        `   Second pass: recovered ${recovered}, outside precinct coverage ${outsidePrecinct}, still unassigned ${stillUnassigned}`
      );
    }

    this.log(`   Assigned: ${assigned}, Unassigned: ${unassigned}`);

    // ── Third pass (fallback): rescue blocks with zero faces ──
    // Some blocks end up with zero faces because the face-to-block point-on-
    // surface test failed (e.g. TIGER overlap or irregular geometry). This
    // uses the block's own census geometry as a synthetic face to preserve
    // every block in the output.
    // (kept for edge cases; second pass now handles outside-precinct faces)
    // Some blocks get no face assigned during the first/second pass because
    // the polygonize output doesn't contain a face whose point-on-surface is
    // inside the block (e.g. due to TIGER geometry irregularities, boundary
    // snapping, or overlapping blocks). Recover these by using the block's
    // original census geometry as a synthetic face. Populated blocks matter
    // most; zero-pop coastal water blocks are less critical but preserving
    // them avoids CSV-import errors on downstream consumers.
    {
      let rescued = 0;
      let rescuedPopulated = 0;
      let stillMissing = 0;
      let missNoGeom = 0;
      let missNoRP = 0;
      let missNoPrec = 0;
      let missNoWKT = 0;
      let missNoDemo = 0;
      for (const bi of validBlocks) {
        if (facesByBlock.has(bi)) continue;
        const blockProps = blockFeatures[bi].properties as Record<string, any>;
        const geoId = blockProps.GEOID20 as string;
        const demo = blockDemographics.get(geoId);
        if (!demo) {
          missNoDemo++;
          continue;
        }
        const g = blockGeoms[bi];
        if (!g) {
          stillMissing++;
          missNoGeom++;
          continue;
        }

        // Find a precinct for this block. Try containment first, then
        // intersection, then nearest by bbox center. These blocks are
        // typically offshore/water where VEST precincts don't extend.
        let precinctIdx = -1;
        const rp = geosHelper.pointOnSurface(g);
        if (!rp) {
          stillMissing++;
          missNoRP++;
          continue;
        }
        const rpWkt = geosHelper.toWkt(rp);
        const rpMatch = rpWkt?.match(/-?\d+\.?\d*/g);
        let rpx = 0,
          rpy = 0;
        if (rpMatch && rpMatch.length >= 2) {
          rpx = parseFloat(rpMatch[0]) / COORD_SCALE;
          rpy = parseFloat(rpMatch[1]) / COORD_SCALE;
          const precCands = precinctTree.search({
            minX: rpx - 0.001,
            minY: rpy - 0.001,
            maxX: rpx + 0.001,
            maxY: rpy + 0.001
          });
          for (const pc of precCands) {
            if ((geosHelper as any)._Contains(precinctGeoms[pc.index], rp) === 1) {
              precinctIdx = pc.index;
              break;
            }
          }
        }
        geosHelper.free(rp);

        // Fallback: intersection test with an expanded search, then nearest
        if (precinctIdx === -1 && rpMatch && rpMatch.length >= 2) {
          const precCands = precinctTree.search({
            minX: rpx - 0.1,
            minY: rpy - 0.1,
            maxX: rpx + 0.1,
            maxY: rpy + 0.1
          });
          for (const pc of precCands) {
            if ((geosHelper as any)._Intersects(precinctGeoms[pc.index], g) === 1) {
              precinctIdx = pc.index;
              break;
            }
          }
        }
        if (precinctIdx === -1 && rpMatch && rpMatch.length >= 2 && blocksInBef.has(geoId)) {
          // Nearest-precinct fallback: only for blocks referenced in an
          // official district CSV — these need to survive even though they
          // sit outside real precinct coverage.
          let bestDist = Infinity;
          const allCands = precinctTree.search({
            minX: rpx - 1.0,
            minY: rpy - 1.0,
            maxX: rpx + 1.0,
            maxY: rpy + 1.0
          });
          for (const pc of allCands) {
            const cx = (pc.minX + pc.maxX) / 2;
            const cy = (pc.minY + pc.maxY) / 2;
            const d = (cx - rpx) ** 2 + (cy - rpy) ** 2;
            if (d < bestDist) {
              bestDist = d;
              precinctIdx = pc.index;
            }
          }
        }
        if (precinctIdx === -1) {
          // About to drop this block. Fail loudly if it carries population
          // or any demographic data — that's a signal the BEF set is
          // incomplete and the user needs to add this block to an official
          // district CSV (or otherwise investigate).
          const hasData =
            (demo.population || 0) > 0 ||
            (demo.VAP || 0) > 0 ||
            (demo.CVAP || 0) > 0 ||
            (demo.white || 0) > 0 ||
            (demo.black || 0) > 0 ||
            (demo.asian || 0) > 0 ||
            (demo.hispanic || 0) > 0 ||
            (demo.other || 0) > 0;
          if (hasData) {
            this.error(
              `Block ${geoId} has no precinct coverage and is not in any official district CSV, but carries demographic data (population=${demo.population || 0}). Add it to a BEF CSV under --befDir, or investigate why it lacks precinct coverage.`
            );
          }
          stillMissing++;
          missNoPrec++;
          continue;
        }

        // Clone the block's own geometry as a synthetic face
        const wkt = geosHelper.toWkt(g);
        if (!wkt) {
          stillMissing++;
          missNoWKT++;
          continue;
        }
        const cloned = (geosHelper as any)._WKTReader_read((geosHelper as any).reader, wkt);
        const areaOut = [0];
        (geosHelper as any)._Area(cloned, areaOut);
        facesByBlock.set(bi, [
          {
            geom: cloned,
            area: areaOut[0],
            blockIdx: bi,
            precinctIdx
          }
        ]);
        rescued++;
        if ((demo.population || 0) > 0) rescuedPopulated++;
      }
      this.log(
        `   Third pass (rescue): recovered ${rescued} (${rescuedPopulated} populated), still-missing ${stillMissing} [noDemo=${missNoDemo} noGeom=${missNoGeom} noRP=${missNoRP} noPrec=${missNoPrec} noWKT=${missNoWKT}]`
      );
    }

    // ── Build output features from faces ──
    // Write geometry to temp file as we go — never accumulate full features in memory.
    const outputPath = flags.output.replace("~", process.env.HOME || "");
    mkdirSync(dirname(outputPath), { recursive: true });
    const geomTempPath = outputPath + ".geomseq";
    const geomFd = require("fs").openSync(geomTempPath, "w"); // eslint-disable-line
    const featureProps: Record<string, any>[] = [];

    this.log("\n   Building output features...");
    let singlePrecinct = 0;
    let splitBlocks = 0;
    let noMatch = 0;
    let totalSubBlocks = 0;
    // Detect which adjusted fields are present (varies by state)
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
    if (adjFields.length > 0) {
      this.log(`   Adjusted fields detected: ${adjFields.join(", ")}`);
    }

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
      "CVAP",
      "CVAP White",
      "CVAP Black",
      "CVAP Asian",
      "CVAP Hispanic",
      "CVAP Other"
    ];

    // Track which features were assigned to which precinct for vote reconciliation
    const primaryAssigned = new Map<
      number,
      Map<string, { featureIdx: number; weight: number }[]>
    >();
    const trackAssignment = (pi: number, fi: number, weight: number) => {
      if (!primaryAssigned.has(pi)) primaryAssigned.set(pi, new Map());
      const pa = primaryAssigned.get(pi)!;
      for (const office of Array.from(officesFound)) {
        if (!pa.has(office)) pa.set(office, []);
        pa.get(office)!.push({ featureIdx: fi, weight });
      }
    };

    // Sub-blocks below these thresholds will topo-degenerate (collapse to zero
    // area after presimplify + quantize). Set just above the quantization grid
    // cell (~1m at 1e5) — anything larger is renderable. We deliberately do
    // NOT use a relative ratio here: a sub-block that's 0.1% of a 50,000m²
    // block is still 50m², which is a real precinct fragment, and culling it
    // breaks district contiguity when the precinct relies on that block.
    const MIN_SUB_AREA_M2 = 5;
    const MIN_SUB_WIDTH_M = 2;

    // Two-pass plan:
    //   Pass 1 classifies each block's precincts into viable / sliver using
    //   the tier-1 thresholds (ratio + absolute area + width).
    //   Rescue step then promotes slivers back to viable for any precinct
    //   that ended up with zero viable blocks anywhere, so long as the sliver
    //   passes the looser tier-2 threshold (absolute area + width only).
    //   This keeps precincts alive that exist only as sub-block fragments.
    //   Pass 2 emits features from the (possibly rescued) plans.
    type BlockPlan = {
      blockFeature: any;
      geoId: string;
      countyFp: string;
      demo: any;
      faces: FaceInfo[];
      byPrecinct: Map<number, FaceInfo[]>;
      precinctAreas: Map<number, number>;
      blockArea: number;
      viable: Set<number>;
      slivers: Set<number>;
    };
    const blockPlans: BlockPlan[] = [];
    const precinctViableSomewhere = new Set<number>();
    const sliverCandidates = new Map<
      number,
      { planIdx: number; areaM2: number; widthM: number }[]
    >();

    for (let bi = 0; bi < blockFeatures.length; bi++) {
      const blockFeature = blockFeatures[bi];
      const blockProps = blockFeature.properties as Record<string, any>;
      const geoId = blockProps.GEOID20 as string;
      const countyFp = blockProps.COUNTYFP20 as string;
      const demo = blockDemographics.get(geoId);
      if (!demo) continue;

      const faces = facesByBlock.get(bi);
      if (!faces || faces.length === 0) {
        // Last safety net: if we're about to silently drop a block that
        // carries demographic data, fail loudly. In practice all such drops
        // should have already been caught in the third-pass rescue.
        const hasData =
          (demo.population || 0) > 0 ||
          (demo.VAP || 0) > 0 ||
          (demo.CVAP || 0) > 0 ||
          (demo.white || 0) > 0 ||
          (demo.black || 0) > 0 ||
          (demo.asian || 0) > 0 ||
          (demo.hispanic || 0) > 0 ||
          (demo.other || 0) > 0;
        if (hasData) {
          this.error(
            `Block ${geoId} has demographic data (population=${demo.population || 0}) but no faces were assigned. Add it to a BEF CSV under --befDir, or investigate why it lacks precinct coverage.`
          );
        }
        noMatch++;
        continue;
      }

      const byPrecinct = new Map<number, FaceInfo[]>();
      for (const f of faces) {
        if (!byPrecinct.has(f.precinctIdx)) byPrecinct.set(f.precinctIdx, []);
        byPrecinct.get(f.precinctIdx)!.push(f);
      }

      const blockArea = faces.reduce((s, f) => s + f.area, 0);

      // Single-precinct block: no threshold math, precinct is trivially viable.
      if (byPrecinct.size === 1) {
        const pi = faces[0].precinctIdx;
        precinctViableSomewhere.add(pi);
        blockPlans.push({
          blockFeature,
          geoId,
          countyFp,
          demo,
          faces,
          byPrecinct,
          precinctAreas: new Map([[pi, blockArea]]),
          blockArea,
          viable: new Set([pi]),
          slivers: new Set()
        });
        continue;
      }

      // Convert scaled-coord area to m² using this block's centroid latitude.
      const [, bMinY, , bMaxY] = featureBbox(blockFeature);
      const latRad = (((bMinY + bMaxY) / 2) * Math.PI) / 180;
      const M2_PER_SCALED_DEG2 = (111320 * 111320 * Math.cos(latRad)) / (COORD_SCALE * COORD_SCALE);
      const M_PER_DEG_X = 111320 * Math.cos(latRad);
      const M_PER_DEG_Y = 111320;

      // Width estimate per precinct: fit the sub-block's faces in their
      // combined bbox, then approximate width as area / max(bboxW, bboxH).
      // This is an upper bound on a rectangle's minor dimension (the short
      // side of the tightest enclosing rectangle), which is what actually
      // determines whether the shape survives simplify+quantize.
      const precinctAreas = new Map<number, number>();
      const precinctAreasM2 = new Map<number, number>();
      const precinctWidthsM = new Map<number, number>();
      for (const [pi, pFaces] of byPrecinct) {
        const pArea = pFaces.reduce((s, f) => s + f.area, 0);
        precinctAreas.set(pi, pArea);

        let pMinX = Infinity,
          pMinY = Infinity,
          pMaxX = -Infinity,
          pMaxY = -Infinity;
        for (const f of pFaces) {
          const fgj = geosHelper.toGeoJSONScaled(f.geom, COORD_SCALE);
          if (!fgj) continue;
          const rings = fgj.type === "Polygon" ? fgj.coordinates : fgj.coordinates.flat();
          for (const ring of rings) {
            for (const [x, y] of ring as number[][]) {
              if (x < pMinX) pMinX = x;
              if (y < pMinY) pMinY = y;
              if (x > pMaxX) pMaxX = x;
              if (y > pMaxY) pMaxY = y;
            }
          }
        }
        if (!Number.isFinite(pMinX)) {
          precinctAreasM2.set(pi, 0);
          precinctWidthsM.set(pi, 0);
          continue;
        }
        const bboxWM = (pMaxX - pMinX) * M_PER_DEG_X;
        const bboxHM = (pMaxY - pMinY) * M_PER_DEG_Y;
        const longSide = Math.max(bboxWM, bboxHM);
        const pAreaM2 = pArea * M2_PER_SCALED_DEG2;
        const widthM = longSide > 0 ? pAreaM2 / longSide : 0;
        precinctAreasM2.set(pi, pAreaM2);
        precinctWidthsM.set(pi, widthM);
      }

      const viable = new Set<number>();
      const slivers = new Set<number>();
      for (const pi of precinctAreas.keys()) {
        const areaM2 = precinctAreasM2.get(pi) || 0;
        const widthM = precinctWidthsM.get(pi) || 0;
        if (areaM2 >= MIN_SUB_AREA_M2 && widthM >= MIN_SUB_WIDTH_M) {
          viable.add(pi);
        } else {
          slivers.add(pi);
        }
      }

      const planIdx = blockPlans.length;
      for (const pi of viable) precinctViableSomewhere.add(pi);
      for (const pi of slivers) {
        if (!sliverCandidates.has(pi)) sliverCandidates.set(pi, []);
        sliverCandidates.get(pi)!.push({
          planIdx,
          areaM2: precinctAreasM2.get(pi) || 0,
          widthM: precinctWidthsM.get(pi) || 0
        });
      }

      blockPlans.push({
        blockFeature,
        geoId,
        countyFp,
        demo,
        faces,
        byPrecinct,
        precinctAreas,
        blockArea,
        viable,
        slivers
      });
    }

    // Rescue: any precinct with no viable block anywhere gets its tier-2
    // passing slivers promoted to viable. Slivers below tier 2 would
    // topo-degenerate anyway, so promoting them doesn't help — they stay
    // dropped. A precinct with zero tier-2 survivors is unrescuable and
    // errors below (precincts are precious; we don't silently drop them).
    let rescuedPrecincts = 0;
    let rescuedSlivers = 0;
    let forcedPrecincts = 0;
    let forcedSlivers = 0;
    for (const [pi, candidates] of sliverCandidates) {
      if (precinctViableSomewhere.has(pi)) continue;
      const survivable = candidates.filter(
        c => c.areaM2 >= MIN_SUB_AREA_M2 && c.widthM >= MIN_SUB_WIDTH_M
      );
      // Tier-2 rescue if available; otherwise force the largest sliver through
      // so the precinct stays attached to voting data, even though its sub-block
      // will topo-degenerate (invisible on the map but present in the data).
      const promote =
        survivable.length > 0
          ? survivable
          : [candidates.reduce((a, b) => (a.areaM2 >= b.areaM2 ? a : b))];
      for (const c of promote) {
        const plan = blockPlans[c.planIdx];
        plan.viable.add(pi);
        plan.slivers.delete(pi);
      }
      precinctViableSomewhere.add(pi);
      if (survivable.length > 0) {
        rescuedPrecincts++;
        rescuedSlivers += promote.length;
      } else {
        forcedPrecincts++;
        forcedSlivers += promote.length;
      }
    }
    if (rescuedPrecincts > 0) {
      this.log(
        `   Rescued ${rescuedPrecincts} endangered precincts (${rescuedSlivers} forced sub-blocks)`
      );
    }
    if (forcedPrecincts > 0) {
      this.log(
        `   Forced ${forcedPrecincts} sub-tier-2 precincts (${forcedSlivers} sub-blocks will topo-degenerate)`
      );
    }

    // Pass 2: emit features from the (possibly rescued) plans.
    for (const plan of blockPlans) {
      const {
        blockFeature,
        geoId,
        countyFp,
        demo,
        faces,
        byPrecinct,
        precinctAreas,
        viable,
        slivers
      } = plan;
      const viableArr = [...viable];
      const sliverArr = [...slivers];

      if (viableArr.length <= 1) {
        const bestPi =
          viableArr.length === 1
            ? viableArr[0]
            : [...precinctAreas.entries()].reduce((a, b) => (a[1] > b[1] ? a : b))[0];
        const pData = precinctVoting.get(bestPi)!;
        let merged = faces[0].geom;
        for (let fi = 1; fi < faces.length; fi++) {
          const u = geosHelper.union(merged, faces[fi].geom);
          geosHelper.free(merged);
          geosHelper.free(faces[fi].geom);
          merged = u;
        }
        const geoJSON = geosHelper.toGeoJSONScaled(merged, COORD_SCALE);
        geosHelper.free(merged);
        singlePrecinct++;
        const props = buildBlockProps(
          geoId,
          pData.precinctId,
          countyFp,
          countyNames,
          demo,
          pData.votes,
          pData.totalVotes,
          officesFound,
          detectedYear
        );
        writeSync(geomFd, JSON.stringify(geoJSON || blockFeature.geometry) + "\n");
        trackAssignment(bestPi, featureProps.length, demo.population || 0);
        featureProps.push(props);
        continue;
      }

      // Multiple viable sub-blocks
      splitBlocks++;
      const areaRatios = viableArr.map(pi => precinctAreas.get(pi)!);
      const sliverArea = sliverArr.reduce((s, pi) => s + (precinctAreas.get(pi) || 0), 0);
      const largestIdx = areaRatios.indexOf(Math.max(...areaRatios));
      areaRatios[largestIdx] += sliverArea;

      const apportioned: Record<string, number[]> = {};
      for (const key of demoKeys) {
        apportioned[key] = apportion(demo[key], areaRatios);
      }

      for (let si = 0; si < viableArr.length; si++) {
        totalSubBlocks++;
        const subBlockId = `${geoId}-${si + 1}`;
        const pi = viableArr[si];
        const pData = precinctVoting.get(pi)!;

        const subDemo: Record<string, number> = {};
        for (const key of demoKeys) {
          subDemo[key] = apportioned[key][si];
        }

        const pFaces = byPrecinct.get(pi)!;
        const facesToMerge =
          si === largestIdx
            ? [...pFaces, ...sliverArr.flatMap(sp => byPrecinct.get(sp) || [])]
            : pFaces;

        // Collect face coordinates directly into a MultiPolygon — no GEOS union.
        // Union introduces vertex drift that creates slivers extending into
        // neighboring blocks. Faces from polygonize already share exact edges.
        const polys: number[][][][] = [];
        for (const f of facesToMerge) {
          const faceGJ = geosHelper.toGeoJSONScaled(f.geom, COORD_SCALE);
          if (!faceGJ) continue;
          if (faceGJ.type === "Polygon") polys.push(faceGJ.coordinates);
          else if (faceGJ.type === "MultiPolygon")
            for (const p of faceGJ.coordinates) polys.push(p);
        }
        const subGeoJSON: Polygon | MultiPolygon | null =
          polys.length === 0
            ? null
            : polys.length === 1
              ? { type: "Polygon", coordinates: polys[0] }
              : { type: "MultiPolygon", coordinates: polys };

        const props = buildBlockProps(
          subBlockId,
          pData.precinctId,
          countyFp,
          countyNames,
          subDemo,
          pData.votes,
          pData.totalVotes,
          officesFound,
          detectedYear
        );
        writeSync(geomFd, JSON.stringify(subGeoJSON || blockFeature.geometry) + "\n");
        trackAssignment(pi, featureProps.length, subDemo.population || 0);
        featureProps.push(props);
      }

      // Free remaining face geoms
      for (const f of faces) {
        try {
          geosHelper.free(f.geom);
        } catch {
          /* already freed */
        }
      }
    }

    // Reconcile primary-year votes against precinct totals before freeing
    // precinctVoting. This fixes residuals from per-capita scaling + rounding
    // and guarantees sum(block votes) === precinct votes for every precinct.
    const primaryReconciled = reconcilePrecinctVotes(
      featureProps,
      primaryAssigned,
      (pi: number) => precinctVoting.get(pi)!.votes,
      detectedYear
    );
    this.log(`   Reconciled ${primaryReconciled} precinct-party totals (primary year)`);

    // Close geometry temp file and clean up GEOS geometries (but keep helper alive
    // for addVotingYear — creating a second GeosHelper causes segfaults from
    // re-registering FFI types)
    require("fs").closeSync(geomFd); // eslint-disable-line
    for (const g of blockGeoms) if (g) geosHelper.free(g);
    for (const g of precinctGeoms) if (g) geosHelper.free(g);
    blockFeatures.length = 0;
    vestFeatures.length = 0;
    blockDemographics.clear();
    precinctVoting.clear();
    primaryAssigned.clear();

    // Force glibc to return freed native memory to the OS.
    // Without this, glibc holds onto ~30GB of freed GEOS heap pages.
    try {
      const libc = require("koffi").load("libc.so.6"); // eslint-disable-line
      const mallocTrim = libc.func("malloc_trim", "int", ["int"]);
      mallocTrim(0);
    } catch {
      /* non-critical */
    }

    this.log(`\n   Spatial join complete:`);
    this.log(`     Single precinct: ${singlePrecinct}`);
    this.log(`     Split blocks:    ${splitBlocks} (${totalSubBlocks} sub-blocks)`);
    this.log(`     No match:        ${noMatch}`);
    this.log(`     Total features:  ${featureProps.length}`);

    // Sanity check: every VEST precinct must survive to output. A gap here
    // means (countyFp, precinctField) isn't disambiguating — almost always
    // the wrong --vestPrecinctField for this state's shapefile schema.
    const distinctOutputPrecincts = new Set(featureProps.map(p => p.precinct)).size;
    const vestPrecinctCount = vestFeatures.length;
    this.log(
      `     Distinct output precincts: ${distinctOutputPrecincts} / ${vestPrecinctCount} VEST`
    );
    if (distinctOutputPrecincts < vestPrecinctCount) {
      this.error(
        `Only ${distinctOutputPrecincts} of ${vestPrecinctCount} VEST precincts survived to output. ` +
          `This usually means --vestPrecinctField="${flags.vestPrecinctField}" is not unique enough ` +
          `to disambiguate VEST rows (even combined with county prefix). ` +
          `Inspect the VEST shapefile's DBF fields and pick one that has roughly one distinct value per row.`
      );
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
      const pop = props.population || 0;

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
      featureProps,
      precinctAssigned,
      (pi: number) => precinctData.get(pi)!.votes,
      yy
    );
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
  totalVotes: Record<string, number>,
  officesFound: Set<string>,
  electionYear: string
): Record<string, any> {
  const props: Record<string, any> = {
    block: blockId,
    precinct: `${countyFp}-${precinctId}`,
    county: countyFp,
    county_name: countyNames.get(countyFp) || countyFp,
    ...demo
  };

  // Disaggregate precinct-level votes to this block by per-capita scaling.
  // Reconciliation later fixes up residuals so precinct totals match exactly.
  // Presidential (PRE) uses bare names: democrat20, republican20 (for PVI calculation)
  // Other offices use prefixed names: USS_democrat20, GOV_democrat20, etc.
  const yy = electionYear; // e.g. "20" for 2020
  const pop = demo.population || 0;
  for (const office of Array.from(officesFound)) {
    const v = votes[office] || { democrat: 0, republican: 0, other: 0 };
    const total = totalVotes[office] || 0;
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

  return props;
}

/**
 * Reconcile per-block votes so their sum matches each precinct's exact totals.
 * Adjusts residuals from rounding / per-capita scaling by apportioning the
 * diff across assigned blocks weighted by population contribution.
 */
function reconcilePrecinctVotes(
  featureProps: Record<string, any>[],
  precinctAssigned: Map<number, Map<string, { featureIdx: number; weight: number }[]>>,
  getPrecinctVotes: (
    pi: number
  ) => Record<string, { democrat: number; republican: number; other: number }>,
  electionYear: string
): number {
  const yy = electionYear;
  let reconciled = 0;
  for (const [pi, officeMap] of Array.from(precinctAssigned.entries())) {
    const votes = getPrecinctVotes(pi);
    for (const [office, assignments] of Array.from(officeMap.entries())) {
      const v = votes[office] || { democrat: 0, republican: 0, other: 0 };
      const prefix = office === "PRE" ? "" : `${office}_`;
      for (const party of ["democrat", "republican", "other"] as const) {
        const fieldName = `${prefix}${party}${yy}`;
        const expected = v[party];
        const actual = assignments.reduce(
          (sum, a) => sum + (featureProps[a.featureIdx][fieldName] || 0),
          0
        );
        const diff = expected - actual;
        if (diff === 0) continue;
        reconciled++;
        const weights = assignments.map(a => a.weight);
        const adjustments = apportion(Math.abs(diff), weights);
        const sign = diff > 0 ? 1 : -1;
        for (let i = 0; i < assignments.length; i++) {
          featureProps[assignments[i].featureIdx][fieldName] += sign * adjustments[i];
        }
      }
    }
  }
  return reconciled;
}
