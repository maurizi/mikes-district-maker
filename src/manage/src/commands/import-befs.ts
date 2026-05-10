// SPDX-License-Identifier: AGPL-3.0-or-later
// © 2026 Michael Maurizi Jr.

import { Args, Command, Flags } from "@oclif/core";
import { S3Client } from "@aws-sdk/client-s3";
import { readFileSync, readdirSync, existsSync } from "fs";
import { join, basename } from "path";
import { createDataSource } from "../lib/dbUtils";
import { RegionConfig } from "../../../server/src/region-configs/entities/region-config.entity";
import { Chamber } from "../../../server/src/chambers/entities/chamber.entity";
import { Project } from "../../../server/src/projects/entities/project.entity";
import { User } from "../../../server/src/users/entities/user.entity";
import { type GeoUnitHierarchy } from "../../../shared/entities";
import { encode } from "../../../shared/compress";
import {
  buildSplitBlockMap,
  expandBlockToDistrict,
  importCsvToDefinition,
  parseBlockDistrictCsv
} from "../../../shared/csv-import";
import { fetchCachedJson } from "../../../server/src/common/functions";

const s3 = new S3Client({});

type ChamberKey = "us_house" | "state_house" | "state_senate";

// Display label used in generated project names (e.g. "PA US House").
const CHAMBER_LABEL: Record<ChamberKey, string> = {
  us_house: "US House",
  state_house: "State House",
  state_senate: "State Senate"
};

// Normalize a chamber name for matching: strip periods, collapse whitespace.
// Turns "U.S. House" → "us house", "House of Representatives" → "house of representatives".
function normalizeChamberName(name: string): string {
  return name.toLowerCase().replace(/\./g, "").replace(/\s+/g, " ").trim();
}

// Match a CSV chamber type to a region's seeded Chamber row. Region chamber
// names are non-uniform across states ("Senate" vs "State Senate", "House of
// Representatives" vs "House of Delegates" vs "Assembly" vs "General Assembly",
// "Legislature" for unicameral NE), so we can't substring-match a single
// pattern. Instead: identify the federal chamber by exact normalized name,
// then pick the upper chamber as the one containing "senate" and the lower
// chamber as the remaining non-federal chamber.
function findChamber(chamberKey: ChamberKey, chambers: readonly Chamber[]): Chamber | undefined {
  const usHouse = chambers.find(c => normalizeChamberName(c.name) === "us house");
  if (chamberKey === "us_house") return usHouse;

  const stateChambers = chambers.filter(c => c !== usHouse);
  if (chamberKey === "state_senate") {
    // Prefer a chamber whose name contains "senate"; fall back to the only
    // state chamber for unicameral NE ("Legislature").
    return (
      stateChambers.find(c => normalizeChamberName(c.name).includes("senate")) ??
      (stateChambers.length === 1 ? stateChambers[0] : undefined)
    );
  }
  // state_house: the non-senate state chamber.
  return stateChambers.find(c => !normalizeChamberName(c.name).includes("senate"));
}

export default class ImportBefs extends Command {
  static description = "import block equivalency CSVs as projects";

  static args = {
    csvDir: Args.string({
      description:
        "Directory containing state subdirectories with CSV files (e.g. scripts/import-befs/output)",
      required: true
    })
  };

  static flags = {
    email: Flags.string({
      description: "Email of the user to own the projects",
      required: true
    }),
    "dry-run": Flags.boolean({
      description: "Print what would be imported without creating projects",
      default: false
    }),
    state: Flags.string({
      description: "Only import a specific state (e.g. PA)",
      required: false
    })
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(ImportBefs);
    const csvDir = args.csvDir;
    const dryRun = flags["dry-run"];

    if (!existsSync(csvDir)) {
      this.error(`Directory not found: ${csvDir}`);
    }

    const dataSource = await createDataSource();
    const regionConfigRepo = dataSource.getRepository(RegionConfig);
    const chamberRepo = dataSource.getRepository(Chamber);
    const projectRepo = dataSource.getRepository(Project);
    const userRepo = dataSource.getRepository(User);

    const user = await userRepo.findOne({ where: { email: flags.email } });
    if (!user) {
      this.error(`User not found: ${flags.email}`);
    }

    // List state directories
    const stateDirs = readdirSync(csvDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name)
      .filter(name => !flags.state || name === flags.state)
      .sort();

    if (stateDirs.length === 0) {
      this.error(`No state directories found in ${csvDir}`);
    }

    this.log(`Found ${stateDirs.length} state(s) to process`);

    // Cache S3 data per region config
    const blockIdsCache = new Map<string, string[]>();
    const hierarchyCache = new Map<string, GeoUnitHierarchy>();
    // Cache split block maps per region config
    const splitBlockMapCache = new Map<string, Map<string, string[]>>();

    let created = 0;
    let skipped = 0;
    let errors = 0;

    for (const stateAbbr of stateDirs) {
      const stateDir = join(csvDir, stateAbbr);
      const csvFiles = readdirSync(stateDir)
        .filter(f => f.endsWith(".csv") && !f.includes("_district_names"))
        .sort()
        .reverse(); // Upload alphabetically descending, homepage displays most recent first based on updateDt so it gets reversed again

      if (csvFiles.length === 0) {
        this.log(`  ${stateAbbr}: no CSV files, skipping`);
        continue;
      }

      // Look up region config
      const regionConfig = await regionConfigRepo.findOne({
        where: { regionCode: stateAbbr, hidden: false, archived: false }
      });
      if (!regionConfig) {
        this.log(`  ${stateAbbr}: no region config found, skipping`);
        skipped += csvFiles.length;
        continue;
      }

      // Load chambers for this region
      const chambers = await chamberRepo.find({
        where: { regionConfig: { id: regionConfig.id } }
      });

      // Fetch block IDs and hierarchy from S3 (cached)
      if (!blockIdsCache.has(regionConfig.id)) {
        try {
          const [blockIds, hierarchy] = await Promise.all([
            fetchCachedJson<string[]>(s3, regionConfig.keyPrefix, "block-ids.json"),
            fetchCachedJson<GeoUnitHierarchy>(s3, regionConfig.keyPrefix, "geounit-hierarchy.json")
          ]);
          blockIdsCache.set(regionConfig.id, blockIds);
          hierarchyCache.set(regionConfig.id, hierarchy);
          splitBlockMapCache.set(regionConfig.id, buildSplitBlockMap(blockIds));
        } catch (e) {
          this.log(`  ${stateAbbr}: failed to fetch S3 data: ${e}`);
          skipped += csvFiles.length;
          continue;
        }
      }

      const blockIds = blockIdsCache.get(regionConfig.id)!;
      const hierarchy = hierarchyCache.get(regionConfig.id)!;
      const allBlockIds = new Set(blockIds);
      const splitBlockMap = splitBlockMapCache.get(regionConfig.id)!;

      for (const csvFile of csvFiles) {
        const csvPath = join(stateDir, csvFile);
        const stem = basename(csvFile, ".csv");

        // Determine chamber from filename
        // e.g. "us_house.csv" -> us_house, "us_house_118.csv" -> us_house with suffix "118"
        // e.g. "state_house_2022.csv" -> state_house with suffix "2022"
        let chamberKey: ChamberKey;
        let suffix = "";
        if (stem.startsWith("us_house")) {
          chamberKey = "us_house";
          suffix = stem.replace("us_house", "").replace(/^_/, "");
        } else if (stem.startsWith("state_house")) {
          chamberKey = "state_house";
          suffix = stem.replace("state_house", "").replace(/^_/, "");
        } else if (stem.startsWith("state_senate")) {
          chamberKey = "state_senate";
          suffix = stem.replace("state_senate", "").replace(/^_/, "");
        } else {
          this.log(`    ${csvFile}: unknown chamber type, skipping`);
          skipped++;
          continue;
        }

        const chamberLabel = CHAMBER_LABEL[chamberKey];
        const chamber = findChamber(chamberKey, chambers);

        // Parse CSV (simple BLOCKID,DISTRICT format)
        const records = parseBlockDistrictCsv(readFileSync(csvPath, "utf-8"));
        const {
          blockToDistrict,
          maxDistrictId: maxDistrict,
          isComplete
        } = expandBlockToDistrict(records, allBlockIds, splitBlockMap);

        // Skip single-district chambers (at-large, DC, etc.)
        if (maxDistrict <= 1) {
          this.log(`    ${csvFile}: only ${maxDistrict} district, skipping`);
          skipped++;
          continue;
        }

        const matchedBlocks = Object.keys(blockToDistrict).length;
        const projectName = suffix
          ? `Official ${stateAbbr} ${chamberLabel} (${suffix})`
          : `Official ${stateAbbr} ${chamberLabel}`;

        if (dryRun) {
          this.log(
            `    ${csvFile}: "${projectName}" — ${records.length} rows, ${maxDistrict} districts, ${matchedBlocks} blocks matched` +
              (chamber ? `, chamber: ${chamber.name}` : ", no chamber match")
          );
          continue;
        }

        try {
          const districtsDefinition = importCsvToDefinition(blockIds, hierarchy, blockToDistrict);

          const project = new Project();
          project.name = projectName;
          project.numberOfDistricts = maxDistrict;
          project.regionConfig = regionConfig;
          project.districtsDefinition = await encode(districtsDefinition);
          project.lockedDistricts = new Array(maxDistrict).fill(false);
          project.numberOfMembers = new Array(maxDistrict).fill(1);
          project.populationDeviation = 5;
          project.user = user;
          project.regionConfigVersion = regionConfig.version;
          project.isComplete = isComplete;
          if (chamber) {
            project.chamber = chamber;
            project.numberOfMembers = chamber.numberOfMembers
              ? [...chamber.numberOfMembers]
              : new Array(maxDistrict).fill(1);
          }

          // @ts-ignore
          await projectRepo.save(project, { reload: false });
          created++;
          this.log(`    ${csvFile}: created "${projectName}" (${maxDistrict} districts)`);
        } catch (e) {
          errors++;
          this.log(`    ${csvFile}: ERROR — ${e}`);
        }
      }
    }

    this.log("");
    this.log(`=== Done ===`);
    this.log(`Created: ${created}, Skipped: ${skipped}, Errors: ${errors}`);

    await dataSource.destroy();
    this.exit(0);
  }
}
