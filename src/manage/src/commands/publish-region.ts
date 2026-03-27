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
      default: "global-districtbuilder-dev-us-east-1"
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
      description: "Name of the region, e.g. Pennsylvania",
      required: true
    })
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(PublishRegion);
    const versionDt = new Date();
    const keyPrefix = `regions/${args.countryCode}/${args.regionCode}/${versionDt.toISOString()}`;

    // Filter out intermediate data files that are no longer needed
    const filePaths = (await readDir(args.staticDataDir)).filter(shouldPublishFile);

    if (filePaths.length === 0) {
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
    regionConfig.name = args.regionName;
    regionConfig.countryCode = args.countryCode;
    regionConfig.regionCode = args.regionCode;
    regionConfig.s3URI = `s3://${flags.bucketName}/${keyPrefix}/`;
    regionConfig.version = versionDt;

    const dataSource = await createDataSource();
    const repo = dataSource.getRepository(RegionConfig);
    // @ts-ignore
    await repo.save(regionConfig);
    this.log("Region config saved to database");
  }
}
