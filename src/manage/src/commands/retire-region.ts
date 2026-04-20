// SPDX-License-Identifier: AGPL-3.0-or-later
// © 2026 Michael Maurizi Jr.

import { Args, Command, Flags } from "@oclif/core";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";

import { createDataSource } from "../lib/dbUtils";
import { Project } from "../../../server/src/projects/entities/project.entity";
import { Chamber } from "../../../server/src/chambers/entities/chamber.entity";
import { ProjectTemplate } from "../../../server/src/project-templates/entities/project-template.entity";
import { RegionConfig } from "../../../server/src/region-configs/entities/region-config.entity";
import {
  type DistrictsDefinition,
  type GeoUnitHierarchy,
  type S3URI
} from "../../../shared/entities";
import { buildBlockAssignment } from "../../../shared/boundary";
import {
  buildSplitBlockMap,
  expandBlockToDistrict,
  importCsvToDefinition
} from "../../../shared/csv-import";

const s3 = new S3Client({});

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

function countLeaves(hierarchy: GeoUnitHierarchy): number {
  const stack: (GeoUnitHierarchy | number)[] = [hierarchy];
  let n = 0;
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (typeof cur === "number") {
      n++;
    } else {
      for (let i = cur.length - 1; i >= 0; i--) stack.push(cur[i]);
    }
  }
  return n;
}

export interface RegionArtifacts {
  readonly hierarchy: GeoUnitHierarchy;
  readonly blockIds: readonly string[];
  readonly numBlocks: number;
}

async function loadArtifacts(s3URI: S3URI): Promise<RegionArtifacts> {
  const [hierarchy, blockIds] = await Promise.all([
    s3GetJson<GeoUnitHierarchy>(s3URI, "geounit-hierarchy.json"),
    s3GetJson<string[]>(s3URI, "block-ids.json")
  ]);
  const numBlocks = countLeaves(hierarchy);
  if (numBlocks !== blockIds.length) {
    throw new Error(
      `Hierarchy leaf count (${numBlocks}) does not match block-ids length (${blockIds.length}) for ${s3URI}`
    );
  }
  return { hierarchy, blockIds, numBlocks };
}

export interface MigrationResult {
  readonly newDefinition: DistrictsDefinition;
  readonly missingGeoIds: readonly string[];
}

export function migrateDefinition(
  oldDefinition: DistrictsDefinition,
  oldRegion: RegionArtifacts,
  newRegion: RegionArtifacts
): MigrationResult {
  // 1. Flatten the old definition to a per-block-index assignment using the
  //    old hierarchy. assignment[i] is the district for old blockIds[i].
  const assignment = buildBlockAssignment(oldDefinition, oldRegion.hierarchy, oldRegion.numBlocks);

  // 2. Materialize the assigned (block, district) pairs keyed by stable GEOID.
  //    Skip district 0 (unassigned) — the rebuild step defaults missing
  //    blocks to 0 anyway, so omitting them keeps the map small and lets us
  //    detect drops cleanly via the missingGeoIds report.
  const records: [string, string][] = [];
  for (let i = 0; i < oldRegion.numBlocks; i++) {
    if (assignment[i] !== 0) {
      records.push([oldRegion.blockIds[i], String(assignment[i])]);
    }
  }

  // 3. Re-key against the new block universe. expandBlockToDistrict handles
  //    the "old block was split into N new sub-blocks" case (parent GEOID in
  //    old → "<GEOID>-1", "<GEOID>-2" in new). Direct GEOID hits stay direct.
  const newBlockIdSet = new Set(newRegion.blockIds);
  const newSplitMap = buildSplitBlockMap(newRegion.blockIds);
  const { blockToDistrict } = expandBlockToDistrict(records, newBlockIdSet, newSplitMap);

  // 4. Track GEOIDs that didn't survive — neither a direct hit nor a split
  //    parent. Caller decides whether to warn or abort.
  const missingGeoIds: string[] = [];
  for (const [oldId] of records) {
    if (!newBlockIdSet.has(oldId) && !newSplitMap.has(oldId)) {
      missingGeoIds.push(oldId);
    }
  }

  // 5. Walk the new hierarchy to assemble the compact nested definition,
  //    collapsing parents whose children share an assignment.
  const newDefinition = importCsvToDefinition(
    newRegion.blockIds,
    newRegion.hierarchy,
    blockToDistrict
  );

  return { newDefinition, missingGeoIds };
}

export default class RetireRegion extends Command {
  static description =
    "Migrate every Project on an archived RegionConfig onto its newer active counterpart, then delete the archived row. Resolves source/target by countryCode + regionCode; expects publish-region --replaces to have produced the (archived old, active new) pair.";

  static args = {
    regionCode: Args.string({
      description: "Region code, e.g. DE",
      required: true
    })
  };

  static flags = {
    country: Flags.string({
      description: "Country code (defaults to US)",
      default: "US"
    }),
    "dry-run": Flags.boolean({
      description: "Print actions without writing",
      default: false
    }),
    limit: Flags.integer({
      description: "Stop after migrating N projects",
      required: false
    }),
    strict: Flags.boolean({
      description:
        "Abort if any assigned block GEOID from the old topology is missing in the new (default: log warnings and leave those geoUnits unassigned)",
      default: false
    })
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(RetireRegion);
    const dryRun = flags["dry-run"];

    const dataSource = await createDataSource();
    const regionRepo = dataSource.getRepository(RegionConfig);
    const projectRepo = dataSource.getRepository(Project);
    const chamberRepo = dataSource.getRepository(Chamber);
    const templateRepo = dataSource.getRepository(ProjectTemplate);

    try {
      // Resolve source (archived) and target (active) by (country, region).
      const matches = await regionRepo.find({
        where: { countryCode: flags.country, regionCode: args.regionCode }
      });
      const archived = matches.filter(r => r.archived);
      const active = matches.filter(r => !r.archived);
      if (archived.length !== 1 || active.length !== 1) {
        this.error(
          `Expected exactly one archived and one active RegionConfig for ${flags.country}/${args.regionCode}; found archived=${archived.length}, active=${active.length}.\n` +
            matches
              .map(
                r =>
                  `  - id=${r.id} archived=${r.archived} version=${r.version.toISOString()} s3URI=${r.s3URI}`
              )
              .join("\n")
        );
      }
      const source = archived[0];
      const target = active[0];
      this.log(`source: ${source.id} (${source.s3URI}, version=${source.version.toISOString()})`);
      this.log(`target: ${target.id} (${target.s3URI}, version=${target.version.toISOString()})`);

      this.log("Loading region artifacts from S3");
      const [oldRegion, newRegion] = await Promise.all([
        loadArtifacts(source.s3URI),
        loadArtifacts(target.s3URI)
      ]);
      this.log(`  source: ${oldRegion.numBlocks} blocks`);
      this.log(`  target: ${newRegion.numBlocks} blocks`);

      // Fetch projects that still point at the source. Idempotent re-runs
      // skip projects already moved.
      const projects = await projectRepo.find({
        where: { regionConfigId: source.id },
        order: { createdDt: "ASC" },
        take: flags.limit
      });
      this.log(`Found ${projects.length} project(s) to migrate`);

      let migrated = 0;
      let failed = 0;
      const totalMissing = new Set<string>();

      for (const project of projects) {
        try {
          const { newDefinition, missingGeoIds } = migrateDefinition(
            project.districtsDefinition,
            oldRegion,
            newRegion
          );
          for (const id of missingGeoIds) totalMissing.add(id);

          if (missingGeoIds.length > 0) {
            this.log(
              `  ${project.name} (${project.id}): ${missingGeoIds.length} assigned GEOIDs not present in target`
            );
            if (flags.strict) {
              this.error(
                `--strict: refusing to migrate ${project.id} because ${missingGeoIds.length} assigned GEOIDs are missing from the target topology (first: ${missingGeoIds.slice(0, 5).join(", ")}). Drop --strict to migrate with those geoUnits unassigned.`
              );
            }
          }

          if (dryRun) {
            this.log(
              `  ${project.name} (${project.id}): would migrate to target (and clear districtProperties)`
            );
          } else {
            // Cast to any: TypeORM's QueryDeepPartialEntity recursively maps
            // every property, which blows up TS instantiation depth on the
            // recursive DistrictsDefinition type.
            await projectRepo.update(project.id, {
              districtsDefinition: newDefinition,
              regionConfigId: target.id,
              regionConfigVersion: target.version,
              districtProperties: null
            } as any);
            this.log(`  ${project.name} (${project.id}): migrated`);
          }
          migrated++;
        } catch (e) {
          this.log(`  ${project.name} (${project.id}): ERROR — ${e}`);
          failed++;
        }
      }

      this.log("");
      this.log(
        `Project migration: ${dryRun ? "would migrate" : "migrated"} ${migrated}, failed ${failed}`
      );
      if (totalMissing.size > 0) {
        this.log(
          `Across all projects, ${totalMissing.size} unique GEOIDs were not present in target.`
        );
      }

      if (failed > 0) {
        this.error(
          `Aborting cleanup: ${failed} project(s) failed to migrate. Re-run after investigating.`
        );
      }
      if (flags.limit !== undefined && projects.length === flags.limit) {
        this.log(`Stopping after --limit=${flags.limit}; skipping cleanup of source RegionConfig.`);
        return;
      }

      // Cleanup pass — only reached when every project on the source migrated cleanly.
      const remainingProjects = await projectRepo.count({ where: { regionConfigId: source.id } });
      if (remainingProjects > 0) {
        this.error(
          `Aborting cleanup: ${remainingProjects} project(s) still reference source after migration. (Concurrent insert?)`
        );
      }

      const sourceChambers = await chamberRepo.find({
        where: { regionConfig: { id: source.id } },
        relations: ["regionConfig"]
      });
      const sourceTemplates = await templateRepo.find({
        where: { regionConfig: { id: source.id } },
        relations: ["regionConfig"]
      });

      if (dryRun) {
        this.log(`Would delete ${sourceChambers.length} chamber(s) tied to source RegionConfig.`);
        if (sourceTemplates.length > 0) {
          this.log(
            `Would skip deleting source RegionConfig — ${sourceTemplates.length} ProjectTemplate(s) still reference it: ${sourceTemplates.map(t => t.id).join(", ")}`
          );
        } else {
          this.log(`Would delete source RegionConfig ${source.id}`);
        }
        return;
      }

      if (sourceChambers.length > 0) {
        await chamberRepo.delete(sourceChambers.map(c => c.id));
        this.log(`Deleted ${sourceChambers.length} chamber(s) tied to source RegionConfig`);
      }

      if (sourceTemplates.length > 0) {
        this.log(
          `Skipping source RegionConfig delete — ${sourceTemplates.length} ProjectTemplate(s) still reference it: ${sourceTemplates.map(t => t.id).join(", ")}`
        );
        this.log(
          "Re-point or delete the templates manually, then re-run retire-region to finish cleanup."
        );
        return;
      }

      await regionRepo.delete(source.id);
      this.log(`Deleted source RegionConfig ${source.id}`);
    } finally {
      await dataSource.destroy();
    }
  }
}
