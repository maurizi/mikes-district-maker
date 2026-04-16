import { Command, Flags } from "@oclif/core";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { IsNull } from "typeorm";
import { type Feature, type MultiPolygon } from "geojson";

import { createDataSource } from "../lib/dbUtils";
import { Project } from "../../../server/src/projects/entities/project.entity";
import {
  type DistrictProperties,
  type DistrictsGeoJSON,
  type GeoUnitHierarchy,
  type S3URI
} from "../../../shared/entities";
import {
  type AdjacencyData,
  buildBlockAssignment,
  buildReverseIndex,
  computeDistrictBoundaries
} from "../../../shared/boundary";
import { simplifyForThumbnail } from "../../../shared/thumbnail";

const s3 = new S3Client({});

interface RegionData {
  readonly geoUnitHierarchy: GeoUnitHierarchy;
  readonly numBlocks: number;
  readonly adjacencyData: AdjacencyData;
}

function s3KeyParts(s3URI: S3URI, fileName: string): { Bucket: string; Key: string } {
  const url = new URL(s3URI);
  const prefix = url.pathname.replace(/^\//, "");
  return { Bucket: url.hostname, Key: `${prefix}${fileName}` };
}

async function s3GetJson<T>(s3URI: S3URI, fileName: string): Promise<T> {
  const res = await s3.send(new GetObjectCommand(s3KeyParts(s3URI, fileName)));
  const body = (await res.Body?.transformToString("utf-8")) ?? "";
  return JSON.parse(body) as T;
}

async function s3GetBytes(s3URI: S3URI, fileName: string): Promise<ArrayBuffer> {
  const res = await s3.send(new GetObjectCommand(s3KeyParts(s3URI, fileName)));
  const bytes = (await res.Body?.transformToByteArray()) ?? new Uint8Array();
  // Slice to the exact bounds — Node Buffers may share an oversized backing
  // ArrayBuffer, which would corrupt typed-array views built from .buffer.
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

async function loadRegionData(s3URI: S3URI): Promise<RegionData> {
  const [geoUnitHierarchy, adjBuf, offsetsBuf, coordsBuf, transform] = await Promise.all([
    s3GetJson<GeoUnitHierarchy>(s3URI, "geounit-hierarchy.json"),
    s3GetBytes(s3URI, "adjacency.bin"),
    s3GetBytes(s3URI, "arc-offsets.bin"),
    s3GetBytes(s3URI, "arc-coords.bin"),
    s3GetJson<AdjacencyData["transform"]>(s3URI, "transform.json")
  ]);
  const adjacencyData: AdjacencyData = {
    adjacency: new Int32Array(adjBuf),
    arcOffsets: new Uint32Array(offsetsBuf),
    arcCoords: coordsBuf,
    transform
  };
  // Count base-level leaves in the hierarchy (== block count).
  const stack: (GeoUnitHierarchy | number)[] = [geoUnitHierarchy];
  let numBlocks = 0;
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (typeof current === "number") {
      numBlocks++;
    } else {
      for (let i = current.length - 1; i >= 0; i--) stack.push(current[i]);
    }
  }
  return { geoUnitHierarchy, numBlocks, adjacencyData };
}

// Build the same DistrictsGeoJSON shape the worker assembles in mergeDistricts,
// but without per-district demographics/voting (which would require fetching
// the heavy per-region demographics binaries). The thumbnail render path on
// the listings UI only reads geometry; the empty `demographics: {}` keeps the
// type satisfied. If a user later opens the project in the editor, the worker
// recomputes everything fresh and overwrites the thumbnail with full data.
function buildThumbnail(project: Project, region: RegionData) {
  const reverseIndex = buildReverseIndex(region.adjacencyData.adjacency, region.numBlocks);
  const assignment = buildBlockAssignment(
    project.districtsDefinition,
    region.geoUnitHierarchy,
    region.numBlocks
  );
  const boundaries = computeDistrictBoundaries(
    region.adjacencyData,
    reverseIndex,
    assignment,
    project.numberOfDistricts
  );
  const features: Feature<MultiPolygon, DistrictProperties>[] = boundaries.map((b, i) => ({
    type: "Feature",
    id: i,
    geometry: b.geometry,
    properties: {
      compactness: b.compactness,
      contiguity: b.contiguity,
      demographics: {}
    }
  }));
  const districts: DistrictsGeoJSON = { type: "FeatureCollection", features };
  return simplifyForThumbnail(districts);
}

export default class BackfillThumbnails extends Command {
  static description = "Backfill thumbnail geojson on projects that don't have one";

  static flags = {
    "dry-run": Flags.boolean({
      description: "Print which projects would be updated without writing",
      default: false
    }),
    limit: Flags.integer({
      description: "Maximum number of projects to update",
      required: false
    })
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(BackfillThumbnails);
    const dryRun = flags["dry-run"];

    const dataSource = await createDataSource();
    const projectRepo = dataSource.getRepository(Project);

    const projects = await projectRepo.find({
      where: { thumbnail: IsNull() },
      relations: ["regionConfig"],
      order: { createdDt: "ASC" },
      take: flags.limit
    });

    this.log(`Found ${projects.length} project(s) without thumbnails`);
    if (projects.length === 0) {
      await dataSource.destroy();
      this.exit(0);
    }

    // Group by region so we fetch each region's S3 data only once.
    const projectsByRegion = new Map<string, Project[]>();
    for (const p of projects) {
      const key = p.regionConfig.id;
      const arr = projectsByRegion.get(key);
      if (arr) arr.push(p);
      else projectsByRegion.set(key, [p]);
    }

    let updated = 0;
    let failed = 0;

    for (const [, regionProjects] of projectsByRegion) {
      const regionConfig = regionProjects[0].regionConfig;
      this.log(
        `\n${regionConfig.regionCode} (${regionProjects.length} project${regionProjects.length === 1 ? "" : "s"})`
      );

      let region: RegionData;
      try {
        region = await loadRegionData(regionConfig.s3URI);
      } catch (e) {
        this.log(`  failed to load region data: ${e}`);
        failed += regionProjects.length;
        continue;
      }

      for (const project of regionProjects) {
        try {
          const thumbnail = buildThumbnail(project, region);
          if (dryRun) {
            this.log(
              `  ${project.name}: would write thumbnail (${thumbnail.features.length} features)`
            );
          } else {
            await projectRepo.update(project.id, { thumbnail });
            this.log(`  ${project.name}: updated`);
          }
          updated++;
        } catch (e) {
          this.log(`  ${project.name}: ERROR — ${e}`);
          failed++;
        }
      }
    }

    this.log("");
    this.log(`=== Done ===`);
    this.log(`${dryRun ? "Would update" : "Updated"}: ${updated}, Failed: ${failed}`);

    await dataSource.destroy();
    this.exit(0);
  }
}
