import { Args, Command, Flags } from "@oclif/core";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  unlinkSync,
  createReadStream,
  openSync,
  writeSync,
  closeSync,
  renameSync
} from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { type IStaticFile, type IStaticMetadata } from "../../../shared/entities";
import { geojsonPolygonLabels, tileJoin, tippecanoe } from "../lib/cmd";
import { abbreviateNumber } from "./process-geojson";
import {
  extractZipToDir,
  readShapefile,
  findShapefile,
  extractVotingData,
  reprojectFeature,
  abbrev,
  mkTypedArray,
  disaggregateBlockVotes,
  reconcilePrecinctVotes,
  type PartyVotes
} from "../lib/voting-data";
import { createInterface } from "readline";

interface VestYear {
  readonly precinctVoting: Map<string, Record<string, PartyVotes>>;
  // Sum of democrat+republican+other per precinct per office, used as the
  // denominator in vote share. Precomputed once so the per-block loop stays cheap.
  readonly precinctTotalVotes: Map<string, Record<string, number>>;
  readonly votingIds: string[];
  readonly electionYear: string;
  readonly officesFound: Set<string>;
}

export default class UpdateVotingData extends Command {
  static description = "Update voting data from VEST shapefiles without reprocessing geometry";

  static args = {
    outputDir: Args.string({
      description:
        "Existing process-geojson output directory (contains topo.json, *.mbtiles, etc.)",
      required: true
    })
  };

  static flags = {
    vest: Flags.string({
      char: "v",
      description: "Path to VEST shapefile zip (repeatable for multiple election years)",
      required: true,
      multiple: true
    }),
    precinctField: Flags.string({
      char: "p",
      description: "Precinct field name in VEST shapefile (one per --vest)",
      required: true,
      multiple: true
    }),
    s3Dir: Flags.string({
      description: "S3 directory to upload changed files to",
      default: ""
    })
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(UpdateVotingData);
    const dir = args.outputDir;

    if (!existsSync(join(dir, "static-metadata.json"))) {
      this.error("static-metadata.json not found in output directory");
    }
    if (flags.vest.length !== flags.precinctField.length) {
      this.error("Number of --vest and --precinctField flags must match");
    }

    // Read existing metadata
    const metadata: IStaticMetadata = JSON.parse(
      readFileSync(join(dir, "static-metadata.json"), "utf-8")
    );
    const geoLevelHierarchy = metadata.geoLevelHierarchy;
    const geoLevelIds = geoLevelHierarchy.map((g: any) => g.id);
    const baseGeoLevel = geoLevelIds[0];
    const demographicIds = metadata.demographics.map((d: any) => d.id);
    const oldVotingIds = (metadata.voting || []).map((v: any) => v.id);

    this.log(`Geolevels: ${geoLevelIds.join(", ")}`);
    this.log(`Old voting columns: ${oldVotingIds.join(", ") || "(none)"}`);

    // Determine which property holds the precinct assignment.
    const precinctLevel = geoLevelIds.find((id: string) => id === "precinct") || geoLevelIds[1];
    if (!precinctLevel) {
      this.error("Cannot determine precinct geolevel from hierarchy");
    }

    // ── Step 0: Backfill VAP_MOD if absent ──
    // Older output dirs (built before the VAP_MOD methodology change) lack
    // VAP_MOD on their block features. One-time fix: fetch the prison count
    // (P5_003N), compute VAP_MOD = max(0, VAP - prison) per block, inject it
    // into block-full + higher-level *-full geojsons, write VAP_MOD.buf, and
    // record VAP_MOD in static-metadata. After this the dir is permanently
    // VAP_MOD-equipped and future runs use it directly.
    if (!metadata.demographics.some(d => d.id === "VAP_MOD")) {
      await this.backfillVapMod(dir, metadata, geoLevelIds, baseGeoLevel);
    }

    // ── Step 1: Load all VEST data ──
    const vestYears: VestYear[] = [];
    const allNewVotingIds: string[] = [];

    for (let vi = 0; vi < flags.vest.length; vi++) {
      const vestPath = flags.vest[vi].replace("~", process.env.HOME || "");
      const precinctField = flags.precinctField[vi];

      this.log(`\nLoading VEST: ${vestPath}`);
      const vestBuffer = readFileSync(vestPath);
      const vestDir = join(tmpdir(), `vest-update-${Date.now()}-${vi}`);
      await extractZipToDir(vestBuffer, vestDir);
      const { shpPath: vestShp, dbfPath: vestDbf, prjPath: vestPrj } = findShapefile(vestDir);
      let vestFeatures = await readShapefile(vestShp, vestDbf);

      // Reproject if needed
      if (vestPrj) {
        const prjContent = readFileSync(vestPrj, "utf-8").trim();
        if (prjContent.startsWith("PROJCS")) {
          this.log("  Reprojecting to WGS84...");
          vestFeatures = vestFeatures.map(f => reprojectFeature(f, prjContent));
        }
      }
      this.log(`  ${vestFeatures.length} precincts loaded (${vestShp})`);

      // Extract voting data per precinct
      const precinctVoting = new Map<string, Record<string, PartyVotes>>();
      const officesFound = new Set<string>();
      let electionYear = "";

      for (let i = 0; i < vestFeatures.length; i++) {
        const props = vestFeatures[i].properties as Record<string, any>;
        const rawPrecinctId = String(props[precinctField] ?? `vest_${i}`);
        const { byOffice, electionYear: yr } = extractVotingData(props);
        if (yr && !electionYear) electionYear = yr;
        for (const office of Object.keys(byOffice)) officesFound.add(office);

        // Merge multi-polygon precincts (multiple features with same ID)
        if (precinctVoting.has(rawPrecinctId)) {
          const existing = precinctVoting.get(rawPrecinctId)!;
          for (const [office, v] of Object.entries(byOffice)) {
            if (!existing[office]) existing[office] = { democrat: 0, republican: 0, other: 0 };
            existing[office].democrat += v.democrat;
            existing[office].republican += v.republican;
            existing[office].other += v.other;
          }
        } else {
          precinctVoting.set(rawPrecinctId, byOffice);
        }
      }

      // Precompute per-precinct, per-office vote totals for share-of-vote math.
      const precinctTotalVotes = new Map<string, Record<string, number>>();
      for (const [pid, byOffice] of precinctVoting) {
        const totals: Record<string, number> = {};
        for (const [office, v] of Object.entries(byOffice)) {
          totals[office] = v.democrat + v.republican + v.other;
        }
        precinctTotalVotes.set(pid, totals);
      }

      this.log(`  Election year: 20${electionYear}`);
      this.log(`  Offices: ${Array.from(officesFound).sort().join(", ")}`);
      this.log(`  Unique precincts: ${precinctVoting.size}`);

      // Build voting column names for this year
      const yy = electionYear;
      const votingIds: string[] = [];
      for (const office of Array.from(officesFound).sort()) {
        const prefix = office === "PRE" ? "" : `${office}_`;
        votingIds.push(`${prefix}democrat${yy}`, `${prefix}republican${yy}`, `${prefix}other${yy}`);
      }

      vestYears.push({
        precinctVoting,
        precinctTotalVotes,
        votingIds,
        electionYear,
        officesFound
      });
      allNewVotingIds.push(...votingIds);
    }

    this.log(`\nNew voting columns: ${allNewVotingIds.join(", ")}`);

    // ── Step 2: Update block-level features ──
    // Use *-full.geojson which has string geolevel properties (precinct, county)
    // and demographic abbreviations needed for label generation.
    const blockFullPath = join(dir, `${baseGeoLevel}-full.geojson`);
    if (!existsSync(blockFullPath)) {
      this.error(`${baseGeoLevel}-full.geojson not found in output directory`);
    }

    this.log("\nUpdating block-level features...");

    // Pass 1: read every block into memory, do the per-block disaggregation
    // (rounded), and remember which blocks belong to which precinct so we can
    // reconcile rounding residuals at precinct level afterwards. Reconciliation
    // requires seeing every block in a precinct at once, so we can't stream it.
    type BlockEntry = { feature: any; weight: number };
    const blocks: BlockEntry[] = [];

    // Per-year: precinct id → office → assignments (for reconcilePrecinctVotes).
    // Keyed by string precinct id (not numeric pi like prepare-dev-data) because
    // we're matching against the precinct property already baked into block-full.
    const yearAssigned: Map<string, Map<string, { featureIdx: number; weight: number }[]>>[] =
      vestYears.map(() => new Map());

    const rl = createInterface({
      input: createReadStream(blockFullPath),
      crlfDelay: Infinity
    });

    let matched = 0,
      unmatched = 0;

    for await (const line of rl) {
      const trimmed = (line as string).trim();
      if (!trimmed) continue;

      const feature = JSON.parse(trimmed);
      const props = feature.properties;

      // Remove old voting properties and abbreviations
      for (const id of oldVotingIds) {
        if (!allNewVotingIds.includes(id)) {
          delete props[id];
          delete props[abbrev(id)];
        }
      }

      // Look up precinct: the full geojson has the string precinct property.
      // Format is "${countyFp}-${rawPrecinctId}" where countyFp is 3 chars.
      const precinctProp: string | undefined = props[precinctLevel];
      const rawPrecinctId =
        precinctProp && precinctProp.length > 4 ? precinctProp.substring(4) : precinctProp;

      // Disaggregation weight: VAP_MOD if available (post-prison-adjustment
      // pipeline), else fall back to plain VAP for older outputs.
      const weight =
        typeof props.VAP_MOD === "number"
          ? props.VAP_MOD
          : typeof props.VAP === "number"
            ? props.VAP
            : 0;

      let anyMatch = false;
      for (let yi = 0; yi < vestYears.length; yi++) {
        const vy = vestYears[yi];
        const vestData = rawPrecinctId ? vy.precinctVoting.get(rawPrecinctId) : undefined;
        const vestTotals = rawPrecinctId ? vy.precinctTotalVotes.get(rawPrecinctId) : undefined;
        if (vestData && vestTotals) {
          anyMatch = true;
          Object.assign(
            props,
            disaggregateBlockVotes(vestData, vestTotals, weight, vy.officesFound, vy.electionYear)
          );
          // Track this block under its precinct for reconciliation.
          let precMap = yearAssigned[yi].get(rawPrecinctId!);
          if (!precMap) {
            precMap = new Map();
            yearAssigned[yi].set(rawPrecinctId!, precMap);
          }
          for (const office of Array.from(vy.officesFound)) {
            let arr = precMap.get(office);
            if (!arr) {
              arr = [];
              precMap.set(office, arr);
            }
            arr.push({ featureIdx: blocks.length, weight });
          }
        } else {
          // No precinct match this year — zero votes for this block this year.
          for (const id of vy.votingIds) props[id] = 0;
        }
      }

      if (anyMatch) matched++;
      else unmatched++;

      blocks.push({ feature, weight });
    }

    this.log(`  Matched: ${matched}, Unmatched: ${unmatched}`);

    // Reconcile rounding residuals so per-precinct sums match VEST exactly.
    let totalReconciled = 0;
    for (let yi = 0; yi < vestYears.length; yi++) {
      const vy = vestYears[yi];
      totalReconciled += reconcilePrecinctVotes(
        yearAssigned[yi],
        (precinctId: string) => vy.precinctVoting.get(precinctId) || {},
        (idx, field) => blocks[idx].feature.properties[field] || 0,
        (idx, field, value) => {
          blocks[idx].feature.properties[field] = value;
        },
        vy.electionYear
      );
    }
    this.log(`  Reconciled ${totalReconciled} precinct-party totals`);

    // Pass 2: now that votes are reconciled, write blocks back, fill in
    // abbreviations, collect .buf arrays, and aggregate to higher geolevels.
    const votingDataArrays: Record<string, number[]> = {};
    for (const id of allNewVotingIds) votingDataArrays[id] = [];
    const aggregates: Record<string, Record<string, Record<string, number>>> = {};
    for (const gl of geoLevelIds.slice(1)) aggregates[gl] = {};

    const tmpBlockPath = blockFullPath + ".tmp";
    const outFd = openSync(tmpBlockPath, "w");

    for (const { feature } of blocks) {
      const props = feature.properties;

      for (const id of allNewVotingIds) {
        props[abbrev(id)] = abbreviateNumber(props[id] || 0);
        votingDataArrays[id].push(props[id] || 0);
      }

      for (const gl of geoLevelIds.slice(1)) {
        const levelValue = props[gl];
        if (levelValue !== undefined) {
          if (!aggregates[gl][levelValue]) {
            aggregates[gl][levelValue] = {};
            for (const id of allNewVotingIds) aggregates[gl][levelValue][id] = 0;
          }
          for (const id of allNewVotingIds) {
            aggregates[gl][levelValue][id] += props[id] || 0;
          }
        }
      }

      writeSync(outFd, JSON.stringify(feature) + "\n");
    }

    closeSync(outFd);
    renameSync(tmpBlockPath, blockFullPath);

    // ── Step 3: Update higher-level *-full.geojson files ──
    for (const gl of geoLevelIds.slice(1)) {
      const fullPath = join(dir, `${gl}-full.geojson`);
      if (!existsSync(fullPath)) {
        this.log(`  Skipping ${gl}-full.geojson (not found)`);
        continue;
      }

      this.log(`  Updating ${gl}-full.geojson`);
      const tmpPath = fullPath + ".tmp";
      const fd = openSync(tmpPath, "w");

      const rl2 = createInterface({
        input: createReadStream(fullPath),
        crlfDelay: Infinity
      });

      for await (const line of rl2) {
        const trimmed = (line as string).trim();
        if (!trimmed) continue;

        const feature = JSON.parse(trimmed);
        const props = feature.properties;
        const levelValue = props[gl];

        // Remove old voting properties and abbreviations
        for (const id of oldVotingIds) {
          if (!allNewVotingIds.includes(id)) {
            delete props[id];
            delete props[abbrev(id)];
          }
        }

        // Assign aggregated voting data
        const agg = levelValue !== undefined ? aggregates[gl][levelValue] : undefined;
        for (const id of allNewVotingIds) {
          props[id] = agg ? agg[id] || 0 : 0;
          props[abbrev(id)] = abbreviateNumber(props[id]);
        }

        writeSync(fd, JSON.stringify(feature) + "\n");
      }

      closeSync(fd);
      renameSync(tmpPath, fullPath);
    }

    // ── Step 4: Write .buf files ──
    this.log("\nWriting .buf files...");

    // Delete old voting .buf files that are no longer needed
    for (const id of oldVotingIds) {
      if (!allNewVotingIds.includes(id)) {
        const bufPath = join(dir, `${id}.buf`);
        if (existsSync(bufPath)) {
          unlinkSync(bufPath);
          this.log(`  Deleted ${id}.buf`);
        }
      }
    }

    // Write new voting .buf files
    const votingMetadata: IStaticFile[] = allNewVotingIds.map(id => {
      const data = votingDataArrays[id];
      const typedData = mkTypedArray(data);
      const fileName = `${id}.buf`;
      writeFileSync(join(dir, fileName), typedData);
      this.log(`  Wrote ${fileName} (${typedData.constructor.name}, ${data.length} elements)`);
      return {
        id,
        fileName,
        bytesPerElement: typedData.BYTES_PER_ELEMENT,
        unsigned:
          typedData instanceof Uint8Array ||
          typedData instanceof Uint16Array ||
          typedData instanceof Uint32Array
      };
    });

    // ── Step 5: Regenerate label tiles ──
    this.log("\nRegenerating label tiles...");

    const minZooms = geoLevelHierarchy.map((g: any) => g.minZoom);
    const maxZooms = geoLevelHierarchy.map((g: any) => g.maxZoom);
    const globalMaxZoom = maxZooms[0]; // block layer has the highest maxZoom

    const labelsMbtiles: string[] = [];
    const separateMbtiles: string[] = [];

    for (let i = 0; i < geoLevelIds.length; i++) {
      const gl = geoLevelIds[i];
      // Use *-full.geojson for labels — it has both demographic and voting abbreviations
      const fullGeojsonPath = join(dir, `${gl}-full.geojson`);
      const labelPath = join(dir, `${gl}-labels.geojson`);
      const labelOutput = join(dir, `${gl}-labels.mbtiles`);
      const geoMbtiles = join(dir, `${gl}.mbtiles`);

      if (!existsSync(fullGeojsonPath)) {
        this.log(`  Skipping labels for ${gl} (${gl}-full.geojson not found)`);
        continue;
      }

      this.log(`  Generating labels for ${gl}`);
      geojsonPolygonLabels(
        fullGeojsonPath,
        {
          collections: "largest",
          "input-format": "geojsonseq",
          "output-format": "geojsonseq"
        },
        { outputPath: labelPath }
      );

      tippecanoe(labelPath, {
        include: [...demographicIds.map(abbrev), ...allNewVotingIds.map(abbrev)],
        force: true,
        readParallel: true,
        maximumZoom: globalMaxZoom,
        minimumZoom: minZooms[i],
        noTileCompression: true,
        noTileSizeLimit: true,
        dropRate: 1,
        output: labelOutput
      });

      labelsMbtiles.push(labelOutput);
      if (existsSync(geoMbtiles)) separateMbtiles.push(geoMbtiles);
    }

    // ── Step 6: Merge tiles into PMTiles ──
    this.log("\nMerging tiles...");
    const outputPmtiles = join(dir, "tiles.pmtiles");
    tileJoin([...separateMbtiles, ...labelsMbtiles], {
      force: true,
      noTileSizeLimit: true,
      output: outputPmtiles
    });

    // ── Step 7: Update static-metadata.json ──
    this.log("\nUpdating static-metadata.json...");
    const updatedMetadata: IStaticMetadata = {
      ...metadata,
      voting: votingMetadata
    };
    writeFileSync(join(dir, "static-metadata.json"), JSON.stringify(updatedMetadata));

    // ── Done ──
    this.log("\nDone!");
    this.log(`  Voting columns: ${allNewVotingIds.join(", ")}`);
    this.log(`  Features updated: ${matched + unmatched}`);
    this.log(`  Output: ${dir}`);

    process.exit(0);
  }

  // One-time backfill: derive VAP_MOD from existing VAP + freshly-fetched
  // P5_003N (adult correctional pop), inject it into block-full and higher
  // *-full geojsons, write VAP_MOD.buf, and add the demographic to metadata.
  // Mutates `metadata.demographics` so the caller sees the new entry.
  private async backfillVapMod(
    dir: string,
    metadata: IStaticMetadata,
    geoLevelIds: readonly string[],
    baseGeoLevel: string
  ): Promise<void> {
    const blockFullPath = join(dir, `${baseGeoLevel}-full.geojson`);
    if (!existsSync(blockFullPath)) {
      this.error(`${blockFullPath} not found; can't backfill VAP_MOD`);
    }

    this.log("\nVAP_MOD missing from metadata; backfilling...");

    // Pass 1: load every feature into memory, derive state FIPS from the first
    // GEOID, and sum VAP per base block (so split sub-blocks share their
    // parent's prison count proportionally to their VAP share).
    type Feat = { feature: any; baseGeoid: string };
    const feats: Feat[] = [];
    const baseVap = new Map<string, number>();
    let stateFips = "";

    const rl = createInterface({
      input: createReadStream(blockFullPath),
      crlfDelay: Infinity
    });
    for await (const line of rl) {
      const t = (line as string).trim();
      if (!t) continue;
      const f = JSON.parse(t);
      const geoid = String(f.properties.block || "");
      if (!stateFips && geoid.length >= 2) stateFips = geoid.substring(0, 2);
      const base = geoid.split("-")[0];
      baseVap.set(base, (baseVap.get(base) || 0) + (f.properties.VAP || 0));
      feats.push({ feature: f, baseGeoid: base });
    }
    if (!stateFips) this.error("Could not determine state FIPS from block GEOIDs");

    // Fetch P5_003N for the state (one API call, ~few seconds).
    this.log(`  Fetching P5_003N for state FIPS ${stateFips}...`);
    const url = `https://api.census.gov/data/2020/dec/pl?get=P5_003N&for=block:*&in=state:${stateFips}&in=county:*&in=tract:*`;
    const resp = await fetch(url);
    if (!resp.ok) this.error(`Census API failed: ${resp.status}`);
    const data: string[][] = await resp.json();
    const prisonByBase = new Map<string, number>();
    for (let i = 1; i < data.length; i++) {
      const [v, st, cty, tr, blk] = data[i];
      prisonByBase.set(`${st}${cty}${tr}${blk}`, parseInt(v) || 0);
    }
    this.log(`  Loaded prison pop for ${prisonByBase.size} base blocks`);

    // Compute VAP_MOD per feature, apportioning each base block's prison count
    // across its sub-blocks proportionally to VAP. Collect per-block values for
    // the .buf and sums per higher geolevel for higher-level *-full updates.
    const blockVapMod: number[] = [];
    const aggByLevel: Record<string, Record<string, number>> = {};
    for (const gl of geoLevelIds.slice(1)) aggByLevel[gl] = {};

    const tmpPath = blockFullPath + ".tmp";
    const outFd = openSync(tmpPath, "w");
    for (const { feature, baseGeoid } of feats) {
      const props = feature.properties;
      const vap = typeof props.VAP === "number" ? props.VAP : 0;
      const baseV = baseVap.get(baseGeoid) || 0;
      const prison = prisonByBase.get(baseGeoid) || 0;
      const subPrison = baseV > 0 ? Math.round((prison * vap) / baseV) : prison;
      const vapMod = Math.max(0, vap - subPrison);
      props.VAP_MOD = vapMod;
      blockVapMod.push(vapMod);
      for (const gl of geoLevelIds.slice(1)) {
        const lv = props[gl];
        if (lv !== undefined) aggByLevel[gl][lv] = (aggByLevel[gl][lv] || 0) + vapMod;
      }
      writeSync(outFd, JSON.stringify(feature) + "\n");
    }
    closeSync(outFd);
    renameSync(tmpPath, blockFullPath);
    this.log(`  Injected VAP_MOD into ${feats.length} block features`);

    // Update higher-level *-full.geojson files (precinct, county, ...).
    for (const gl of geoLevelIds.slice(1)) {
      const path = join(dir, `${gl}-full.geojson`);
      if (!existsSync(path)) continue;
      const tmp = path + ".tmp";
      const fd = openSync(tmp, "w");
      const r = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
      for await (const line of r) {
        const t = (line as string).trim();
        if (!t) continue;
        const f = JSON.parse(t);
        const lv = f.properties[gl];
        f.properties.VAP_MOD = lv !== undefined ? aggByLevel[gl][lv] || 0 : 0;
        writeSync(fd, JSON.stringify(f) + "\n");
      }
      closeSync(fd);
      renameSync(tmp, path);
    }

    // Write VAP_MOD.buf and update static-metadata. (demographics is readonly
    // on the type — rebuild the array instead of mutating in place.)
    const typed = mkTypedArray(blockVapMod);
    writeFileSync(join(dir, "VAP_MOD.buf"), typed);
    const newDemographic: IStaticFile = {
      id: "VAP_MOD",
      fileName: "VAP_MOD.buf",
      bytesPerElement: typed.BYTES_PER_ELEMENT,
      unsigned:
        typed instanceof Uint8Array ||
        typed instanceof Uint16Array ||
        typed instanceof Uint32Array
    };
    (metadata as unknown as { demographics: IStaticFile[] }).demographics = [
      ...metadata.demographics,
      newDemographic
    ];
    writeFileSync(join(dir, "static-metadata.json"), JSON.stringify(metadata));
    this.log(`  Wrote VAP_MOD.buf (${typed.constructor.name}) and updated metadata`);
  }
}

