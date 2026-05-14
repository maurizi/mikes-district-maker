// SPDX-License-Identifier: AGPL-3.0-or-later
// © 2026 Michael Maurizi Jr.

import { Command, Flags, ux } from "@oclif/core";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { parseContainer, type ContainerMeta } from "cloud-topo";
import { decodeContainer, encodeContainer } from "cloud-topo/encode";
import { RegionConfig } from "../../../server/src/region-configs/entities/region-config.entity";
import { createDataSource } from "../lib/dbUtils";

// The container major version the current cloud-topo encoder writes.
// v1 files (produced by cloud-topo 0.1.0) lack the partitioned /
// arc_endpoints sections; re-encoding through decodeContainer →
// encodeContainer stamps them v2 and synthesizes those sections.
const TARGET_MAJOR_VERSION = 2;

const CTOPO_NAME = "region.ctopo";

export default class ReencodeCtopo extends Command {
  static description =
    "Re-encode existing region.ctopo files to the current (v2) cloud-topo format. " +
    "Reads each region's region.ctopo from S3, decodes it back to a topology, re-encodes " +
    "it with the current encoder (synthesizing the v2 arc_endpoints / partitioned sections), " +
    "and overwrites the file in place. Dry-run by default.";

  static flags = {
    bucket: Flags.string({
      char: "b",
      description: "Bucket holding the region artifacts",
      default: "districtbuilder-dev-238046523378"
    }),
    region: Flags.string({
      char: "r",
      description:
        "Only process regions matching this code, e.g. PA or US/PA (default: all active regions)"
    }),
    dryRun: Flags.boolean({
      description:
        "Decode, re-encode and verify but do NOT upload. Disable with --no-dryRun to write.",
      default: true,
      allowNo: true
    }),
    backup: Flags.boolean({
      description:
        "Before overwriting, copy the original file to region.ctopo.v1.bak at the same prefix",
      default: true,
      allowNo: true
    })
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(ReencodeCtopo);

    const dataSource = await createDataSource();
    const repo = dataSource.getRepository(RegionConfig);
    // Only the live regions — archived rows aren't loaded/served.
    const regions = (await repo.find({ where: { archived: false } })).filter(rc =>
      matchesRegionFilter(rc, flags.region)
    );

    if (regions.length === 0) {
      await dataSource.destroy();
      this.log(`No active regions matched${flags.region ? ` filter "${flags.region}"` : ""}.`);
      return;
    }

    this.log(
      `${flags.dryRun ? "[dry run] " : ""}Re-encoding ${regions.length} region(s) in bucket ${flags.bucket}`
    );
    const s3 = new S3Client({});

    let upgraded = 0;
    let skipped = 0;
    const failures: string[] = [];

    for (const rc of regions) {
      const label = `${rc.countryCode}/${rc.regionCode}`;
      const key = `${rc.keyPrefix}${CTOPO_NAME}`;
      try {
        ux.action.start(`${label}: downloading ${key}`);
        const original = await this.getObjectBytes(s3, flags.bucket, key);
        ux.action.stop(`${(original.byteLength / 1024 / 1024).toFixed(1)} MiB`);

        const srcMeta = parseContainer(original).meta;
        if (srcMeta.version >= TARGET_MAJOR_VERSION) {
          this.log(`  ${label}: already v${srcMeta.version}, skipping`);
          skipped++;
          continue;
        }

        this.log(`  ${label}: decoding v${srcMeta.version} (${srcMeta.numArcs} arcs)`);
        const topology = decodeContainer(original);

        const frontLoadedSectionNames = deriveFrontLoadedSections(srcMeta);
        this.log(
          `  ${label}: re-encoding (${frontLoadedSectionNames.length} front-loaded sections)`
        );
        const reencoded = await encodeContainer(topology, {
          compression: "zstd",
          frontLoadedSectionNames
        });

        verifyReencode(srcMeta, reencoded);
        this.log(
          `  ${label}: v${srcMeta.version} ${(original.byteLength / 1024 / 1024).toFixed(1)} MiB ` +
            `→ v${TARGET_MAJOR_VERSION} ${(reencoded.byteLength / 1024 / 1024).toFixed(1)} MiB ` +
            `(verified)`
        );

        if (flags.dryRun) {
          this.log(`  ${label}: [dry run] not uploading`);
          upgraded++;
          continue;
        }

        if (flags.backup) {
          const backupKey = `${rc.keyPrefix}${CTOPO_NAME}.v1.bak`;
          ux.action.start(`${label}: backing up to ${backupKey}`);
          await s3.send(
            new PutObjectCommand({ Bucket: flags.bucket, Key: backupKey, Body: original })
          );
          ux.action.stop();
        }

        ux.action.start(`${label}: uploading ${key}`);
        await s3.send(new PutObjectCommand({ Bucket: flags.bucket, Key: key, Body: reencoded }));
        ux.action.stop();
        upgraded++;
      } catch (err) {
        ux.action.stop("failed");
        const msg = err instanceof Error ? err.message : String(err);
        this.warn(`  ${label}: ${msg}`);
        failures.push(`${label}: ${msg}`);
      }
    }

    await dataSource.destroy();

    this.log(
      `\nDone. ${upgraded} ${flags.dryRun ? "would be upgraded" : "upgraded"}, ` +
        `${skipped} skipped (already v${TARGET_MAJOR_VERSION}), ${failures.length} failed.`
    );
    if (!flags.dryRun && upgraded > 0) {
      this.log(
        "\nNOTE: region.ctopo is served immutable behind CloudFront with a ?v=<version> " +
          "cache-buster that did NOT change. Invalidate the CloudFront distribution for the " +
          "affected /regions/*/region.ctopo paths so edges stop serving the old bytes."
      );
    }
    if (failures.length > 0) {
      this.error(`${failures.length} region(s) failed:\n${failures.join("\n")}`);
    }
  }

  private async getObjectBytes(s3: S3Client, Bucket: string, Key: string): Promise<Uint8Array> {
    const resp = await s3.send(new GetObjectCommand({ Bucket, Key }));
    if (resp.Body === undefined) {
      throw new Error(`empty body for ${Key}`);
    }
    return resp.Body.transformToByteArray();
  }
}

// Match a RegionConfig against an optional `--region` filter that may be
// either a bare region code ("PA") or country/region ("US/PA").
function matchesRegionFilter(rc: RegionConfig, filter: string | undefined): boolean {
  if (filter === undefined || filter === "") return true;
  const norm = filter.toUpperCase();
  return (
    rc.regionCode.toUpperCase() === norm ||
    `${rc.countryCode}/${rc.regionCode}`.toUpperCase() === norm
  );
}

// Rebuild the same front-loaded section set process-geojson uses, derived
// from the source container so the re-encoded file keeps its open-path
// prefetch layout. Only names actually present in the source are kept.
//   - per-layer parent-index sections `${layer}/${ancestor}Idx`
//   - recent-election base-layer voting columns democrat*/republican* {16,20,24}
function deriveFrontLoadedSections(meta: ContainerMeta): string[] {
  const present = new Set(meta.sections.map(s => s.name));
  const geoLevelIds = meta.layers.map(l => l.name); // base-first, as encoded
  const out: string[] = [];

  if (geoLevelIds.length > 0) {
    const base = geoLevelIds[0];
    for (const name of present) {
      if (!name.startsWith(`${base}/`)) continue;
      const id = name.slice(base.length + 1);
      if (
        (id.startsWith("democrat") || id.startsWith("republican")) &&
        (id.endsWith("16") || id.endsWith("20") || id.endsWith("24"))
      ) {
        out.push(name);
      }
    }
  }

  for (let i = 0; i < geoLevelIds.length - 1; i++) {
    for (let j = i + 1; j < geoLevelIds.length; j++) {
      const name = `${geoLevelIds[i]}/${geoLevelIds[j]}Idx`;
      if (present.has(name)) out.push(name);
    }
  }

  return out;
}

// Confirm the re-encode produced a valid v2 container with the same
// topology shape as the source, and that the headline v2 section
// (arc_endpoints) was synthesized.
function verifyReencode(srcMeta: ContainerMeta, reencoded: Uint8Array): void {
  const meta = parseContainer(reencoded).meta;
  if (meta.version !== TARGET_MAJOR_VERSION) {
    throw new Error(`re-encoded container is v${meta.version}, expected v${TARGET_MAJOR_VERSION}`);
  }
  if (meta.numArcs !== srcMeta.numArcs) {
    throw new Error(`numArcs changed: ${srcMeta.numArcs} → ${meta.numArcs}`);
  }
  const srcCounts = new Map(srcMeta.layers.map(l => [l.name, l.numGeometries]));
  for (const layer of meta.layers) {
    const before = srcCounts.get(layer.name);
    if (before !== layer.numGeometries) {
      throw new Error(
        `layer ${layer.name} geometry count changed: ${before ?? "(missing)"} → ${layer.numGeometries}`
      );
    }
  }
  if (meta.layers.length !== srcMeta.layers.length) {
    throw new Error(`layer count changed: ${srcMeta.layers.length} → ${meta.layers.length}`);
  }
  if (meta.arcEndpointsBlocks === undefined) {
    throw new Error("re-encoded container is missing the v2 arc_endpoints section");
  }
}
