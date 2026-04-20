// SPDX-License-Identifier: AGPL-3.0-or-later
// © 2026 Michael Maurizi Jr.

import { Command, Flags } from "@oclif/core";
import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { IsNull } from "typeorm";
import { type Feature, type MultiPolygon } from "geojson";
import puppeteer, { type Browser, type Page } from "puppeteer-core";

import { createDataSource } from "../lib/dbUtils";
import { Project } from "../../../server/src/projects/entities/project.entity";
import {
  type DistrictProperties,
  type DistrictsGeoJSON,
  type GeoUnitHierarchy,
  type IStaticFile,
  type IStaticMetadata,
  type S3URI,
  type ThumbnailGeoJSON,
  type TypedArrays
} from "../../../shared/entities";
import {
  type AdjacencyData,
  buildBlockAssignment,
  buildReverseIndex,
  computeDistrictBoundaries
} from "../../../shared/boundary";
import { getVoting } from "../../../shared/functions";
import { simplifyForThumbnail } from "../../../shared/thumbnail";

const s3 = new S3Client({});

// Client-side district color palette, kept in sync with src/client/constants/colors.ts.
// Index 0 ("transparent") is overridden to light gray in the live mini-map,
// matching what ProjectDistrictsMap + thumbnail-render do at render time.
const UNASSIGNED_COLOR = "#EDEDED";

const DISTRICT_COLORS = [
  "transparent",
  "#19CB35",
  "#F4B53F",
  "#8053F6",
  "#A9573D",
  "#0AC4FF",
  "#FE6F2A",
  "#2E7EF9",
  "#F72B61",
  "#EDAAC5",
  "#5DBBAE",
  "#6B6783",
  "#FFDC5B",
  "#FF937B",
  "#A00090",
  "#016071",
  "#8AB2FB",
  "#858C73",
  "#bfef45",
  "#e6beff",
  "#0000ff",
  "#FF0018",
  "#00FF33",
  "#FFFF00",
  "#1CE6FF",
  "#FF34FF",
  "#c0c19f",
  "#BDFCC8",
  "#FAD8B6",
  "#ACC7EC",
  "#449896",
  "#c23000",
  "#4fc601",
  "#ff6832",
  "#6b4f29",
  "#962b75",
  "#ccd27f",
  "#005c8b",
  "#00a45f",
  "#ea1ca9",
  "#d68e01",
  "#0086ed",
  "#6b7900",
  "#0000a6",
  "#8502ff",
  "#ff0020",
  "#db9d72",
  "#ff5ae4",
  "#4692ad",
  "#e45f35",
  "#e2bc00",
  "#018615",
  "#8f7f00",
  "#a449dc",
  "#e70452",
  "#2e57aa",
  "#dffb71",
  "#e5a532",
  "#7dbf32",
  "#5ea7ff",
  "#c64289",
  "#6d3800",
  "#f4d749",
  "#7a7bff",
  "#0cea91",
  "#ff4526",
  "#322edf",
  "#00905e",
  "#671190",
  "#9ccc04",
  "#608eff",
  "#563930",
  "#ff6f01",
  "#ddbc62",
  "#20e200",
  "#74569e",
  "#3156dc",
  "#ffe47d",
  "#5a0007",
  "#fc009c",
  "#598c5a",
  "#7900d7",
  "#be0028",
  "#73be54",
  "#856465",
  "#00cde2",
  "#ff0169",
  "#c36d96",
  "#cfff00",
  "#363dff",
  "#ff9079",
  "#772600",
  "#5eb393",
  "#d25b88",
  "#8b4a4e",
  "#a3c8c9",
  "#ac84dd",
  "#88ec69",
  "#c42221",
  "#536eff",
  "#5d3033",
  "#ccaa35",
  "#04784d",
  "#bd7322",
  "#5b113c",
  "#4145a7",
  "#8bc891",
  "#bc23ff",
  "#fd0039",
  "#8bb400",
  "#0aa6d8",
  "#ffb500",
  "#ff74fe",
  "#0100e2",
  "#ff5f6b",
  "#C9D2E5",
  "#00e0e4",
  "#ce934c",
  "#0568ec",
  "#893de3",
  "#51a058",
  "#66796d",
  "#ff3b53",
  "#3db5a7",
  "#e69034",
  "#00447d",
  "#b88183",
  "#eec3ff",
  "#bec459",
  "#370e77",
  "#7ed379",
  "#e704c4",
  "#e5d381",
  "#ff9b03",
  "#5ebcd1",
  "#4b0059",
  "#8c4787",
  "#1a7b42",
  "#ff6c60",
  "#dcde5c",
  "#da71ff",
  "#8da4db",
  "#1be177",
  "#890039",
  "#0e72c5",
  "#e8c282",
  "#00ab4d",
  "#d16100",
  "#6751bb",
  "#ff4f78",
  "#00a6aa",
  "#e83000",
  "#1ca370",
  "#eb9a8b",
  "#00ffff",
  "#ffc07f",
  "#48b176",
  "#953f00",
  "#e500f1",
  "#94a9c9",
  "#7d9f00",
  "#ff1a59",
  "#5eaadd",
  "#025117",
  "#d7c54a",
  "#9cb8e4",
  "#b3af9d",
  "#ff90c9",
  "#79db21",
  "#922329",
  "#976fd9",
  "#B5F0B1",
  "#a76f42",
  "#938a81",
  "#bb1f69",
  "#003177",
  "#84edf7",
  "#a97399",
  "#ffb550",
  "#9e0366",
  "#5a9bc2",
  "#4fc15f",
  "#89412e",
  "#ff2f80",
  "#be811a",
  "#fec96d",
  "#8181d5",
  "#6fe9ad",
  "#d1511c",
  "#033c61",
  "#e383e6",
  "#a37e6f",
  "#7cb9ba",
  "#2eb500",
  "#ea0072",
  "#00489c",
  "#ffbaad",
  "#3b5dff",
  "#e27a05",
  "#8f5df8",
  "#9c6966",
  "#c4df72",
  "#f35691",
  "#252f99",
  "#a168a6",
  "#04f757",
  "#ec5200",
  "#da4cff",
  "#0aa3f7",
  "#66460a",
  "#8502aa",
  "#e6e5a7",
  "#0045d2",
  "#ca834e",
  "#314c1e",
  "#b0415d",
  "#52ce79",
  "#ae81ff",
  "#378fdb",
  "#a9795c",
  "#f77183",
  "#98d058",
  "#e20027",
  "#efafff",
  "#0098ff",
  "#101835",
  "#456648",
  "#a4e804",
  "#b4a04f",
  "#c9403a",
  "#7560d5",
  "#4b6ba5",
  "#fcc7db",
  "#99adc0",
  "#9cff93",
  "#ff7b59",
  "#71b2f5",
  "#ff3bc1",
  "#c59700",
  "#006679",
  "#bb3c42",
  "#00b433",
  "#0060cd",
  "#9bbb57",
  "#4621b2",
  "#97703c",
  "#bc65e9",
  "#66e1d3",
  "#7f9eff",
  "#ba0900",
  "#b28d2d",
  "#ea8b66",
  "#cce93a",
  "#2f5d9b",
  "#ed3488",
  "#02d346",
  "#ff7b7d",
  "#0080cf",
  "#a77500",
  "#6eff92",
  "#e87eac",
  "#00ccff",
  "#b903aa",
  "#be452d",
  "#b4a200",
  "#5875c1",
  "#80ffcd",
  "#a3dae4",
  "#da0004",
  "#abe86b",
  "#da713c",
  "#029bdb",
  "#002e17",
  "#da007c",
  "#adaaff",
  "#00d891",
  "#76912f",
  "#89006a",
  "#E3C28A",
  "#ff84e6",
  "#014a68",
  "#dd4a38",
  "#9b9700",
  "#7fdefe",
  "#682021",
  "#3a2465",
  "#8d8546",
  "#ba6200",
  "#4ac684",
  "#012c58",
  "#ffa861",
  "#c535a9",
  "#77d796",
  "#9f94f0",
  "#c2ff99",
  "#cc0744",
  "#bd744e",
  "#58afad",
  "#602b70",
  "#ffe09e",
  "#f56d93",
  "#3b000a",
  "#aa9a92",
  "#979440",
  "#555196",
  "#7ac5a6",
  "#e30091",
  "#006039",
  "#cd7dae",
  "#e66d53",
  "#5771da",
  "#62e674",
  "#c6d300",
  "#013349",
  "#17fce4",
  "#dd3248",
  "#e58e56",
  "#8a9f45",
  "#006fa6",
  "#ffb3e1",
  "#70ec98",
  "#6635af",
  "#b77b68",
  "#5eff03",
  "#b5b400",
  "#91028c",
  "#34bbff",
  "#b56481",
  "#5b62c1",
  "#dd587b",
  "#96c57f",
  "#d20096",
  "#009087",
  "#e98176",
  "#445083",
  "#fff69f",
  "#741d16",
  "#ff6ec2",
  "#6ad450",
  "#ffb789",
  "#9556bd",
  "#8fb0ff",
  "#b70546",
  "#0cbd66",
  "#067eaf",
  "#d86a78",
  "#31ddae",
  "#d60034",
  "#70968e",
  "#4979b0",
  "#bf45cc",
  "#7e6405",
  "#006c31",
  "#4b4b6a",
  "#997d87",
  "#4c83a1",
  "#6a9d3b",
  "#ff9e6b",
  "#55c899",
  "#7fbbec",
  "#ca8869",
  "#006a66",
  "#6542d2",
  "#e773ce",
  "#696628",
  "#3e89be",
  "#ccb87c",
  "#d83d66",
  "#4d913e",
  "#224451",
  "#e5fda4",
  "#a45b02",
  "#C1F2FD",
  "#4b3a83",
  "#a2aa45",
  "#323925",
  "#00f8b3",
  "#ddb6d0",
  "#61ab1f",
  "#6367a9",
  "#982e0b",
  "#92bea5",
  "#aa62c3",
  "#e7ab63",
  "#8d5700",
  "#b3008b",
  "#3d7397",
  "#e27172",
  "#9c8333",
  "#511f4d",
  "#e451d1",
  "#7d74a9",
  "#3b9700",
  "#cca763",
  "#68d1b6",
  "#d21656",
  "#4c257f",
  "#8cd0ff",
  "#636a01",
  "#e05859",
  "#637b5d",
  "#0089a3",
  "#917100",
  "#a243a7",
  "#4ca43b",
  "#d45262",
  "#c5aab6",
  "#852c19",
  "#00b6c5",
  "#b90076",
  "#eae408",
  "#55813b",
  "#a05837",
  "#ffaa92",
  "#D7FEFB",
  "#874aa6",
  "#00846f",
  "#adff60",
  "#c6005a",
  "#b79762",
  "#d16cda"
];

function districtColor(id: number): string {
  return id === 0 ? UNASSIGNED_COLOR : DISTRICT_COLORS[id % DISTRICT_COLORS.length];
}

// Harness page that the client-side renderer runs in. Must match the
// logic in src/client/thumbnail-render.ts so backfilled images look the
// same as ones generated live by the editor on save.
const HARNESS_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Thumbnail Render Harness</title>
<link href="https://unpkg.com/maplibre-gl@5.21.1/dist/maplibre-gl.css" rel="stylesheet" />
<script src="https://unpkg.com/maplibre-gl@5.21.1/dist/maplibre-gl.js"></script>
<style>
  html, body { margin: 0; padding: 0; background: #fff; }
  #map { width: 1200px; height: 1200px; background: #fff; }
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
  readonly adjacencyData: AdjacencyData;
  readonly bbox: readonly [number, number, number, number];
  readonly staticMetadata: IStaticMetadata;
  // Parallel to staticMetadata.voting — one TypedArray per voting file with
  // per-block counts. Empty when the region has no voting data configured.
  readonly staticVoting: TypedArrays;
}

// Mirror of src/client/s3.ts fetchStaticFiles — pick the right TypedArray
// based on bytesPerElement + unsigned.
async function fetchStaticTypedArrays(
  s3URI: S3URI,
  files: readonly IStaticFile[]
): Promise<TypedArrays> {
  return Promise.all(
    files.map(async file => {
      const buf = await s3GetBytes(s3URI, file.fileName);
      const unsigned = file.unsigned ?? true;
      const bpe = file.bytesPerElement;
      if (unsigned) {
        if (bpe === 1) return new Uint8Array(buf);
        if (bpe === 2) return new Uint16Array(buf);
        return new Uint32Array(buf);
      }
      if (bpe === 1) return new Int8Array(buf);
      if (bpe === 2) return new Int16Array(buf);
      return new Int32Array(buf);
    })
  );
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
  const [geoUnitHierarchy, adjBuf, offsetsBuf, coordsBuf, transform, metadata] = await Promise.all([
    s3GetJson<GeoUnitHierarchy>(s3URI, "geounit-hierarchy.json"),
    s3GetBytes(s3URI, "adjacency.bin"),
    s3GetBytes(s3URI, "arc-offsets.bin"),
    s3GetBytes(s3URI, "arc-coords.bin"),
    s3GetJson<AdjacencyData["transform"]>(s3URI, "transform.json"),
    s3GetJson<IStaticMetadata>(s3URI, "static-metadata.json")
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
  // Load per-block voting binaries if the region has voting data. Enables the
  // partisan breakdown in districtProperties that the OG card description
  // reads — skipping this would mean backfilled projects fall back to the
  // generic "N districts" copy until the user re-saves through the editor.
  const staticVoting = metadata.voting ? await fetchStaticTypedArrays(s3URI, metadata.voting) : [];
  return {
    geoUnitHierarchy,
    numBlocks,
    adjacencyData,
    bbox: metadata.bbox,
    staticMetadata: metadata,
    staticVoting
  };
}

// Build the same DistrictsGeoJSON shape the worker assembles in mergeDistricts.
// Demographics are still skipped (would require fetching the large per-region
// demographics binaries and isn't needed by the home-page card); voting IS
// aggregated so the OG card can report partisan breakdown. When the user
// later opens the project in the editor, the worker recomputes everything
// fresh and overwrites these with full data.
function buildThumbnail(project: Project, region: RegionData): ThumbnailGeoJSON {
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
  // Invert the assignment array into per-district block-index lists so we can
  // sum voting values within each district.
  const districtBlockIndices: number[][] = Array.from(
    { length: project.numberOfDistricts + 1 },
    () => []
  );
  for (let i = 0; i < region.numBlocks; i++) {
    districtBlockIndices[assignment[i]]?.push(i);
  }
  const features: Feature<MultiPolygon, DistrictProperties>[] = boundaries.map((b, i) => ({
    type: "Feature",
    id: i,
    geometry: b.geometry,
    properties: {
      compactness: b.compactness,
      contiguity: b.contiguity,
      demographics: {},
      voting:
        region.staticVoting.length > 0
          ? getVoting(districtBlockIndices[i] ?? [], region.staticMetadata, region.staticVoting)
          : {}
    }
  }));
  const districts: DistrictsGeoJSON = { type: "FeatureCollection", features };
  return simplifyForThumbnail(districts);
}

// Mirrors ProjectDistrictsMap.tsx and src/client/thumbnail-render.ts: index 0
// (unassigned) gets a light gray, everything else cycles the palette.
function withColors(thumbnail: ThumbnailGeoJSON): ThumbnailGeoJSON {
  return {
    ...thumbnail,
    features: thumbnail.features.map((f, id) => ({
      ...f,
      properties: { ...f.properties, color: districtColor(id) }
    }))
  };
}

async function renderPng(
  page: Page,
  thumbnail: ThumbnailGeoJSON,
  bbox: readonly [number, number, number, number]
): Promise<Buffer> {
  const colored = withColors(thumbnail);
  const base64 = await page.evaluate(
    async (districts, bounds) => {
      return await (window as any).renderDistricts(districts, bounds);
    },
    colored as unknown as Record<string, unknown>,
    [...bbox] as [number, number, number, number]
  );
  return Buffer.from(base64, "base64");
}

// Connects to the chromium sidecar container (docker-compose service
// `chromium`, running browserless/chromium). `browserURL` is an http URL
// like `http://chromium:3000`; we convert it to a ws URL and pass as
// browserWSEndpoint because browserless's /json/version returns
// `ws://0.0.0.0:3000` which puppeteer would fail to reach.
async function connectBrowser(browserUrl: string): Promise<Browser> {
  const wsEndpoint = browserUrl.replace(/^http/, "ws");
  return await puppeteer.connect({ browserWSEndpoint: wsEndpoint });
}

// Renders in a fresh page every call so that a crashed target or accumulated
// leaks in one project don't poison every subsequent render.
async function renderPngInFreshPage(
  getBrowser: () => Promise<Browser>,
  thumbnail: ThumbnailGeoJSON,
  bbox: readonly [number, number, number, number]
): Promise<Buffer> {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setViewport({ width: 1200, height: 1200, deviceScaleFactor: 1 });
    await page.setContent(HARNESS_HTML, { waitUntil: "networkidle0" });
    return await renderPng(page, thumbnail, bbox);
  } finally {
    try {
      await page.close();
    } catch {
      // Browser may already be dead — nothing useful to do.
    }
  }
}

export default class BackfillThumbnails extends Command {
  static description =
    "Backfill project thumbnails: writes districtProperties to the database and uploads a rendered PNG to the thumbnails S3 bucket. Uses headless Chrome (Puppeteer) to rasterize the districts exactly the way the editor does on save.";

  static flags = {
    "dry-run": Flags.boolean({
      description: "Print which projects would be updated without writing",
      default: false
    }),
    limit: Flags.integer({
      description: "Maximum number of projects to update",
      required: false
    }),
    "skip-png": Flags.boolean({
      description: "Only backfill districtProperties; skip S3 PNG upload",
      default: false
    }),
    bucket: Flags.string({
      description: "Override the thumbnails S3 bucket name (defaults to $THUMBNAILS_BUCKET)",
      required: false
    }),
    "browser-url": Flags.string({
      description:
        "CDP URL of a headless Chromium to connect to (defaults to $PUPPETEER_BROWSER_URL, then the chromium docker-compose sidecar at http://chromium:3000).",
      required: false
    }),
    force: Flags.boolean({
      description:
        "Re-process all projects, not just those missing districtProperties. Useful after changing what the backfill computes (e.g. adding voting aggregation).",
      default: false
    })
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(BackfillThumbnails);
    const dryRun = flags["dry-run"];
    const skipPng = flags["skip-png"];
    const bucket = flags.bucket || process.env.THUMBNAILS_BUCKET;
    const browserUrl =
      flags["browser-url"] || process.env.PUPPETEER_BROWSER_URL || "http://chromium:3000";
    if (!skipPng && !bucket && !dryRun) {
      this.error(
        "Thumbnails bucket not configured. Set THUMBNAILS_BUCKET or pass --bucket=<name>, or use --skip-png."
      );
    }

    const dataSource = await createDataSource();
    const projectRepo = dataSource.getRepository(Project);

    // Re-render any project that's missing the districtProperties column.
    // With --force we re-process everything, e.g. after adding voting
    // aggregation or changing the rendered PNG output.
    const projects = await projectRepo.find({
      where: flags.force ? {} : [{ districtProperties: IsNull() }],
      relations: ["regionConfig"],
      order: { createdDt: "ASC" },
      take: flags.limit
    });

    this.log(`Found ${projects.length} project(s) needing a thumbnail`);
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

    // Lazily (re)connect the browser. A dropped/crashed sidecar leaves
    // `browser.connected` false; we throw away the handle and reconnect.
    // Hold the handle in a container so TS flow-analysis doesn't narrow
    // `browser` to `null` across the closure boundary.
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

    const runner = async (withPng: boolean) => {
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
            const districtProperties: readonly DistrictProperties[] = thumbnail.features.map(
              f => f.properties
            );
            const pngBuffer = !withPng
              ? null
              : await renderPngInFreshPage(getBrowser, thumbnail, region.bbox);
            if (dryRun) {
              this.log(
                `  ${project.name}: would write ${districtProperties.length} properties${
                  pngBuffer
                    ? ` and upload ${pngBuffer.length}B PNG to s3://${bucket}/${project.id}.png`
                    : " (no PNG)"
                }`
              );
            } else {
              await projectRepo.update(project.id, { districtProperties });
              if (pngBuffer && bucket) {
                await s3.send(
                  new PutObjectCommand({
                    Bucket: bucket,
                    Key: `${project.id}.png`,
                    Body: pngBuffer,
                    ContentType: "image/png",
                    CacheControl: "public, max-age=3600"
                  })
                );
              }
              this.log(
                `  ${project.name}: updated${pngBuffer ? ` (${pngBuffer.length}B PNG uploaded)` : ""}`
              );
            }
            updated++;
          } catch (e) {
            this.log(`  ${project.name}: ERROR — ${e}`);
            failed++;
          }
        }
      }
    };

    try {
      await runner(!skipPng);
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
    this.log(`${dryRun ? "Would update" : "Updated"}: ${updated}, Failed: ${failed}`);

    await dataSource.destroy();
    this.exit(0);
  }
}
