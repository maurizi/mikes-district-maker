import { GetObjectCommand, GetObjectCommandInput, S3Client } from "@aws-sdk/client-s3";
import { existsSync } from "fs";
import { mkdir, readFile, writeFile } from "fs/promises";
import sizeof from "object-sizeof";
import { join } from "path";
import { Topology } from "topojson-specification";

import { S3URI } from "../../../shared/entities";

import { RegionConfig } from "../region-configs/entities/region-config.entity";

export function s3Options(path: S3URI, fileName: string): GetObjectCommandInput {
  const url = new URL(path);
  const pathWithoutLeadingSlash = url.pathname.substring(1);
  const options = { Bucket: url.hostname, Key: `${pathWithoutLeadingSlash}${fileName}` };
  return options;
}

export async function getObject(s3: S3Client, params: GetObjectCommandInput) {
  const result = await s3.send(new GetObjectCommand(params));
  return result;
}

export function formatBytes(bytes: number, decimals = 2) {
  if (bytes === 0) return "0 Bytes";

  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ["Bytes", "KB", "MB", "GB", "TB", "PB", "EB", "ZB", "YB"];

  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}

// Gets the specified topology, downloading it from S3 and caching it locally if it is not already cached
export async function getTopology(regionConfig: RegionConfig, s3: S3Client): Promise<Topology> {
  const cacheDir = process.env.TOPOLOGY_CACHE_DIRECTORY || "/tmp";
  const folderPath = join(cacheDir, regionConfig.id);
  const filePath = join(folderPath, "topo.json");

  let json;
  if (!existsSync(filePath)) {
    const topojsonResponse = await getObject(s3, s3Options(regionConfig.s3URI, "topo.json"));
    json = await topojsonResponse.Body?.transformToString("utf-8") ?? "";
    // Save file to disk for speedier access later
    if (!existsSync(folderPath)) {
      await mkdir(folderPath, { recursive: true });
    }
    await writeFile(filePath, json, "utf-8");
  } else {
    json = await readFile(filePath, { encoding: "utf-8" });
  }
  return JSON.parse(json) as Topology;
}

export function getTopologyLayerSize(topology: Topology) {
  const numFeatures = Object.values(topology.objects)
    .map(gc => (gc.type === "GeometryCollection" ? gc.geometries.length : 0))
    .reduce((sum, length) => sum + length, 0);
  const topoSize = sizeof(topology);
  // Hierarchy size:
  // 1 node per feature, each node has 1 geom pointer (8 bytes) + 1 array (16 bytes)
  //  Each node is pointed to by its parent node (8 bytes)
  const hierarchySize = numFeatures * 32;
  return topoSize + hierarchySize;
}
