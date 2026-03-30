#!/usr/bin/env npx ts-node
/**
 * Analyze split blocks in processed GeoJSON data.
 * Identifies blocks that were split across multiple precincts during spatial join
 * and outputs centroid locations for visual inspection.
 *
 * Usage:
 *   npx ts-node scripts/bulk-vest/analyze-splits.ts --state DE [--input dev-data/staging/DE.geojson]
 *   npx ts-node scripts/bulk-vest/analyze-splits.ts --all
 *
 * Output:
 *   scripts/bulk-vest/split-blocks/{STATE}.json — centroid locations for visual-inspect.ts --check-splits
 *   Prints summary statistics to stdout
 */
import { createReadStream, mkdirSync, writeFileSync, existsSync, readFileSync } from "fs";
import { createInterface } from "readline";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { parse } from "csv-parse/sync";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const OUTPUT_DIR = join(__dirname, "split-blocks");
const CSV_FILE = join(__dirname, "states.csv");

interface SplitInfo {
  baseId: string;
  subBlocks: Array<{
    blockId: string;
    precinct: string;
    centroid: [number, number]; // [lng, lat]
    area: number;
  }>;
}

function parseArgs(): { states: string[]; inputOverride?: string } {
  const args = process.argv.slice(2);
  const states: string[] = [];
  let inputOverride: string | undefined;
  let all = false;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--state":
        states.push(args[++i].toUpperCase());
        break;
      case "--input":
        inputOverride = args[++i];
        break;
      case "--all":
        all = true;
        break;
    }
  }

  if (all) {
    const csv = readFileSync(CSV_FILE, "utf-8");
    const records = parse(csv, { columns: true });
    for (const row of records) {
      if (row.status === "published") {
        states.push(row.state_abbr);
      }
    }
  }

  if (states.length === 0) {
    console.error("Usage: analyze-splits.ts --state XX [--input path] | --all");
    process.exit(1);
  }

  return { states, inputOverride };
}

function computeCentroid(geometry: any): [number, number] {
  // Simple centroid for polygon: average of exterior ring coordinates
  let coords: number[][] = [];
  if (geometry.type === "Polygon") {
    coords = geometry.coordinates[0];
  } else if (geometry.type === "MultiPolygon") {
    // Use the largest polygon's ring
    let maxLen = 0;
    for (const poly of geometry.coordinates) {
      if (poly[0].length > maxLen) {
        maxLen = poly[0].length;
        coords = poly[0];
      }
    }
  }

  if (coords.length === 0) return [0, 0];

  let sumLng = 0, sumLat = 0;
  // Exclude last point (same as first in closed ring)
  const n = coords.length - 1 || coords.length;
  for (let i = 0; i < n; i++) {
    sumLng += coords[i][0];
    sumLat += coords[i][1];
  }
  return [sumLng / n, sumLat / n];
}

function computeArea(geometry: any): number {
  // Simple spherical area approximation using the shoelace formula on the exterior ring
  let coords: number[][] = [];
  if (geometry.type === "Polygon") {
    coords = geometry.coordinates[0];
  } else if (geometry.type === "MultiPolygon") {
    // Sum all polygon areas
    let total = 0;
    for (const poly of geometry.coordinates) {
      total += shoelace(poly[0]);
    }
    return Math.abs(total);
  }
  return Math.abs(shoelace(coords));
}

function shoelace(coords: number[][]): number {
  let area = 0;
  const n = coords.length;
  for (let i = 0; i < n - 1; i++) {
    area += coords[i][0] * coords[i + 1][1];
    area -= coords[i + 1][0] * coords[i][1];
  }
  return area / 2;
}

async function analyzeState(state: string, inputPath: string) {
  console.log(`\nAnalyzing split blocks for ${state}...`);
  console.log(`  Input: ${inputPath}`);

  if (!existsSync(inputPath)) {
    console.error(`  File not found: ${inputPath}`);
    return;
  }

  // Read GeoJSON line by line (GeoJSON sequence format or regular GeoJSON)
  const splitMap = new Map<string, SplitInfo>();
  let totalFeatures = 0;

  const content = readFileSync(inputPath, "utf-8");
  let features: any[];

  // Try parsing as regular GeoJSON first
  try {
    const geojson = JSON.parse(content);
    features = geojson.features || [geojson];
  } catch {
    // Try as newline-delimited GeoJSON
    features = content
      .split("\n")
      .filter(line => line.trim())
      .map(line => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .filter(Boolean);
  }

  for (const feature of features) {
    if (!feature || !feature.properties) continue;
    totalFeatures++;

    const blockId: string = feature.properties.block || "";
    // Split blocks have a suffix like -1, -2, -3
    const match = blockId.match(/^(.+)-(\d+)$/);
    if (!match) continue;

    const baseId = match[1];
    if (!splitMap.has(baseId)) {
      splitMap.set(baseId, { baseId, subBlocks: [] });
    }

    splitMap.get(baseId)!.subBlocks.push({
      blockId,
      precinct: feature.properties.precinct || "",
      centroid: computeCentroid(feature.geometry),
      area: computeArea(feature.geometry)
    });
  }

  // Generate statistics
  const splitCount = splitMap.size;
  const totalSubBlocks = Array.from(splitMap.values()).reduce((s, info) => s + info.subBlocks.length, 0);

  // Distribution of split counts
  const distrib = new Map<number, number>();
  for (const info of splitMap.values()) {
    const n = info.subBlocks.length;
    distrib.set(n, (distrib.get(n) || 0) + 1);
  }

  // Find slivers (sub-blocks with very small area relative to siblings)
  let sliverCount = 0;
  for (const info of splitMap.values()) {
    const maxArea = Math.max(...info.subBlocks.map(sb => sb.area));
    for (const sb of info.subBlocks) {
      if (maxArea > 0 && sb.area / maxArea < 0.01) {
        sliverCount++;
      }
    }
  }

  console.log(`  Total features: ${totalFeatures}`);
  console.log(`  Split blocks: ${splitCount} (${totalSubBlocks} sub-blocks)`);
  console.log(`  Split distribution:`);
  for (const [n, count] of Array.from(distrib.entries()).sort((a, b) => a[0] - b[0])) {
    console.log(`    ${n}-way: ${count}`);
  }
  console.log(`  Potential slivers (<1% of sibling area): ${sliverCount}`);

  // Output centroids for visual inspection (one per split base block)
  mkdirSync(OUTPUT_DIR, { recursive: true });
  const centroids = Array.from(splitMap.values()).map(info => {
    // Use the centroid of the first sub-block
    const first = info.subBlocks[0];
    return {
      blockId: info.baseId,
      lng: first.centroid[0],
      lat: first.centroid[1],
      subBlockCount: info.subBlocks.length,
      minAreaRatio: info.subBlocks.length > 1
        ? Math.min(...info.subBlocks.map(sb => sb.area)) / Math.max(...info.subBlocks.map(sb => sb.area))
        : 1
    };
  });

  const outputPath = join(OUTPUT_DIR, `${state}.json`);
  writeFileSync(outputPath, JSON.stringify(centroids, null, 2));
  console.log(`  Centroids written: ${outputPath} (${centroids.length} locations)`);

  return { state, splitCount, totalSubBlocks, sliverCount, totalFeatures };
}

async function main() {
  const { states, inputOverride } = parseArgs();

  const results: Array<{ state: string; splitCount: number; totalSubBlocks: number; sliverCount: number; totalFeatures: number }> = [];

  for (const state of states) {
    const inputPath = inputOverride || join(__dirname, "..", "..", "dev-data", "staging", `${state}.geojson`);
    const result = await analyzeState(state, inputPath);
    if (result) results.push(result);
  }

  if (results.length > 1) {
    console.log("\n=== SUMMARY ===");
    console.log("State | Features | Split Blocks | Sub-blocks | Slivers");
    console.log("------|----------|-------------|------------|--------");
    for (const r of results.sort((a, b) => b.splitCount - a.splitCount)) {
      console.log(`${r.state.padEnd(5)} | ${String(r.totalFeatures).padStart(8)} | ${String(r.splitCount).padStart(11)} | ${String(r.totalSubBlocks).padStart(10)} | ${String(r.sliverCount).padStart(7)}`);
    }
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
