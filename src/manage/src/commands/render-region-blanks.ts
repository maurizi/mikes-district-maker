// SPDX-License-Identifier: AGPL-3.0-or-later
// © 2026 Michael Maurizi Jr.

import { Command, Flags } from "@oclif/core";
import {
  S3Client,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand
} from "@aws-sdk/client-s3";
import { type Feature, type MultiPolygon } from "geojson";
import puppeteer, { type Browser, type Page } from "puppeteer-core";

import { createDataSource } from "../lib/dbUtils";
import { RegionConfig } from "../../../server/src/region-configs/entities/region-config.entity";
import {
  type DistrictProperties,
  type GeoUnitHierarchy,
  type IStaticMetadata,
  type ThumbnailGeoJSON
} from "../../../shared/entities";
import { CtopoClient, makeRangeFetcher, type RangeFetcher } from "cloud-topo";
import { computeDistrictBoundaries } from "../../../shared/boundary";
import { simplifyForThumbnail } from "../../../shared/thumbnail";

const s3 = new S3Client({});

// The only color a blank-region thumbnail uses: the unassigned-district gray
// that matches the live editor's rendering of district 0.
const UNASSIGNED_COLOR = "#EDEDED";

// Matches the harness in backfill-thumbnails: a minimal MapLibre page that
// renders a FeatureCollection into a PNG of the requested size. Two variants
// per region — a square in-app image and a 1.91:1 og:image — kept in sync
// with src/client/thumbnail-render.ts.
type Variant = "square" | "og";
const VARIANT_DIMENSIONS: Record<Variant, { readonly width: number; readonly height: number }> = {
  square: { width: 1200, height: 1200 },
  og: { width: 1200, height: 630 }
};

const harnessHtml = (width: number, height: number): string => `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Region Blank Render Harness</title>
<link href="https://unpkg.com/maplibre-gl@5.21.1/dist/maplibre-gl.css" rel="stylesheet" />
<script src="https://unpkg.com/maplibre-gl@5.21.1/dist/maplibre-gl.js"></script>
<style>
  html, body { margin: 0; padding: 0; background: #fff; }
  #map { width: ${width}px; height: ${height}px; background: #fff; }
</style>
</head>
<body>
<div id="map"></div>
<script>
window.renderDistricts = function (coloredDistricts, bounds) {
  return new Promise(function (resolve, reject) {
    var map = new maplibregl.Map({
      container: "map",
      style: { version: 8, sources: {}, layers: [] },
      bounds: bounds,
      fitBoundsOptions: { padding: 15, animate: false },
      interactive: false,
      attributionControl: false,
      canvasContextAttributes: { preserveDrawingBuffer: true }
    });
    function finish() {
      map.getCanvas().toBlob(function (blob) {
        if (!blob) { reject(new Error("toBlob returned null")); return; }
        var reader = new FileReader();
        reader.onload = function () {
          var result = reader.result;
          var commaIdx = result.indexOf(",");
          resolve(commaIdx >= 0 ? result.slice(commaIdx + 1) : result);
        };
        reader.onerror = function () { reject(reader.error); };
        reader.readAsDataURL(blob);
      }, "image/png");
    }
    map.on("load", function () {
      map.addSource("districts", { type: "geojson", data: coloredDistricts });
      map.addLayer({
        id: "districts",
        type: "fill",
        source: "districts",
        paint: { "fill-color": { type: "identity", property: "color" } }
      });
      map.once("idle", finish);
    });
    map.on("error", function (e) { reject(e.error || e); });
  });
};
</script>
</body>
</html>`;

interface RegionData {
  readonly geoUnitHierarchy: GeoUnitHierarchy;
  readonly numBlocks: number;
  readonly client: CtopoClient;
  readonly baseLayer: string;
  readonly bbox: readonly [number, number, number, number];
}

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

function makeS3Fetcher(keyPrefix: string, fileName: string): RangeFetcher {
  return makeRangeFetcher(async rangeHeader => {
    const res = await s3.send(
      new GetObjectCommand({
        Bucket: regionArtifactsBucket(),
        Key: `${keyPrefix}${fileName}`,
        Range: rangeHeader
      })
    );
    const bytes = (await res.Body?.transformToByteArray()) ?? new Uint8Array();
    return new Uint8Array(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
    );
  });
}

async function loadRegionData(keyPrefix: string): Promise<RegionData> {
  const [geoUnitHierarchy, metadata, client] = await Promise.all([
    s3GetJson<GeoUnitHierarchy>(keyPrefix, "geounit-hierarchy.json"),
    s3GetJson<IStaticMetadata>(keyPrefix, "static-metadata.json"),
    CtopoClient.openWith(makeS3Fetcher(keyPrefix, "region.ctopo"))
  ]);
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
  return {
    geoUnitHierarchy,
    numBlocks,
    client,
    baseLayer: metadata.geoLevelHierarchy[0].id,
    bbox: metadata.bbox
  };
}

// Produces a ThumbnailGeoJSON with a single feature for district 0 containing
// the entire region outline. No property lookups (demographics/voting) because
// a blank map has no assignments to summarize.
async function buildBlankThumbnail(region: RegionData): Promise<ThumbnailGeoJSON> {
  // All blocks assigned to district 0 (unassigned). numberOfDistricts = 0
  // tells computeDistrictBoundaries to only emit the district-0 feature.
  const assignment = new Uint8Array(region.numBlocks);
  const boundaries = await computeDistrictBoundaries(
    region.client,
    region.baseLayer,
    assignment,
    0
  );
  const features: Feature<MultiPolygon, DistrictProperties>[] = boundaries.map((b, i) => ({
    type: "Feature",
    id: i,
    geometry: b.geometry,
    properties: {
      compactness: b.compactness,
      contiguity: b.contiguity,
      demographics: {},
      voting: {}
    }
  }));
  return simplifyForThumbnail({ type: "FeatureCollection", features });
}

function withColor(thumbnail: ThumbnailGeoJSON): ThumbnailGeoJSON {
  return {
    ...thumbnail,
    features: thumbnail.features.map(f => ({
      ...f,
      properties: { ...f.properties, color: UNASSIGNED_COLOR }
    }))
  };
}

async function connectBrowser(browserUrl: string): Promise<Browser> {
  const wsEndpoint = browserUrl.replace(/^http/, "ws");
  return await puppeteer.connect({ browserWSEndpoint: wsEndpoint });
}

async function renderPng(
  page: Page,
  thumbnail: ThumbnailGeoJSON,
  bbox: readonly [number, number, number, number]
): Promise<Buffer> {
  const colored = withColor(thumbnail);
  const base64 = await page.evaluate(
    async (districts, bounds) => {
      return await (window as any).renderDistricts(districts, bounds);
    },
    colored as unknown as Record<string, unknown>,
    [...bbox] as [number, number, number, number]
  );
  return Buffer.from(base64, "base64");
}

async function renderPngInFreshPage(
  getBrowser: () => Promise<Browser>,
  thumbnail: ThumbnailGeoJSON,
  bbox: readonly [number, number, number, number],
  variant: Variant
): Promise<Buffer> {
  const { width, height } = VARIANT_DIMENSIONS[variant];
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setViewport({ width, height, deviceScaleFactor: 1 });
    await page.setContent(harnessHtml(width, height), { waitUntil: "networkidle0" });
    return await renderPng(page, thumbnail, bbox);
  } finally {
    try {
      await page.close();
    } catch {
      // ignore
    }
  }
}

async function s3ObjectExists(bucket: string, key: string): Promise<boolean> {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch (e: any) {
    if (e?.name === "NotFound" || e?.$metadata?.httpStatusCode === 404) return false;
    throw e;
  }
}

export default class RenderRegionBlanks extends Command {
  static description =
    "Render a blank thumbnail PNG for every active region and upload to the thumbnails bucket under key region-<regionId>.png. Used by the /thumbnails/region-<id>.png fallback the server returns for projects that have no assignments yet.";

  static flags = {
    "dry-run": Flags.boolean({
      description: "Print which regions would be rendered without writing to S3",
      default: false
    }),
    bucket: Flags.string({
      description: "Override the thumbnails S3 bucket (defaults to $THUMBNAILS_BUCKET)",
      required: false
    }),
    "browser-url": Flags.string({
      description:
        "CDP URL of a headless Chromium (defaults to $PUPPETEER_BROWSER_URL, then http://chromium:3000).",
      required: false
    }),
    force: Flags.boolean({
      description: "Re-render and overwrite even if region-<id>.png already exists in S3.",
      default: false
    }),
    region: Flags.string({
      description: "Only process regions matching this region code (e.g. PA). Repeatable.",
      multiple: true,
      required: false
    })
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(RenderRegionBlanks);
    const dryRun = flags["dry-run"];
    const bucket = flags.bucket || process.env.THUMBNAILS_BUCKET;
    const browserUrl =
      flags["browser-url"] || process.env.PUPPETEER_BROWSER_URL || "http://chromium:3000";
    if (!bucket && !dryRun) {
      this.error(
        "Thumbnails bucket not configured. Set THUMBNAILS_BUCKET or pass --bucket=<name>."
      );
    }

    const dataSource = await createDataSource();
    const regionRepo = dataSource.getRepository(RegionConfig);

    // Archived regions don't have static data in S3, so their blocks would
    // fail to load — skip them. Hidden regions are fine: they still back
    // existing projects we might need the fallback for.
    const allRegions = await regionRepo.find({
      where: { archived: false },
      order: { regionCode: "ASC" }
    });
    const regions = flags.region?.length
      ? allRegions.filter(r => flags.region!.includes(r.regionCode))
      : allRegions;

    this.log(`Found ${regions.length} region(s)`);
    if (regions.length === 0) {
      await dataSource.destroy();
      this.exit(0);
    }

    const state: { browser: Browser | null } = { browser: null };
    const getBrowser = async (): Promise<Browser> => {
      if (state.browser && state.browser.connected) return state.browser;
      if (state.browser) {
        try {
          await state.browser.disconnect();
        } catch {
          // ignore
        }
      }
      state.browser = await connectBrowser(browserUrl);
      return state.browser;
    };

    let rendered = 0;
    let skipped = 0;
    let failed = 0;

    try {
      for (const region of regions) {
        const squareKey = `region-${region.id}.png`;
        const ogKey = `region-${region.id}-og.png`;
        if (!flags.force && bucket && !dryRun) {
          const [squareExists, ogExists] = await Promise.all([
            s3ObjectExists(bucket, squareKey),
            s3ObjectExists(bucket, ogKey)
          ]);
          if (squareExists && ogExists) {
            this.log(
              `${region.regionCode}: skipping (s3://${bucket}/${squareKey} and ${ogKey} exist)`
            );
            skipped++;
            continue;
          }
        }
        try {
          const regionData = await loadRegionData(region.keyPrefix);
          const thumbnail = await buildBlankThumbnail(regionData);
          const squarePng = await renderPngInFreshPage(
            getBrowser,
            thumbnail,
            regionData.bbox,
            "square"
          );
          const ogPng = await renderPngInFreshPage(getBrowser, thumbnail, regionData.bbox, "og");
          if (dryRun) {
            this.log(
              `${region.regionCode}: would upload ${squarePng.length}B + ${ogPng.length}B to s3://${bucket}/${squareKey} and ${ogKey}`
            );
          } else {
            await Promise.all([
              s3.send(
                new PutObjectCommand({
                  Bucket: bucket!,
                  Key: squareKey,
                  Body: squarePng,
                  ContentType: "image/png",
                  CacheControl: "public, max-age=86400"
                })
              ),
              s3.send(
                new PutObjectCommand({
                  Bucket: bucket!,
                  Key: ogKey,
                  Body: ogPng,
                  ContentType: "image/png",
                  CacheControl: "public, max-age=86400"
                })
              )
            ]);
            this.log(
              `${region.regionCode}: uploaded ${squarePng.length}B to ${squareKey}, ${ogPng.length}B to ${ogKey}`
            );
          }
          rendered++;
        } catch (e) {
          this.log(`${region.regionCode}: ERROR — ${e}`);
          failed++;
        }
      }
    } finally {
      if (state.browser) {
        try {
          await state.browser.disconnect();
        } catch {
          // ignore
        }
      }
    }

    this.log("");
    this.log("=== Done ===");
    this.log(
      `${dryRun ? "Would render" : "Rendered"}: ${rendered}, Skipped: ${skipped}, Failed: ${failed}`
    );

    await dataSource.destroy();
    this.exit(0);
  }
}
