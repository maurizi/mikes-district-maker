import { Args, Command, Flags, ux } from "@oclif/core";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  unlinkSync,
  createReadStream,
  openSync,
  writeSync,
  closeSync,
  renameSync
} from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { IStaticFile, IStaticMetadata } from "../../../shared/entities";
import { geojsonPolygonLabels, tileJoin, tippecanoe } from "../lib/cmd";
import { abbreviateNumber } from "./process-geojson";
import {
  extractZipToDir,
  readShapefile,
  findFileInDir,
  extractVotingData,
  reprojectFeature,
  abbrev,
  mkTypedArray
} from "../lib/voting-data";

interface VestYear {
  readonly precinctVoting: Map<
    string,
    Record<string, { democrat: number; republican: number; other: number }>
  >;
  readonly votingIds: string[];
  readonly electionYear: string;
  readonly officesFound: Set<string>;
}

export default class UpdateVotingData extends Command {
  static description =
    "Update voting data from VEST shapefiles without reprocessing geometry";

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

    // Validate inputs
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
      const vestShp = findFileInDir(vestDir, ".shp");
      let vestFeatures = await readShapefile(vestShp);

      // Reproject if needed
      const prjFiles = readdirSync(vestDir).filter((f: string) => f.endsWith(".prj"));
      if (prjFiles.length > 0) {
        const prjContent = readFileSync(join(vestDir, prjFiles[0]), "utf-8").trim();
        if (prjContent.startsWith("PROJCS")) {
          this.log("  Reprojecting to WGS84...");
          vestFeatures = vestFeatures.map(f => reprojectFeature(f, prjContent));
        }
      }
      this.log(`  ${vestFeatures.length} precincts loaded`);

      // Extract voting data per precinct
      const precinctVoting = new Map<
        string,
        Record<string, { democrat: number; republican: number; other: number }>
      >();
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

      this.log(`  Election year: 20${electionYear}`);
      this.log(`  Offices: ${Array.from(officesFound).sort().join(", ")}`);
      this.log(`  Unique precincts: ${precinctVoting.size}`);

      // Build voting column names for this year
      const yy = electionYear;
      const votingIds: string[] = [];
      for (const office of Array.from(officesFound).sort()) {
        const prefix = office === "PRE" ? "" : `${office}_`;
        votingIds.push(
          `${prefix}democrat${yy}`,
          `${prefix}republican${yy}`,
          `${prefix}other${yy}`
        );
      }

      vestYears.push({ precinctVoting, votingIds, electionYear, officesFound });
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

    // Collect voting data for .buf files (one array per voting column)
    const votingDataArrays: Record<string, number[]> = {};
    for (const id of allNewVotingIds) votingDataArrays[id] = [];

    // Collect aggregates for higher geolevels: gl → levelValue → votingId → sum
    const aggregates: Record<string, Record<string, Record<string, number>>> = {};
    for (const gl of geoLevelIds.slice(1)) aggregates[gl] = {};

    // Stream-update: read line by line, write to temp file
    const tmpBlockPath = blockFullPath + ".tmp";
    const outFd = openSync(tmpBlockPath, "w");

    const rl = require("readline").createInterface({
      // eslint-disable-line
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
        precinctProp && precinctProp.length > 4
          ? precinctProp.substring(4)
          : precinctProp;

      let anyMatch = false;
      for (const vy of vestYears) {
        const vestData = rawPrecinctId ? vy.precinctVoting.get(rawPrecinctId) : null;
        if (vestData) {
          anyMatch = true;
          for (const office of Array.from(vy.officesFound)) {
            const v = vestData[office] || { democrat: 0, republican: 0, other: 0 };
            const prefix = office === "PRE" ? "" : `${office}_`;
            props[`${prefix}democrat${vy.electionYear}`] = v.democrat;
            props[`${prefix}republican${vy.electionYear}`] = v.republican;
            props[`${prefix}other${vy.electionYear}`] = v.other;
          }
        } else {
          // No match for this year — zero out
          for (const id of vy.votingIds) props[id] = 0;
        }
      }

      if (anyMatch) matched++;
      else unmatched++;

      // Add voting abbreviations
      for (const id of allNewVotingIds) {
        props[abbrev(id)] = abbreviateNumber(props[id] || 0);
      }

      // Collect data for .buf files
      for (const id of allNewVotingIds) {
        votingDataArrays[id].push(props[id] || 0);
      }

      // Collect aggregates for higher geolevels using string geolevel properties
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

    this.log(`  Matched: ${matched}, Unmatched: ${unmatched}`);

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

      const rl2 = require("readline").createInterface({
        // eslint-disable-line
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
      this.log(
        `  Wrote ${fileName} (${typedData.constructor.name}, ${data.length} elements)`
      );
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
}
