import { Args, Command, Flags } from "@oclif/core";
import { writeFileSync, mkdirSync, existsSync } from "fs";
import { dirname, join } from "path";
import { tmpdir } from "os";
import * as shapefile from "shapefile";
import * as unzipper from "unzipper";

async function extractZipToDir(zipBuffer: Buffer, dir: string): Promise<void> {
  mkdirSync(dir, { recursive: true });
  const zip = await unzipper.Open.buffer(zipBuffer);
  await zip.extract({ path: dir });
}

async function readShapefile(shpPath: string, dbfPath?: string): Promise<GeoJSON.Feature[]> {
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
  const { readdirSync } = require("fs"); // eslint-disable-line
  const files = readdirSync(dir) as string[];
  const found = files.find((f: string) => f.endsWith(extension));
  if (!found) throw new Error(`No ${extension} file found in ${dir}`);
  return join(dir, found);
}

export default class PrepareDevData extends Command {
  static description =
    "Download Census block data and demographics, optionally join VEST voting data, and output GeoJSON for process-geojson";

  static flags = {
    vest: Flags.string({
      char: "v",
      description: "Path to VEST election shapefile zip (optional)"
    }),
    vestPrecinctField: Flags.string({
      char: "p",
      description: "VEST shapefile field name for precinct ID",
      default: "PRECINCT"
    }),
    output: Flags.string({
      char: "o",
      description: "Output GeoJSON file path",
      default: "dev-data/output.geojson"
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

    // Step 1: Download Census block shapefile
    this.log("\n1. Downloading Census block shapefile...");
    const tigerUrl = `https://www2.census.gov/geo/tiger/TIGER2020/TABBLOCK20/tl_2020_${stateFips}_tabblock20.zip`;
    const tigerResp = await fetch(tigerUrl);
    if (!tigerResp.ok) throw new Error(`Failed to download TIGER data: ${tigerResp.status}`);
    const tigerBuffer = Buffer.from(await tigerResp.arrayBuffer());
    this.log(`   Downloaded ${(tigerBuffer.length / 1024 / 1024).toFixed(1)}MB`);

    const tigerDir = join(tmp, "tiger");
    await extractZipToDir(tigerBuffer, tigerDir);
    const shpFile = findFileInDir(tigerDir, ".shp");
    const dbfFile = findFileInDir(tigerDir, ".dbf");
    const blockFeatures = await readShapefile(shpFile, dbfFile);
    this.log(`   ${blockFeatures.length} blocks loaded`);

    // Step 2: Download Block Assignment File (block → VTD/precinct)
    this.log("\n2. Downloading Block Assignment File...");
    const bafUrl = `https://www2.census.gov/geo/docs/maps-data/data/baf2020/BlockAssign_ST${stateFips}_${stateAbbr}.zip`;
    const bafResp = await fetch(bafUrl);
    if (!bafResp.ok) throw new Error(`Failed to download BAF: ${bafResp.status}`);

    const bafBuffer = Buffer.from(await bafResp.arrayBuffer());
    const bafZip = await unzipper.Open.buffer(bafBuffer);
    const vtdEntry = bafZip.files.find((f: any) => f.path.includes("_VTD.txt"));
    if (!vtdEntry) throw new Error("VTD file not found in BAF zip");
    const vtdContent = (await vtdEntry.buffer()).toString("utf-8");

    const blockToVtd = new Map<string, string>();
    for (const line of vtdContent.split("\n")) {
      if (!line.trim() || line.startsWith("BLOCKID")) continue;
      const parts = line.trim().split("|");
      const blockId = parts[0];
      const district = parts[2];
      if (!blockId || !district) continue;
      // Normalize: BAF uses 3-digit county prefix (001-01), VEST uses 2-digit (01-01)
      const normalizedDistrict = district.replace(/^0(\d\d-)/, "$1");
      blockToVtd.set(blockId, normalizedDistrict);
    }
    this.log(`   ${blockToVtd.size} block-to-precinct mappings loaded`);

    // Step 3: Fetch demographics from Census API
    this.log("\n3. Fetching demographics from Census API...");
    const censusUrl = `https://api.census.gov/data/2020/dec/pl?get=P1_001N,P1_003N,P1_004N,P1_006N,P2_002N&for=block:*&in=state:${stateFips}&in=county:*&in=tract:*`;
    const censusResp = await fetch(censusUrl);
    if (!censusResp.ok) throw new Error(`Census API failed: ${censusResp.status}`);
    const censusData: string[][] = await censusResp.json();

    const blockDemographics = new Map<string, Record<string, number>>();
    for (let i = 1; i < censusData.length; i++) {
      const [pop, white, black, asian, hispanic, state, county, tract, block] = censusData[i];
      const geoId = `${state}${county}${tract}${block}`;
      const popN = parseInt(pop) || 0;
      const whiteN = parseInt(white) || 0;
      const blackN = parseInt(black) || 0;
      const asianN = parseInt(asian) || 0;
      const hispanicN = parseInt(hispanic) || 0;
      const otherN = Math.max(0, popN - whiteN - blackN - asianN - hispanicN);
      blockDemographics.set(geoId, {
        population: popN,
        white: whiteN,
        black: blackN,
        asian: asianN,
        hispanic: hispanicN,
        other: otherN
      });
    }
    this.log(`   ${blockDemographics.size} block demographics loaded`);

    // Step 4: Optionally load VEST voting data
    let precinctVoting: Map<string, Record<string, number>> | null = null;
    if (flags.vest) {
      this.log("\n4. Loading VEST voting data...");
      const vestPath = flags.vest.replace("~", process.env.HOME || "");
      const vestBuffer = require("fs").readFileSync(vestPath); // eslint-disable-line
      const vestDir = join(tmp, "vest");
      await extractZipToDir(vestBuffer, vestDir);
      const vestShp = findFileInDir(vestDir, ".shp");
      const vestDbf = findFileInDir(vestDir, ".dbf");
      const vestFeatures = await readShapefile(vestShp, vestDbf);

      precinctVoting = new Map();
      for (const feature of vestFeatures) {
        const props = feature.properties as Record<string, any>;
        const precinctId = props[flags.vestPrecinctField] as string;
        // Aggregate presidential votes by party: D=democrat, R=republican, else=other
        // Column format: G20PRERTRU — character 7 is the party code
        let democrat = 0;
        let republican = 0;
        let otherVotes = 0;
        for (const [key, value] of Object.entries(props)) {
          if (key.match(/^G\d\dPRE/)) {
            const votes = typeof value === "number" ? value : parseInt(String(value)) || 0;
            const partyCode = key.charAt(6);
            if (partyCode === "D") {
              democrat += votes;
            } else if (partyCode === "R") {
              republican += votes;
            } else {
              otherVotes += votes;
            }
          }
        }
        precinctVoting.set(precinctId, { democrat, republican, otherparty: otherVotes });
      }
      this.log(`   ${precinctVoting.size} precincts with voting data loaded`);
    } else {
      this.log("\n4. No VEST data provided, skipping voting data");
    }

    // Step 5: Join everything onto block features
    this.log("\n5. Joining data onto block features...");
    let matched = 0;
    let unmatched = 0;
    const outputFeatures: GeoJSON.Feature[] = [];

    for (const feature of blockFeatures) {
      const props = feature.properties as Record<string, any>;
      const geoId = props.GEOID20 as string;
      const countyFp = props.COUNTYFP20 as string;

      const demo = blockDemographics.get(geoId);
      const precinct = blockToVtd.get(geoId);

      if (!demo || !precinct) {
        unmatched++;
        continue;
      }

      matched++;
      const newProps: Record<string, any> = {
        block: geoId,
        precinct,
        county: countyFp,
        ...demo
      };

      if (precinctVoting) {
        const votes = precinctVoting.get(precinct);
        // Default to zeros if precinct not in VEST data (merged/split precincts)
        Object.assign(newProps, votes || { democrat: 0, republican: 0, otherparty: 0 });
      }

      outputFeatures.push({
        type: "Feature",
        geometry: feature.geometry,
        properties: newProps
      });
    }

    this.log(`   ${matched} blocks matched, ${unmatched} dropped`);

    // Step 6: Write output
    const output: GeoJSON.FeatureCollection = {
      type: "FeatureCollection",
      features: outputFeatures
    };

    const outputPath = flags.output.replace("~", process.env.HOME || "");
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, JSON.stringify(output));

    const fileSizeMB = (Buffer.byteLength(JSON.stringify(output)) / 1024 / 1024).toFixed(1);
    this.log(`\nWrote ${outputFeatures.length} features to ${outputPath} (${fileSizeMB}MB)`);

    const totalPop = outputFeatures.reduce(
      (sum, f) => sum + ((f.properties as any).population || 0),
      0
    );
    const counties = new Set(outputFeatures.map(f => (f.properties as any).county));
    const precincts = new Set(outputFeatures.map(f => (f.properties as any).precinct));
    this.log(`\nSummary:`);
    this.log(`  Population: ${totalPop.toLocaleString()}`);
    this.log(`  Counties: ${counties.size}`);
    this.log(`  Precincts: ${precincts.size}`);
    this.log(`  Blocks: ${outputFeatures.length}`);
  }
}
