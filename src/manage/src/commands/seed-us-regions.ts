// SPDX-License-Identifier: AGPL-3.0-or-later
// © 2026 Michael Maurizi Jr.

import { Command, Flags } from "@oclif/core";
import { S3Client, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { RegionConfig } from "../../../server/src/region-configs/entities/region-config.entity";
import { createDataSource } from "../lib/dbUtils";

// US state code → display name. Used to populate the `name` column when
// seeding region_configs from the S3 bucket layout, which only encodes
// country + state code.
const STATE_NAMES: Record<string, string> = {
  AL: "Alabama",
  AK: "Alaska",
  AZ: "Arizona",
  AR: "Arkansas",
  CA: "California",
  CO: "Colorado",
  CT: "Connecticut",
  DE: "Delaware",
  DC: "District of Columbia",
  FL: "Florida",
  GA: "Georgia",
  HI: "Hawaii",
  ID: "Idaho",
  IL: "Illinois",
  IN: "Indiana",
  IA: "Iowa",
  KS: "Kansas",
  KY: "Kentucky",
  LA: "Louisiana",
  ME: "Maine",
  MD: "Maryland",
  MA: "Massachusetts",
  MI: "Michigan",
  MN: "Minnesota",
  MS: "Mississippi",
  MO: "Missouri",
  MT: "Montana",
  NE: "Nebraska",
  NV: "Nevada",
  NH: "New Hampshire",
  NJ: "New Jersey",
  NM: "New Mexico",
  NY: "New York",
  NC: "North Carolina",
  ND: "North Dakota",
  OH: "Ohio",
  OK: "Oklahoma",
  OR: "Oregon",
  PA: "Pennsylvania",
  RI: "Rhode Island",
  SC: "South Carolina",
  SD: "South Dakota",
  TN: "Tennessee",
  TX: "Texas",
  UT: "Utah",
  VT: "Vermont",
  VA: "Virginia",
  WA: "Washington",
  WV: "West Virginia",
  WI: "Wisconsin",
  WY: "Wyoming"
};

export default class SeedUsRegions extends Command {
  static description =
    "Seed US region_config rows by enumerating an S3 bucket with publish-region layout.";

  static flags = {
    bucket: Flags.string({
      char: "b",
      description: "S3 bucket containing processed region data.",
      default: "districtbuilder-dev-238046523378"
    }),
    countryCode: Flags.string({
      char: "c",
      description: "Country code prefix to scan under (regions/<country>/).",
      default: "US"
    })
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(SeedUsRegions);
    const s3 = new S3Client({});

    const countryPrefix = `regions/${flags.countryCode}/`;
    this.log(`Scanning s3://${flags.bucket}/${countryPrefix}`);

    // List state-code subprefixes.
    const stateResp = await s3.send(
      new ListObjectsV2Command({
        Bucket: flags.bucket,
        Prefix: countryPrefix,
        Delimiter: "/"
      })
    );
    const statePrefixes = (stateResp.CommonPrefixes ?? []).map(p => p.Prefix!).filter(Boolean);

    if (statePrefixes.length === 0) {
      this.error(`No state prefixes found under ${countryPrefix}`);
    }

    // For each state, find its version timestamp subdir. publish-region writes
    // one version per run; pick the most recent if multiple exist.
    interface Discovered {
      regionCode: string;
      name: string;
      keyPrefix: string;
      version: Date;
    }
    const discovered: Discovered[] = [];
    for (const statePrefix of statePrefixes) {
      const regionCode = statePrefix.slice(countryPrefix.length, -1);
      const name = STATE_NAMES[regionCode];
      if (!name) {
        this.warn(`Skipping unknown state code: ${regionCode}`);
        continue;
      }
      const versionResp = await s3.send(
        new ListObjectsV2Command({
          Bucket: flags.bucket,
          Prefix: statePrefix,
          Delimiter: "/"
        })
      );
      const versionPrefixes = (versionResp.CommonPrefixes ?? [])
        .map(p => p.Prefix!)
        .filter(Boolean);
      if (versionPrefixes.length === 0) {
        this.warn(`No versions for ${regionCode}, skipping`);
        continue;
      }
      // The timestamp portion is the last segment — parse and pick the latest.
      const versions = versionPrefixes
        .map(vp => {
          const iso = vp.slice(statePrefix.length, -1);
          return { prefix: vp, date: new Date(iso) };
        })
        .filter(v => !isNaN(v.date.getTime()))
        .sort((a, b) => b.date.getTime() - a.date.getTime());
      if (versions.length === 0) {
        this.warn(`No parseable versions for ${regionCode}, skipping`);
        continue;
      }
      const latest = versions[0];
      discovered.push({
        regionCode,
        name,
        keyPrefix: latest.prefix,
        version: latest.date
      });
    }

    this.log(`Discovered ${discovered.length} regions`);

    const dataSource = await createDataSource();
    const repo = dataSource.getRepository(RegionConfig);

    let inserted = 0;
    let skipped = 0;
    for (const d of discovered) {
      // Skip if a row with the same unique tuple already exists.
      const existing = await repo.findOne({
        where: {
          name: d.name,
          countryCode: flags.countryCode,
          regionCode: d.regionCode,
          version: d.version
        }
      });
      if (existing) {
        skipped++;
        continue;
      }
      const rc = new RegionConfig();
      rc.name = d.name;
      rc.countryCode = flags.countryCode;
      rc.regionCode = d.regionCode;
      rc.keyPrefix = d.keyPrefix;
      rc.version = d.version;
      await repo.save(rc);
      this.log(`  inserted ${d.regionCode} → ${d.keyPrefix}`);
      inserted++;
    }

    await dataSource.destroy();
    this.log(`Done: ${inserted} inserted, ${skipped} skipped`);
  }
}
