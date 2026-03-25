import { Command, Flags, ux } from "@oclif/core";
import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { Readable } from "stream";
import { parse } from "JSONStream";
import Pbf from "pbf";
import { Objects, Topology } from "topojson-specification";
import { serialize, deserialize } from "v8";
import { decode, encode } from "topobuf";

export default class SerializeTopojson extends Command {
  static description = `reprocess topojson files into binary format
  
  Pass a list of s3_uri paths to reprocess, e.g.
  serialize-topojson s3://bucket-name/regions/US/PA s3://other-bucket-name/regions/US/DE
`;

  static strict = false;

  static flags = {
    input: Flags.string({
      char: "i",
      description: "File type to read from",
      options: ["buf", "json", "pbf"],
      default: "buf"
    }),
    output: Flags.string({
      char: "o",
      description: "File type to write to",
      options: ["buf", "json", "pbf"],
      default: "pbf"
    })
  };

  async run(): Promise<void> {
    const { argv, flags } = await this.parse(SerializeTopojson);
    if (flags.input === flags.output) {
      this.error("Input and output file types cannot be the same");
    }

    for (const s3URI of argv as string[]) {
      ux.action.start(`Reading base TopoJSON: ${s3URI}`);
      const baseTopojson = await (flags.input === "json"
        ? this.readJson(s3URI)
        : flags.input === "buf"
        ? this.readBuf(s3URI)
        : this.readPbf(s3URI));
      ux.action.stop();

      ux.action.start(`Uploading serialized TopoJSON: ${s3URI}`);
      await (flags.output === "buf"
        ? this.writeBuf(s3URI, baseTopojson)
        : flags.output === "json"
        ? this.writeJson(s3URI, baseTopojson)
        : this.writePbf(s3URI, baseTopojson));
      ux.action.stop();
    }
  }

  // Reads a TopoJSON file from S3, given the S3 run directory
  async readJson(inputS3Dir: string): Promise<Topology<Objects<{}>>> {
    this.log("Reading topo.json");
    const s3Client = new S3Client({});
    const response: any = await s3Client.send(new GetObjectCommand(this.s3Options(inputS3Dir, "json")));
    const body = Buffer.from(await response.Body!.transformToByteArray());

    const objects = await new Promise(resolve =>
      Readable.from(body)
        .pipe(parse("objects"))
        .on("data", (objects: any) => {
          resolve(objects);
        })
    );

    const arcs = await new Promise(resolve =>
      Readable.from(body)
        .pipe(parse("arcs"))
        .on("data", (arcs: any) => {
          resolve(arcs);
        })
    );

    const bbox = await new Promise(resolve =>
      Readable.from(body)
        .pipe(parse("bbox"))
        .on("data", (bbox: any) => {
          resolve(bbox);
        })
    );

    const transform = await new Promise(resolve =>
      Readable.from(body)
        .pipe(parse("transform"))
        .on("data", (transform: any) => {
          resolve(transform);
        })
    );

    return {
      type: "Topology",
      bbox,
      transform,
      objects,
      arcs
    } as Topology<Objects<{}>>;
  }

  async read(inputS3Dir: string, ext: string) {
    this.log(`Reading topo.${ext}`);
    const s3Client = new S3Client({});
    const response = await s3Client.send(new GetObjectCommand(this.s3Options(inputS3Dir, ext)));
    return { Body: Buffer.from(await response.Body!.transformToByteArray()) };
  }

  s3Options(inputS3Dir: string, ext: string) {
    const uriComponents = inputS3Dir.split("/");
    return {
      Bucket: uriComponents[2],
      Key: `${uriComponents.slice(3).join("/")}topo.${ext}`
    };
  }

  async readBuf(inputS3Dir: string) {
    const resp = await this.read(inputS3Dir, "buf");
    return deserialize(resp.Body as Buffer);
  }

  async readPbf(inputS3Dir: string) {
    const resp = await this.read(inputS3Dir, "pbf");
    return decode(new Pbf(resp.Body as Buffer)) as Topology;
  }

  async write(inputS3Dir: string, ext: string, body: string | Buffer | Uint8Array) {
    this.log(`Writing topo.${ext}`);
    const s3Client = new S3Client({});
    return s3Client.send(new PutObjectCommand({
      Body: typeof body === "string" ? Buffer.from(body) : body,
      ...this.s3Options(inputS3Dir, ext)
    }));
  }

  writeJson(inputS3Dir: string, topology: Topology<Objects<{}>>) {
    return this.write(inputS3Dir, "json", JSON.stringify(topology));
  }

  writeBuf(inputS3Dir: string, topology: Topology<Objects<{}>>) {
    return this.write(inputS3Dir, "buf", serialize(topology));
  }

  writePbf(inputS3Dir: string, topology: Topology<Objects<{}>>) {
    return this.write(inputS3Dir, "pbf", encode(topology, new Pbf()));
  }
}
