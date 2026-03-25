import { Args, Command, ux } from "@oclif/core";
import { S3Client } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { createReadStream } from "fs";
import { join } from "path";
import readDir from "recursive-readdir";
import { shouldPublishFile } from "../lib/fileUtils";

export default class UpdateRegion extends Command {
  static description = "update processed region files in-place on S3";

  static args = {
    staticDataDir: Args.string({
      description: "Directory of the region's static data (the output of `process-geojson`)",
      required: true
    }),
    updateS3Dir: Args.string({
      description: "S3 directory to update in-place",
      required: true
    })
  };

  async run(): Promise<void> {
    const { args } = await this.parse(UpdateRegion);

    // Filter out intermediate data files that are no longer needed
    const filePaths = (await readDir(args.staticDataDir)).filter(shouldPublishFile);

    if (filePaths.length === 0) {
      this.log("no files found for updating, exiting");
      return;
    }

    ux.action.start(`Updating ${filePaths.length} files`);
    const uriComponents = args.updateS3Dir.split("/");
    const keyPrefix = uriComponents.slice(3).join("/");
    const s3Client = new S3Client({});
    const uploadPromises = filePaths.map(filePath => {
      const upload = new Upload({
        client: s3Client,
        params: {
          Body: createReadStream(filePath),
          Bucket: uriComponents[2],
          Key: join(keyPrefix, filePath.substring(args.staticDataDir.length))
        }
      });
      return upload.done();
    });
    const responses = await Promise.all(uploadPromises);
    ux.action.stop();
    this.log(`Received ${responses.length} responses`);
  }
}
