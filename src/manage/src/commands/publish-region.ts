// SPDX-License-Identifier: AGPL-3.0-or-later
// Modifications © 2026 Michael Maurizi Jr.

import { Args, Command, Flags, ux } from "@oclif/core";
import { S3Client } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { createReadStream } from "fs";
import { join } from "path";
import readDir from "recursive-readdir";
import { RegionConfig } from "../../../server/src/region-configs/entities/region-config.entity";
import { createDataSource } from "../lib/dbUtils";
import { shouldPublishFile } from "../lib/fileUtils";

export default class PublishRegion extends Command {
  static description = "upload processed region files to S3";

  static flags = {
    bucketName: Flags.string({
      char: "b",
      description: "Bucket to upload the files to",
      default: "districtbuilder-dev-238046523378"
    }),
    replaces: Flags.boolean({
      description:
        "If an active (non-archived) RegionConfig already exists for this country+region, archive it. Without this flag, publishing into an already-active region errors out.",
      default: false
    })
  };

  static args = {
    staticDataDir: Args.string({
      description: "Directory of the region's static data (the output of `process-geojson`)",
      required: true
    }),
    countryCode: Args.string({
      description: "Country code, e.g. US",
      required: true
    }),
    regionCode: Args.string({
      description: "Region code, e.g. PA",
      required: true
    }),
    regionName: Args.string({
      description:
        "Name of the region, e.g. Pennsylvania. Optional with --replaces (inherits from the active row being archived).",
      required: false
    })
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(PublishRegion);
    const versionDt = new Date();
    const keyPrefix = `regions/${args.countryCode}/${args.regionCode}/${versionDt.toISOString()}`;

    // Open the DB first so we can fail fast on a duplicate-active-region check
    // before doing the (slow, expensive) S3 upload.
    const dataSource = await createDataSource();
    const repo = dataSource.getRepository(RegionConfig);

    const existingActive = await repo.findOne({
      where: {
        countryCode: args.countryCode,
        regionCode: args.regionCode,
        archived: false
      }
    });
    if (existingActive && !flags.replaces) {
      await dataSource.destroy();
      this.error(
        `An active RegionConfig already exists for ${args.countryCode}/${args.regionCode} (id=${existingActive.id}, version=${existingActive.version.toISOString()}). Re-run with --replaces to archive it.`
      );
    }

    const regionName = args.regionName ?? existingActive?.name;
    if (!regionName) {
      await dataSource.destroy();
      this.error(
        `regionName is required (no active RegionConfig found for ${args.countryCode}/${args.regionCode} to inherit from).`
      );
    }

    // Filter out intermediate data files that are no longer needed
    const filePaths = (await readDir(args.staticDataDir)).filter(shouldPublishFile);

    if (filePaths.length === 0) {
      await dataSource.destroy();
      this.log("no files found for publishing, exiting");
      return;
    }

    ux.action.start(`Uploading ${filePaths.length} files`);
    const s3Client = new S3Client({});
    const uploadPromises = filePaths.map(filePath => {
      // Strip off relative parts of the path we don't need for use in the S3 key
      const keyName = join(keyPrefix, filePath.substring(args.staticDataDir.length));
      const upload = new Upload({
        client: s3Client,
        params: {
          Body: createReadStream(filePath),
          Bucket: flags.bucketName,
          Key: keyName
        }
      });
      return upload.done();
    });
    const responses = await Promise.all(uploadPromises);
    ux.action.stop();
    this.log(`Received ${responses.length} responses`);

    this.log("Saving region config to database");
    const regionConfig = new RegionConfig();
    regionConfig.name = regionName;
    regionConfig.countryCode = args.countryCode;
    regionConfig.regionCode = args.regionCode;
    regionConfig.s3URI = `s3://${flags.bucketName}/${keyPrefix}/`;
    regionConfig.version = versionDt;

    // Archive the prior active row first, then insert the new one. Order
    // matters: the new row stays unarchived even if the archive update fails
    // (we abort before the insert), and a downstream retire-region run can
    // tell source from target by the archived flag.
    if (existingActive) {
      existingActive.archived = true;
      // @ts-ignore
      await repo.save(existingActive);
      this.log(`Archived prior RegionConfig ${existingActive.id} (${existingActive.s3URI})`);
    }
    // @ts-ignore
    await repo.save(regionConfig);
    this.log("Region config saved to database");

    await dataSource.destroy();
  }
}
