import { Command } from "@oclif/core";
import { Chamber } from "../../../server/src/chambers/entities/chamber.entity";
import { RegionConfig } from "../../../server/src/region-configs/entities/region-config.entity";
import { createDataSource } from "../lib/dbUtils";

// Per-state chamber definitions. Each state contributes one US House
// chamber plus one or two state legislature chambers (Nebraska is
// unicameral). Order within the state doesn't matter.
//
// Multi-member handling:
// - uniformMultiMember = N: every district elects N members. We set
//   numberOfMembers to an N-filled array of length numberOfDistricts.
// - needsManualMemberCounts = true: the state has a non-uniform
//   distribution (e.g. VT Senate has 1–6 per district, NH House uses
//   floterial districts). We leave numberOfMembers null and emit a
//   warning. The chamber is still created with the correct
//   numberOfDistricts so an operator can populate numberOfMembers later.
interface ChamberSpec {
  name: string;
  numberOfDistricts: number;
  uniformMultiMember?: number;
  needsManualMemberCounts?: boolean;
  defaultPopulationField?: string;
}

const CHAMBERS_BY_STATE: Record<string, ChamberSpec[]> = {
  AL: [
    { name: "U.S. House", numberOfDistricts: 7 },
    { name: "Senate", numberOfDistricts: 35 },
    { name: "House of Representatives", numberOfDistricts: 105 }
  ],
  AK: [
    { name: "Senate", numberOfDistricts: 20 },
    { name: "House of Representatives", numberOfDistricts: 40 }
  ],
  AZ: [
    { name: "U.S. House", numberOfDistricts: 9 },
    { name: "Senate", numberOfDistricts: 30 },
    // 60 seats, 2 per district.
    { name: "House of Representatives", numberOfDistricts: 30, uniformMultiMember: 2 }
  ],
  AR: [
    { name: "U.S. House", numberOfDistricts: 4 },
    { name: "Senate", numberOfDistricts: 35 },
    { name: "House of Representatives", numberOfDistricts: 100 }
  ],
  CA: [
    { name: "U.S. House", numberOfDistricts: 52, defaultPopulationField: "adj_population" },
    { name: "State Senate", numberOfDistricts: 40, defaultPopulationField: "adj_population" },
    { name: "State Assembly", numberOfDistricts: 80, defaultPopulationField: "adj_population" }
  ],
  CO: [
    { name: "U.S. House", numberOfDistricts: 8 },
    { name: "Senate", numberOfDistricts: 35, defaultPopulationField: "adj_population" },
    { name: "House of Representatives", numberOfDistricts: 65, defaultPopulationField: "adj_population" }
  ],
  CT: [
    { name: "U.S. House", numberOfDistricts: 5 },
    { name: "State Senate", numberOfDistricts: 36, defaultPopulationField: "adj_population" },
    { name: "House of Representatives", numberOfDistricts: 151, defaultPopulationField: "adj_population" }
  ],
  DE: [
    { name: "Senate", numberOfDistricts: 21, defaultPopulationField: "adj_population" },
    { name: "House of Representatives", numberOfDistricts: 41, defaultPopulationField: "adj_population" }
  ],
  // DC has no state legislature and no US House voting member.
  DC: [],
  FL: [
    { name: "U.S. House", numberOfDistricts: 28 },
    { name: "Senate", numberOfDistricts: 40 },
    { name: "House of Representatives", numberOfDistricts: 120 }
  ],
  GA: [
    { name: "U.S. House", numberOfDistricts: 14 },
    { name: "State Senate", numberOfDistricts: 56 },
    { name: "House of Representatives", numberOfDistricts: 180 }
  ],
  HI: [
    { name: "U.S. House", numberOfDistricts: 2 },
    { name: "Senate", numberOfDistricts: 25 },
    { name: "House of Representatives", numberOfDistricts: 51 }
  ],
  ID: [
    { name: "U.S. House", numberOfDistricts: 2 },
    { name: "Senate", numberOfDistricts: 35 },
    // 70 seats, 2 per district.
    { name: "House of Representatives", numberOfDistricts: 35, uniformMultiMember: 2 }
  ],
  IL: [
    { name: "U.S. House", numberOfDistricts: 17 },
    { name: "Senate", numberOfDistricts: 59 },
    { name: "House of Representatives", numberOfDistricts: 118 }
  ],
  IN: [
    { name: "U.S. House", numberOfDistricts: 9 },
    { name: "Senate", numberOfDistricts: 50 },
    { name: "House of Representatives", numberOfDistricts: 100 }
  ],
  IA: [
    { name: "U.S. House", numberOfDistricts: 4 },
    { name: "Senate", numberOfDistricts: 50 },
    { name: "House of Representatives", numberOfDistricts: 100 }
  ],
  KS: [
    { name: "U.S. House", numberOfDistricts: 4 },
    { name: "Senate", numberOfDistricts: 40 },
    { name: "House of Representatives", numberOfDistricts: 125 }
  ],
  KY: [
    { name: "U.S. House", numberOfDistricts: 6 },
    { name: "Senate", numberOfDistricts: 38 },
    { name: "House of Representatives", numberOfDistricts: 100 }
  ],
  LA: [
    { name: "U.S. House", numberOfDistricts: 6 },
    { name: "State Senate", numberOfDistricts: 39 },
    { name: "House of Representatives", numberOfDistricts: 105 }
  ],
  ME: [
    { name: "U.S. House", numberOfDistricts: 2 },
    { name: "Senate", numberOfDistricts: 35 },
    { name: "House of Representatives", numberOfDistricts: 151 }
  ],
  MD: [
    { name: "U.S. House", numberOfDistricts: 8, defaultPopulationField: "adj_population" },
    { name: "Senate", numberOfDistricts: 47, defaultPopulationField: "adj_population" },
    // 141 seats, 3 per district.
    { name: "House of Delegates", numberOfDistricts: 47, uniformMultiMember: 3, defaultPopulationField: "adj_population" }
  ],
  MA: [
    { name: "U.S. House", numberOfDistricts: 9 },
    { name: "Senate", numberOfDistricts: 40 },
    { name: "House of Representatives", numberOfDistricts: 160 }
  ],
  MI: [
    { name: "U.S. House", numberOfDistricts: 13 },
    { name: "Senate", numberOfDistricts: 38 },
    { name: "House of Representatives", numberOfDistricts: 110 }
  ],
  MN: [
    { name: "U.S. House", numberOfDistricts: 8 },
    { name: "Senate", numberOfDistricts: 67 },
    { name: "House of Representatives", numberOfDistricts: 134 }
  ],
  MS: [
    { name: "U.S. House", numberOfDistricts: 4 },
    { name: "State Senate", numberOfDistricts: 52 },
    { name: "House of Representatives", numberOfDistricts: 122 }
  ],
  MO: [
    { name: "U.S. House", numberOfDistricts: 8 },
    { name: "Senate", numberOfDistricts: 34 },
    { name: "House of Representatives", numberOfDistricts: 163 }
  ],
  MT: [
    { name: "U.S. House", numberOfDistricts: 2, defaultPopulationField: "adj_population" },
    { name: "Senate", numberOfDistricts: 50, defaultPopulationField: "adj_population" },
    { name: "House of Representatives", numberOfDistricts: 100, defaultPopulationField: "adj_population" }
  ],
  // Nebraska is unicameral.
  NE: [
    { name: "U.S. House", numberOfDistricts: 3 },
    { name: "Legislature", numberOfDistricts: 49 }
  ],
  NV: [
    { name: "U.S. House", numberOfDistricts: 4, defaultPopulationField: "adj_population" },
    { name: "Senate", numberOfDistricts: 21, defaultPopulationField: "adj_population" },
    { name: "Assembly", numberOfDistricts: 42, defaultPopulationField: "adj_population" }
  ],
  NH: [
    { name: "U.S. House", numberOfDistricts: 2 },
    { name: "Senate", numberOfDistricts: 24 },
    // 400 seats across 204 districts, with floterial districts where
    // members represent overlapping populations. Non-uniform distribution.
    {
      name: "House of Representatives",
      numberOfDistricts: 204,
      needsManualMemberCounts: true
    }
  ],
  NJ: [
    { name: "U.S. House", numberOfDistricts: 12, defaultPopulationField: "adj_population" },
    { name: "Senate", numberOfDistricts: 40, defaultPopulationField: "adj_population" },
    // 80 seats, 2 per district.
    { name: "General Assembly", numberOfDistricts: 40, uniformMultiMember: 2, defaultPopulationField: "adj_population" }
  ],
  NM: [
    { name: "U.S. House", numberOfDistricts: 3 },
    { name: "Senate", numberOfDistricts: 42 },
    { name: "House of Representatives", numberOfDistricts: 70 }
  ],
  NY: [
    { name: "U.S. House", numberOfDistricts: 26 },
    { name: "State Senate", numberOfDistricts: 63, defaultPopulationField: "adj_population" },
    { name: "State Assembly", numberOfDistricts: 150, defaultPopulationField: "adj_population" }
  ],
  NC: [
    { name: "U.S. House", numberOfDistricts: 14 },
    { name: "Senate", numberOfDistricts: 50 },
    { name: "House of Representatives", numberOfDistricts: 120 }
  ],
  ND: [
    { name: "Senate", numberOfDistricts: 47 },
    // 94 seats, 2 per district.
    { name: "House of Representatives", numberOfDistricts: 47, uniformMultiMember: 2 }
  ],
  OH: [
    { name: "U.S. House", numberOfDistricts: 15 },
    { name: "Senate", numberOfDistricts: 33 },
    { name: "House of Representatives", numberOfDistricts: 99 }
  ],
  OK: [
    { name: "U.S. House", numberOfDistricts: 5 },
    { name: "Senate", numberOfDistricts: 48 },
    { name: "House of Representatives", numberOfDistricts: 101 }
  ],
  OR: [
    { name: "U.S. House", numberOfDistricts: 6 },
    { name: "State Senate", numberOfDistricts: 30 },
    { name: "House of Representatives", numberOfDistricts: 60 }
  ],
  PA: [
    { name: "U.S. House", numberOfDistricts: 17 },
    { name: "State Senate", numberOfDistricts: 50, defaultPopulationField: "adj_population" },
    { name: "House of Representatives", numberOfDistricts: 203, defaultPopulationField: "adj_population" }
  ],
  RI: [
    { name: "U.S. House", numberOfDistricts: 2 },
    { name: "Senate", numberOfDistricts: 38 },
    { name: "House of Representatives", numberOfDistricts: 75 }
  ],
  SC: [
    { name: "U.S. House", numberOfDistricts: 7 },
    { name: "Senate", numberOfDistricts: 46 },
    { name: "House of Representatives", numberOfDistricts: 124 }
  ],
  SD: [
    { name: "Senate", numberOfDistricts: 35 },
    // 70 seats, 2 per district.
    { name: "House of Representatives", numberOfDistricts: 35, uniformMultiMember: 2 }
  ],
  TN: [
    { name: "U.S. House", numberOfDistricts: 9 },
    { name: "Senate", numberOfDistricts: 33 },
    { name: "House of Representatives", numberOfDistricts: 99 }
  ],
  TX: [
    { name: "U.S. House", numberOfDistricts: 38 },
    { name: "Senate", numberOfDistricts: 31 },
    { name: "House of Representatives", numberOfDistricts: 150 }
  ],
  UT: [
    { name: "U.S. House", numberOfDistricts: 4 },
    { name: "State Senate", numberOfDistricts: 29 },
    { name: "House of Representatives", numberOfDistricts: 75 }
  ],
  VT: [
    // 30 seats across 13 districts, non-uniform (1–6 per district).
    { name: "Senate", numberOfDistricts: 13, needsManualMemberCounts: true },
    // 150 seats across 104 districts, non-uniform (mix of 1 and 2 per district).
    {
      name: "House of Representatives",
      numberOfDistricts: 104,
      needsManualMemberCounts: true
    }
  ],
  VA: [
    { name: "U.S. House", numberOfDistricts: 11, defaultPopulationField: "adj_population" },
    { name: "Senate", numberOfDistricts: 40, defaultPopulationField: "adj_population" },
    { name: "House of Delegates", numberOfDistricts: 100, defaultPopulationField: "adj_population" }
  ],
  WA: [
    { name: "U.S. House", numberOfDistricts: 10, defaultPopulationField: "adj_population" },
    { name: "State Senate", numberOfDistricts: 49, defaultPopulationField: "adj_population" },
    // 98 seats, 2 per district.
    { name: "House of Representatives", numberOfDistricts: 49, uniformMultiMember: 2, defaultPopulationField: "adj_population" }
  ],
  WV: [
    { name: "U.S. House", numberOfDistricts: 2 },
    // 34 seats, 2 per district.
    { name: "Senate", numberOfDistricts: 17, uniformMultiMember: 2 },
    { name: "House of Delegates", numberOfDistricts: 100 }
  ],
  WI: [
    { name: "U.S. House", numberOfDistricts: 8 },
    { name: "Senate", numberOfDistricts: 33 },
    { name: "State Assembly", numberOfDistricts: 99 }
  ],
  WY: [
    { name: "Senate", numberOfDistricts: 31 },
    { name: "House of Representatives", numberOfDistricts: 62 }
  ]
};

export default class SeedUsChambers extends Command {
  static description =
    "Seed US chamber rows (US House + state legislatures) for every already-seeded US region_config.";

  async run(): Promise<void> {
    const dataSource = await createDataSource();
    const regionRepo = dataSource.getRepository(RegionConfig);
    const chamberRepo = dataSource.getRepository(Chamber);

    const regions = await regionRepo.find({
      where: { countryCode: "US", hidden: false, archived: false }
    });
    const byCode = new Map(regions.map(r => [r.regionCode, r]));

    let inserted = 0;
    let skipped = 0;
    const manualFollowup: string[] = [];

    for (const [code, specs] of Object.entries(CHAMBERS_BY_STATE)) {
      const region = byCode.get(code);
      if (!region) {
        this.warn(`No region_config for ${code}, skipping its chambers`);
        continue;
      }
      for (const spec of specs) {
        const existing = await chamberRepo.findOne({
          where: { name: spec.name, regionConfig: { id: region.id } },
          relations: ["regionConfig"]
        });
        if (existing) {
          // Upsert: update defaultPopulationField on existing chambers
          let updated = false;
          if (existing.defaultPopulationField !== (spec.defaultPopulationField ?? null)) {
            existing.defaultPopulationField = spec.defaultPopulationField;
            updated = true;
          }
          if (updated) {
            await chamberRepo.save(existing);
            this.log(`  Updated ${code} ${spec.name} (defaultPopulationField=${spec.defaultPopulationField ?? "null"})`);
          }
          skipped++;
          continue;
        }

        const chamber = new Chamber();
        chamber.name = spec.name;
        chamber.numberOfDistricts = spec.numberOfDistricts;
        chamber.regionConfig = region;
        chamber.defaultPopulationField = spec.defaultPopulationField;

        if (spec.uniformMultiMember !== undefined) {
          chamber.numberOfMembers = Array(spec.numberOfDistricts).fill(spec.uniformMultiMember);
        } else if (spec.needsManualMemberCounts) {
          // Leave numberOfMembers null. The app treats null as 1-per-district,
          // which is wrong for these cases but at least doesn't fabricate data.
          manualFollowup.push(`${code} ${spec.name}`);
        }

        await chamberRepo.save(chamber);
        inserted++;
      }
    }

    await dataSource.destroy();

    this.log(`Done: ${inserted} chambers inserted, ${skipped} skipped`);
    if (manualFollowup.length > 0) {
      this.warn(
        `The following chambers have non-uniform multi-member districts and ` +
          `need their numberOfMembers array populated manually:\n  - ` +
          manualFollowup.join("\n  - ")
      );
    }
  }
}
