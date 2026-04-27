// SPDX-License-Identifier: AGPL-3.0-or-later
// © 2026 Michael Maurizi Jr.

import { Args, Command, Flags } from "@oclif/core";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  createReadStream,
  openSync,
  writeSync,
  closeSync,
  renameSync
} from "fs";
import { join } from "path";
import { type IStaticFile, type IStaticMetadata } from "../../../shared/entities";
import { type PropertyOverride } from "../../../shared/ctopo";
import { rewriteContainer } from "../../../shared/ctopo/encode";
import { geojsonPolygonLabels, tileJoin, tippecanoe } from "../lib/cmd";
import { abbreviateNumber } from "./process-geojson";
import { abbrev, mkTypedArray } from "../lib/voting-data";
import { applyVestYearVotes, type VotingBlock } from "../lib/spatial-voting";
import { GeosHelper } from "../lib/geos-helper";
import { createInterface } from "readline";

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

    // ── Step 1: Load blocks (features + geometries) into memory ──
    // We need geometry to spatially match each block against each year's VEST
    // (precinct fields vary year-over-year, so ID-based matching is unsafe).
    // block-full.geojson is line-delimited; each feature has .properties and
    // .geometry.
    const blockFullPath = join(dir, `${baseGeoLevel}-full.geojson`);
    if (!existsSync(blockFullPath)) {
      this.error(`${baseGeoLevel}-full.geojson not found in output directory`);
    }

    this.log("\nLoading block features...");
    const blockFeatures: any[] = [];
    {
      const rl = createInterface({
        input: createReadStream(blockFullPath),
        crlfDelay: Infinity
      });
      for await (const line of rl) {
        const t = (line as string).trim();
        if (!t) continue;
        blockFeatures.push(JSON.parse(t));
      }
    }
    this.log(`  ${blockFeatures.length} blocks`);

    // Strip stale voting properties up front. We'll rewrite them from the
    // fresh VEST data below.
    for (const feature of blockFeatures) {
      for (const id of oldVotingIds) {
        delete feature.properties[id];
        delete feature.properties[abbrev(id)];
      }
    }

    // Build VotingBlock adapters for the spatial helper. Weight is VAP_MOD
    // (backfilled above if it was missing). Fallback to plain VAP keeps old
    // outputs functional but the backfill should normally have run first.
    const blocks: VotingBlock[] = blockFeatures.map((feature, idx) => {
      const p = feature.properties;
      const weight =
        typeof p.VAP_MOD === "number" ? p.VAP_MOD : typeof p.VAP === "number" ? p.VAP : 0;
      return {
        featureIdx: idx,
        geometry: feature.geometry,
        weight,
        getProp: (field: string) => p[field] || 0,
        setProp: (field: string, value: number) => {
          p[field] = value;
        }
      };
    });

    // ── Step 2: For each VEST year, spatially match and disaggregate ──
    const geosHelper = new GeosHelper();
    geosHelper.init();

    const allNewVotingIds: string[] = [];
    try {
      for (let vi = 0; vi < flags.vest.length; vi++) {
        const vestPath = flags.vest[vi].replace("~", process.env.HOME || "");
        const precinctField = flags.precinctField[vi];
        const { votingIds } = await applyVestYearVotes(
          vestPath,
          precinctField,
          blocks,
          geosHelper,
          (s: string) => this.log(s)
        );
        allNewVotingIds.push(...votingIds);
      }
    } finally {
      geosHelper.destroy();
    }

    this.log(`\nNew voting columns: ${allNewVotingIds.join(", ")}`);

    // Pass 2: now that votes are reconciled, write blocks back, fill in
    // abbreviations, collect .buf arrays, and aggregate to higher geolevels.
    const votingDataArrays: Record<string, number[]> = {};
    for (const id of allNewVotingIds) votingDataArrays[id] = [];
    const aggregates: Record<string, Record<string, Record<string, number>>> = {};
    for (const gl of geoLevelIds.slice(1)) aggregates[gl] = {};

    const tmpBlockPath = blockFullPath + ".tmp";
    const outFd = openSync(tmpBlockPath, "w");

    for (const feature of blockFeatures) {
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

    // Collect per-geolevel voting arrays in feature-index order so we
    // can hand them straight to rewriteContainer below — the
    // *-full.geojson iteration order matches the topology's geometry
    // order for that level (both are produced from the same encode
    // pass in process-geojson.ts).
    const higherLevelArrays: Record<string, Record<string, number[]>> = {};
    for (const gl of geoLevelIds.slice(1)) {
      higherLevelArrays[gl] = {};
      for (const id of allNewVotingIds) higherLevelArrays[gl][id] = [];
    }

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
          const value = agg ? agg[id] || 0 : 0;
          props[id] = value;
          props[abbrev(id)] = abbreviateNumber(value);
          higherLevelArrays[gl][id].push(value);
        }

        writeSync(fd, JSON.stringify(feature) + "\n");
      }

      closeSync(fd);
      renameSync(tmpPath, fullPath);
    }

    // ── Step 4: Swap voting sections in region.ctopo ──
    this.log("\nRewriting region.ctopo with new voting data...");

    const ctopoPath = join(dir, "region.ctopo");
    if (!existsSync(ctopoPath)) {
      this.error("region.ctopo not found in output directory");
    }

    // One override per (geolevel, voting id). For the base level we
    // already collected per-feature values in votingDataArrays during
    // step 2; higher levels were collected during step 3.
    const overrides: PropertyOverride[] = [];
    for (const id of allNewVotingIds) {
      overrides.push({ name: `${baseGeoLevel}/${id}`, data: votingDataArrays[id] });
      for (const gl of geoLevelIds.slice(1)) {
        overrides.push({ name: `${gl}/${id}`, data: higherLevelArrays[gl][id] });
      }
    }

    const tmpCtopo = ctopoPath + ".tmp";
    await rewriteContainer(ctopoPath, tmpCtopo, overrides);
    renameSync(tmpCtopo, ctopoPath);
    this.log(`  Swapped ${overrides.length} voting sections across ${geoLevelIds.length} layers`);

    // votingMetadata feeds the legacy IStaticMetadata.voting list — kept
    // populated so a subsequent run of this command can identify stale
    // voting columns to strip from the *-full.geojson files. The .buf
    // files themselves are no longer written; their data lives in
    // region.ctopo's per-layer voting sections.
    const votingMetadata: IStaticFile[] = allNewVotingIds.map(id => ({
      id,
      fileName: `${id}.buf`,
      bytesPerElement: 4,
      unsigned: true
    }));

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
    this.log(`  Features updated: ${blockFeatures.length}`);
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
        typed instanceof Uint8Array || typed instanceof Uint16Array || typed instanceof Uint32Array
    };
    (metadata as unknown as { demographics: IStaticFile[] }).demographics = [
      ...metadata.demographics,
      newDemographic
    ];
    writeFileSync(join(dir, "static-metadata.json"), JSON.stringify(metadata));
    this.log(`  Wrote VAP_MOD.buf (${typed.constructor.name}) and updated metadata`);
  }
}
