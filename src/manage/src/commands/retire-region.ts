// SPDX-License-Identifier: AGPL-3.0-or-later
// © 2026 Michael Maurizi Jr.

import { Args, Command, Flags } from "@oclif/core";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";

import { createDataSource } from "../lib/dbUtils";
import { Project } from "../../../server/src/projects/entities/project.entity";
import { Chamber } from "../../../server/src/chambers/entities/chamber.entity";
import { ProjectTemplate } from "../../../server/src/project-templates/entities/project-template.entity";
import { RegionConfig } from "../../../server/src/region-configs/entities/region-config.entity";
import { type DistrictsDefinition, type GeoUnitHierarchy } from "../../../shared/entities";
import { buildSplitBlockMap } from "../../../shared/csv-import";
import { decode, encode } from "../../../shared/compress";

const s3 = new S3Client({});

function regionArtifactsBucket(): string {
  const bucket = process.env.REGION_ARTIFACTS_BUCKET;
  if (!bucket) {
    throw new Error("REGION_ARTIFACTS_BUCKET env var must be set");
  }
  return bucket;
}

async function s3GetJson<T>(keyPrefix: string, fileName: string): Promise<T> {
  const res = await s3.send(
    new GetObjectCommand({ Bucket: regionArtifactsBucket(), Key: `${keyPrefix}${fileName}` })
  );
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

async function loadArtifacts(keyPrefix: string): Promise<RegionArtifacts> {
  const [hierarchy, blockIds] = await Promise.all([
    s3GetJson<GeoUnitHierarchy>(keyPrefix, "geounit-hierarchy.json"),
    s3GetJson<string[]>(keyPrefix, "block-ids.json")
  ]);
  const numBlocks = countLeaves(hierarchy);
  if (numBlocks !== blockIds.length) {
    throw new Error(
      `Hierarchy leaf count (${numBlocks}) does not match block-ids length (${blockIds.length}) for ${keyPrefix}`
    );
  }
  return { hierarchy, blockIds, numBlocks };
}

export interface MigrationResult {
  readonly newDefinition: DistrictsDefinition;
  // Old GEOIDs that have no path forward into the new build (no direct hit,
  // no forward-split parent, no reverse-split base).
  readonly missingGeoIds: readonly string[];
  // New GEOIDs left at district 0 because the old data pointing at them
  // disagreed and we couldn't safely resolve. Two flavors collapse here:
  //   (a) reverse-split where any contributing sub-block had block-level
  //       intent (user explicitly drew a sub-block boundary in the old
  //       definition) — refuses to defer to the precinct.
  //   (b) precinct-level rollup tried but the precinct's other singletons
  //       disagreed too.
  readonly conflictedNewIds: readonly string[];
}

export function migrateDefinition(
  oldDefinition: DistrictsDefinition,
  oldRegion: RegionArtifacts,
  newRegion: RegionArtifacts
): MigrationResult {
  // 1. Walk the old definition + hierarchy together. For each old block,
  //    record its district AND whether the assignment came from a number
  //    node at a non-leaf level (precinct-or-broader intent) versus from a
  //    leaf-level number embedded in an array (block-level intent — the user
  //    explicitly assigned at sub-precinct granularity).
  const oldAssignment = new Uint8Array(oldRegion.numBlocks);
  // 1 = precinct-or-broader intent; 0 = block-level (or unassigned).
  const oldPrecinctIntent = new Uint8Array(oldRegion.numBlocks);

  function fillSubtree(district: number, hier: GeoUnitHierarchy | number) {
    if (typeof hier === "number") {
      oldAssignment[hier] = district;
      oldPrecinctIntent[hier] = 1;
      return;
    }
    for (const child of hier) fillSubtree(district, child);
  }
  function walkOld(defn: DistrictsDefinition | number, hier: GeoUnitHierarchy | number) {
    if (typeof hier === "number") {
      // Leaf — defn must be a scalar district. Intent stays 0 (default).
      if (typeof defn === "number") oldAssignment[hier] = defn;
      return;
    }
    if (typeof defn === "number") {
      // Number at a non-leaf level: every block under here gets `defn`,
      // and the intent is precinct-or-broader.
      fillSubtree(defn, hier);
      return;
    }
    for (let i = 0; i < hier.length; i++) {
      walkOld(defn[i] as DistrictsDefinition | number, hier[i]);
    }
  }
  walkOld(oldDefinition, oldRegion.hierarchy);

  // 2. Index old blocks by GEOID with their (district, intent).
  const oldByGeoId = new Map<string, { d: number; precinctIntent: boolean }>();
  for (let i = 0; i < oldRegion.numBlocks; i++) {
    if (oldAssignment[i] !== 0) {
      oldByGeoId.set(oldRegion.blockIds[i], {
        d: oldAssignment[i],
        precinctIntent: oldPrecinctIntent[i] === 1
      });
    }
  }

  // 3. For each new block, collect every old district that maps onto it
  //    (direct hit, forward split, reverse split). Track whether all
  //    contributing votes came from precinct-or-broader intent — if any
  //    contributor had block-level intent the user explicitly chose
  //    sub-precinct granularity, and the new precinct is not allowed to
  //    paper over that disagreement.
  const oldSplitMap = buildSplitBlockMap(oldRegion.blockIds);
  const newSplitMap = buildSplitBlockMap(newRegion.blockIds);
  const newBlockIdSet = new Set(newRegion.blockIds);

  type Vote = { districts: Set<number>; allPrecinctIntent: boolean };
  const newVotes: Vote[] = [];
  for (let i = 0; i < newRegion.numBlocks; i++) {
    const newId = newRegion.blockIds[i];
    const v: Vote = { districts: new Set(), allPrecinctIntent: true };

    function addVote(geoId: string) {
      const e = oldByGeoId.get(geoId);
      if (!e) return;
      v.districts.add(e.d);
      if (!e.precinctIntent) v.allPrecinctIntent = false;
    }

    addVote(newId); // direct hit
    const dashIdx = newId.indexOf("-");
    if (dashIdx !== -1) addVote(newId.substring(0, dashIdx)); // forward-split parent
    const splits = oldSplitMap.get(newId);
    if (splits) for (const s of splits) addVote(s); // reverse-split sub-blocks

    newVotes.push(v);
  }

  // 4. Walk the new hierarchy. At the smallest grouping (parent-of-leaves —
  //    the precinct in a county→precinct→block hierarchy), aggregate child
  //    votes:
  //      - If non-ambiguous singletons all agree on D and there's no
  //        block-level holdout, the whole precinct is D and ambiguous
  //        children inherit it. (Precinct-rollup — the new behavior.)
  //      - Otherwise per-child fallback: singletons keep their value;
  //        ambiguous children stay 0 and are reported as conflicted.
  //    Higher levels collapse uniform branches as before.
  const conflictedNewIds: string[] = [];

  function resolvePrecinct(blockIndices: readonly number[]): DistrictsDefinition | number {
    let singletonAnchor: number | null = null;
    let singletonsDisagree = false;
    let hasBlockLevelHoldout = false;
    for (const idx of blockIndices) {
      const v = newVotes[idx];
      if (v.districts.size === 1) {
        const d = v.districts.values().next().value as number;
        if (singletonAnchor === null) singletonAnchor = d;
        else if (singletonAnchor !== d) singletonsDisagree = true;
      } else if (v.districts.size > 1 && !v.allPrecinctIntent) {
        hasBlockLevelHoldout = true;
      }
    }
    const canRollUp = !singletonsDisagree && !hasBlockLevelHoldout && singletonAnchor !== null;

    if (canRollUp) {
      const D = singletonAnchor as number;
      const children = blockIndices.map(idx => {
        const v = newVotes[idx];
        if (v.districts.size === 1) return v.districts.values().next().value as number;
        if (v.districts.size > 1 && v.allPrecinctIntent) return D;
        return 0;
      });
      if (children.every(c => c === D)) return D;
      return children;
    }

    return blockIndices.map(idx => {
      const v = newVotes[idx];
      if (v.districts.size === 1) return v.districts.values().next().value as number;
      if (v.districts.size > 1) conflictedNewIds.push(newRegion.blockIds[idx]);
      return 0;
    });
  }

  function buildNode(node: GeoUnitHierarchy | number): DistrictsDefinition | number {
    if (typeof node === "number") {
      // Leaf at a non-precinct depth (root-level block, etc.) — no precinct
      // to defer to, so ambiguous votes have to stay unresolved.
      const v = newVotes[node];
      if (v.districts.size === 1) return v.districts.values().next().value as number;
      if (v.districts.size > 1) conflictedNewIds.push(newRegion.blockIds[node]);
      return 0;
    }
    if (node.every(c => typeof c === "number")) {
      return resolvePrecinct(node as readonly number[]);
    }
    const results = node.map(c => buildNode(c));
    if (results.every(r => r === results[0])) return results[0];
    return results;
  }
  // Root MUST stay an array — DistrictsDefinition is MutableGeoUnitCollection[]
  // and downstream callers index into it.
  const newDefinition = newRegion.hierarchy.map(c => buildNode(c)) as DistrictsDefinition;

  // 5. Track old GEOIDs with no path into the new build.
  const missingGeoIds: string[] = [];
  for (let i = 0; i < oldRegion.numBlocks; i++) {
    if (oldAssignment[i] === 0) continue;
    const oldId = oldRegion.blockIds[i];
    if (newBlockIdSet.has(oldId)) continue;
    if (newSplitMap.has(oldId)) continue;
    const dashIdx = oldId.indexOf("-");
    if (dashIdx !== -1 && newBlockIdSet.has(oldId.substring(0, dashIdx))) continue;
    missingGeoIds.push(oldId);
  }

  return { newDefinition, missingGeoIds, conflictedNewIds };
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
        "Abort if any project hits a missing GEOID or an unresolvable block-level conflict (default: log warnings and leave those geoUnits unassigned)",
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
                  `  - id=${r.id} archived=${r.archived} version=${r.version.toISOString()} keyPrefix=${r.keyPrefix}`
              )
              .join("\n")
        );
      }
      const source = archived[0];
      const target = active[0];
      this.log(
        `source: ${source.id} (${source.keyPrefix}, version=${source.version.toISOString()})`
      );
      this.log(
        `target: ${target.id} (${target.keyPrefix}, version=${target.version.toISOString()})`
      );

      this.log("Loading region artifacts from S3");
      const [oldRegion, newRegion] = await Promise.all([
        loadArtifacts(source.keyPrefix),
        loadArtifacts(target.keyPrefix)
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
      const totalConflicted = new Set<string>();

      for (const project of projects) {
        try {
          const oldDef = await decode<DistrictsDefinition>(project.districtsDefinition);
          const { newDefinition, missingGeoIds, conflictedNewIds } = migrateDefinition(
            oldDef,
            oldRegion,
            newRegion
          );
          for (const id of missingGeoIds) totalMissing.add(id);
          for (const id of conflictedNewIds) totalConflicted.add(id);

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

          if (conflictedNewIds.length > 0) {
            this.log(
              `  ${project.name} (${project.id}): ${conflictedNewIds.length} new block(s) left unassigned (old data conflicted and could not be resolved at the precinct level)`
            );
            if (flags.strict) {
              this.error(
                `--strict: refusing to migrate ${project.id} because ${conflictedNewIds.length} new block(s) couldn't be resolved (first: ${conflictedNewIds.slice(0, 5).join(", ")}). Drop --strict to migrate with those blocks unassigned.`
              );
            }
          }

          if (dryRun) {
            this.log(
              `  ${project.name} (${project.id}): would migrate to target (and clear districtProperties)`
            );
          } else {
            await projectRepo.update(project.id, {
              districtsDefinition: await encode(newDefinition),
              regionConfigId: target.id,
              regionConfigVersion: target.version,
              districtProperties: null
            });
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
      if (totalConflicted.size > 0) {
        this.log(
          `Across all projects, ${totalConflicted.size} unique new block(s) couldn't be resolved.`
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

      // Chambers are shared resources (many projects → one chamber row), so
      // we migrate them by re-pointing region_config_id rather than creating
      // a parallel set on target and updating every project's chamber_id.
      // That means target should not already have chambers of its own — if
      // it does, someone re-ran seed-us-chambers after publish-region
      // --replaces and re-pointing would create duplicate (target, name)
      // rows. Bail and let the operator sort it out.
      const targetChambers = await chamberRepo.find({
        where: { regionConfig: { id: target.id } }
      });
      if (targetChambers.length > 0) {
        this.error(
          `Target RegionConfig ${target.id} already has ${targetChambers.length} chamber(s); refusing to re-point source chambers because that would create duplicates. Likely cause: seed-us-chambers was re-run after publish-region --replaces. Delete the target's chambers (${targetChambers.map(c => c.id).join(", ")}) and re-run.`
        );
      }

      if (dryRun) {
        this.log(
          `Would re-point ${sourceChambers.length} chamber(s) from source to target RegionConfig.`
        );
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
        // Cast to any: same TypeORM QueryDeepPartialEntity instantiation-depth
        // workaround used in the project update above.
        await chamberRepo.update(
          sourceChambers.map(c => c.id),
          {
            regionConfig: { id: target.id }
          } as any
        );
        this.log(
          `Re-pointed ${sourceChambers.length} chamber(s) from source to target RegionConfig`
        );
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
