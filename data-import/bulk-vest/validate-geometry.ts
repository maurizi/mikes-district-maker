// SPDX-License-Identifier: AGPL-3.0-or-later
// © 2026 Michael Maurizi Jr.

/**
 * Geometry validation script for detecting issues in processed state data.
 *
 * Checks both input.geojson (post-noding) and topo.json (post-topojson) for:
 * 1. Degenerate fragments (tiny area polygons)
 * 2. Spike/sliver artifacts (high perimeter:area ratio or far-flung vertices)
 * 3. Chaotic geometry (excessive vertex counts)
 * 4. Gaps (unshared arcs in topology)
 * 5. Overlaps (arcs referenced by >2 blocks)
 *
 * Usage: npx tsx validate-geometry.ts <STATE|all> [--verbose]
 */

import { createReadStream, readFileSync, existsSync, readdirSync } from "fs";
import { createInterface } from "readline";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { merge as topoMerge } from "topojson-client";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const OUTPUT_DIR = join(__dirname, "../../dev-data/output");

// ── Geometry helpers ──

/** Shoelace area for a coordinate ring (returns signed area in deg²) */
function ringAreaDeg2(ring: number[][]): number {
  let area = 0;
  const n = ring.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    area += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  }
  return area / 2;
}

/** Approximate area in m² using equirectangular projection */
function ringAreaM2(ring: number[][]): number {
  const toRad = Math.PI / 180;
  // Find center latitude for cos correction
  let sumLat = 0;
  for (const [, lat] of ring) sumLat += lat;
  const avgLat = sumLat / ring.length;
  const cosLat = Math.cos(avgLat * toRad);

  let area = 0;
  const n = ring.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const x1 = ring[j][0] * cosLat;
    const y1 = ring[j][1];
    const x2 = ring[i][0] * cosLat;
    const y2 = ring[i][1];
    area += x1 * y2 - x2 * y1;
  }
  // Convert from deg² to m² (111319 m/deg)
  return Math.abs(area / 2) * 111319 * 111319;
}

/** Ring perimeter in meters (Haversine) */
function ringPerimeterM(ring: number[][]): number {
  const toRad = Math.PI / 180;
  const R = 6371008.8;
  let perimeter = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const [lng1, lat1] = ring[i];
    const [lng2, lat2] = ring[i + 1];
    const dLat = (lat2 - lat1) * toRad;
    const dLng = (lng2 - lng1) * toRad;
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLng / 2) ** 2;
    perimeter += 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }
  return perimeter;
}

/** Count total vertices in a GeoJSON geometry */
function countVertices(geom: any): number {
  if (!geom || !geom.coordinates) return 0;
  if (geom.type === "Polygon") {
    return geom.coordinates.reduce((s: number, ring: number[][]) => s + ring.length, 0);
  }
  if (geom.type === "MultiPolygon") {
    return geom.coordinates.reduce(
      (s: number, poly: number[][][]) =>
        s + poly.reduce((s2: number, ring: number[][]) => s2 + ring.length, 0),
      0
    );
  }
  return 0;
}

/** Compute bounding box [minX, minY, maxX, maxY] for a ring */
function ringBbox(ring: number[][]): [number, number, number, number] {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const [x, y] of ring) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return [minX, minY, maxX, maxY];
}

/** Check if a ring has spike-like characteristics:
 *  - Very high perimeter:area ratio (thin sliver)
 *  - Or a vertex that's far from the ring's bbox (indicating a spike) */
function detectSpike(ring: number[][]): {
  isSpike: boolean;
  perimAreaRatio?: number;
  maxDeviation?: number;
} {
  if (ring.length < 4) return { isSpike: false };

  const area = Math.abs(ringAreaM2(ring));
  if (area < 1) return { isSpike: false }; // too small to evaluate

  const perim = ringPerimeterM(ring);
  // Polsby-Popper: 4*pi*area / perim^2. For a circle = 1. Spikes << 0.01
  const pp = (4 * Math.PI * area) / (perim * perim);

  // A very elongated shape (PP < 0.001) with meaningful area is a spike
  if (pp < 0.001 && area > 100) {
    return { isSpike: true, perimAreaRatio: perim / Math.sqrt(area) };
  }

  // Also check for vertex far from bbox centroid relative to bbox size
  const [minX, minY, maxX, maxY] = ringBbox(ring);
  const bboxDiag = Math.sqrt((maxX - minX) ** 2 + (maxY - minY) ** 2);
  // If bbox diagonal > 0.1 degrees (~11km) and area is small relative to bbox
  const bboxAreaDeg2 = (maxX - minX) * (maxY - minY);
  if (bboxDiag > 0.05 && bboxAreaDeg2 > 0 && Math.abs(ringAreaDeg2(ring)) / bboxAreaDeg2 < 0.01) {
    return { isSpike: true, maxDeviation: bboxDiag };
  }

  return { isSpike: false };
}

/** Get all rings from a geometry */
function* getRings(geom: any): Generator<number[][]> {
  if (!geom || !geom.coordinates) return;
  if (geom.type === "Polygon") {
    for (const ring of geom.coordinates) yield ring;
  } else if (geom.type === "MultiPolygon") {
    for (const poly of geom.coordinates) {
      for (const ring of poly) yield ring;
    }
  }
}

// ── Issue collectors ──

interface Issue {
  featureIndex: number;
  featureId?: string;
  type: string;
  detail: string;
  lng?: number;
  lat?: number;
}

// ── input.geojson validation (streaming) ──

async function validateInputGeoJSON(
  state: string,
  verbose: boolean
): Promise<{ issues: Issue[]; featureCount: number }> {
  const filePath = join(OUTPUT_DIR, state, "input.geojson");
  if (!existsSync(filePath)) return { issues: [], featureCount: 0 };

  const issues: Issue[] = [];
  let featureIndex = 0;

  const rl = createInterface({
    input: createReadStream(filePath, { encoding: "utf8" }),
    crlfDelay: Infinity
  });

  for await (const rawLine of rl) {
    const line = rawLine.trim();
    // Skip FeatureCollection wrapper lines
    if (line.startsWith('{"type":"FeatureCollection"') || line === "]}") continue;

    // Strip trailing comma
    const json = line.endsWith(",") ? line.slice(0, -1) : line;
    let feature: any;
    try {
      feature = JSON.parse(json);
    } catch {
      continue;
    }

    if (feature.type !== "Feature" || !feature.geometry) {
      featureIndex++;
      continue;
    }

    const geom = feature.geometry;
    const geoId = feature.properties?.block || feature.properties?.GEOID20 || `#${featureIndex}`;

    // Test 1: Degenerate fragments (tiny area)
    let totalArea = 0;
    for (const ring of getRings(geom)) {
      totalArea += Math.abs(ringAreaM2(ring));
    }
    if (totalArea < 10) {
      // < 10 m² — likely a degenerate fragment
      const firstRing = [...getRings(geom)][0];
      const [cx, cy] = firstRing ? [firstRing[0][0], firstRing[0][1]] : [0, 0];
      issues.push({
        featureIndex,
        featureId: geoId,
        type: "degenerate-fragment",
        detail: `area=${totalArea.toFixed(2)}m²`,
        lng: cx,
        lat: cy
      });
    }

    // Test 2: Spike detection
    for (const ring of getRings(geom)) {
      const spike = detectSpike(ring);
      if (spike.isSpike) {
        const [minX, minY, maxX, maxY] = ringBbox(ring);
        issues.push({
          featureIndex,
          featureId: geoId,
          type: "spike",
          detail: spike.perimAreaRatio
            ? `perim/sqrt(area)=${spike.perimAreaRatio.toFixed(1)}`
            : `bboxDiag=${spike.maxDeviation?.toFixed(4)}°`,
          lng: (minX + maxX) / 2,
          lat: (minY + maxY) / 2
        });
      }
    }

    // Test 3: Chaotic geometry (excessive vertices)
    const verts = countVertices(geom);
    if (verts > 5000) {
      const [firstRing] = [...getRings(geom)];
      const [cx, cy] = firstRing ? [firstRing[0][0], firstRing[0][1]] : [0, 0];
      issues.push({
        featureIndex,
        featureId: geoId,
        type: "excessive-vertices",
        detail: `vertices=${verts}`,
        lng: cx,
        lat: cy
      });
    }

    featureIndex++;
    if (verbose && featureIndex % 50000 === 0) {
      process.stderr.write(`  input.geojson: ${featureIndex} features...\n`);
    }
  }

  return { issues, featureCount: featureIndex };
}

// ── topo.json validation ──

async function validateTopoJSON(
  state: string,
  verbose: boolean
): Promise<{ issues: Issue[]; arcCount: number; blockCount: number }> {
  const filePath = join(OUTPUT_DIR, state, "topo.json");
  if (!existsSync(filePath)) return { issues: [], arcCount: 0, blockCount: 0 };

  // Load topo.json — may be large, use streaming read
  if (verbose) process.stderr.write(`  Loading topo.json...\n`);
  let topoStr: string;
  try {
    topoStr = readFileSync(filePath, "utf8");
  } catch {
    // File too large for string — skip topo validation
    process.stderr.write(`  WARNING: topo.json too large to load for ${state}, skipping\n`);
    return { issues: [], arcCount: 0, blockCount: 0 };
  }
  const topo = JSON.parse(topoStr);
  topoStr = ""; // free memory

  const issues: Issue[] = [];
  const numArcs = topo.arcs.length;
  const blockLevel = Object.keys(topo.objects)[0]; // first object is blocks
  const geometries = (topo.objects[blockLevel] as any).geometries;
  const numBlocks = geometries.length;

  // Test 4: Gap detection — check arc reference counts
  // Each arc should be referenced by exactly 2 blocks (shared edge) or 1 block (exterior)
  // An arc referenced by 1 block that's NOT on the exterior suggests a gap
  const arcRefCount = new Int32Array(numArcs);
  const arcBlocks: number[][] = new Array(numArcs);
  for (let i = 0; i < numArcs; i++) arcBlocks[i] = [];

  for (let bi = 0; bi < numBlocks; bi++) {
    const geom = geometries[bi];
    for (const arcIdx of walkTopoArcs(geom)) {
      const canonical = arcIdx >= 0 ? arcIdx : ~arcIdx;
      arcRefCount[canonical]++;
      if (arcBlocks[canonical].length < 3) {
        arcBlocks[canonical].push(bi);
      }
    }
  }

  // Count single-reference arcs (potential gaps)
  let singleRefArcs = 0;
  let overRefArcs = 0;
  // We can't easily distinguish exterior arcs from gap arcs without the actual
  // state boundary, but we can count them and compare across states
  for (let i = 0; i < numArcs; i++) {
    if (arcRefCount[i] === 1) singleRefArcs++;
    if (arcRefCount[i] > 2) {
      overRefArcs++;
      // Test 5: Overlap detection — arc referenced by >2 blocks
      const arcCoords = decodeTopoArc(topo, i);
      const mid = arcCoords[Math.floor(arcCoords.length / 2)];
      issues.push({
        featureIndex: i,
        type: "overlap-arc",
        detail: `arc ${i} referenced by ${arcRefCount[i]} blocks: [${arcBlocks[i].join(",")}]`,
        lng: mid?.[0],
        lat: mid?.[1]
      });
    }
  }

  // Report single-ref arc ratio as a gap indicator
  // Exterior boundary arcs are expected to be single-ref, but an unusually high
  // ratio compared to total arcs may indicate internal gaps
  const singleRefRatio = singleRefArcs / numArcs;
  if (verbose) {
    process.stderr.write(
      `  topo.json: ${numArcs} arcs, ${singleRefArcs} single-ref (${(singleRefRatio * 100).toFixed(1)}%), ${overRefArcs} over-ref\n`
    );
  }

  // Also check for degenerate blocks in topo.json (tiny area after dequantization)
  const transform = topo.transform;
  if (transform) {
    let tinyBlocks = 0;
    for (let bi = 0; bi < numBlocks; bi++) {
      const geom = geometries[bi];
      const coords = decodeTopoGeometry(topo, geom);
      let totalArea = 0;
      for (const ring of iterCoordRings(coords, geom.type)) {
        totalArea += Math.abs(ringAreaM2(ring));
      }
      if (totalArea < 10) {
        tinyBlocks++;
        const geoId = geom.properties?.[blockLevel] || `#${bi}`;
        const firstCoord = getFirstCoord(coords, geom.type);
        issues.push({
          featureIndex: bi,
          featureId: geoId,
          type: "topo-degenerate",
          detail: `area=${totalArea.toFixed(2)}m²`,
          lng: firstCoord?.[0],
          lat: firstCoord?.[1]
        });
      }
    }
  }

  // Test: merge ALL blocks using topojson-client's merge() and check for:
  // 1. Spikes in the merged boundary (topology issue vs stitcher bug)
  // 2. Interior holes = gaps between blocks (Category 4 gap detection)
  if (verbose) process.stderr.write(`  topo-merge: merging all blocks with topojson-client...\n`);
  try {
    const merged = topoMerge(topo, geometries) as any;
    let topoMergeSpikes = 0;
    let topoMergeRings = 0;
    let totalHoles = 0;
    let gapHoles = 0; // holes < 1km² — likely gaps, not water
    let smallGapHoles = 0; // holes < 100m² — definitely gaps
    if (merged && merged.coordinates) {
      for (const poly of merged.coordinates) {
        for (let ri = 0; ri < poly.length; ri++) {
          const ring = poly[ri];
          topoMergeRings++;

          // Spike detection on all rings
          const spike = detectSpike(ring);
          if (spike.isSpike) {
            topoMergeSpikes++;
            const [minX, minY, maxX, maxY] = ringBbox(ring);
            issues.push({
              featureIndex: -1,
              type: "topo-merge-spike",
              detail: spike.perimAreaRatio
                ? `topojson merge ring: perim/sqrt(area)=${spike.perimAreaRatio.toFixed(1)}, ${ring.length} pts`
                : `topojson merge ring: bboxDiag=${spike.maxDeviation?.toFixed(4)}°, ${ring.length} pts`,
              lng: (minX + maxX) / 2,
              lat: (minY + maxY) / 2
            });
          }

          // Gap detection: interior rings (ri > 0) are holes in the merged polygon
          if (ri > 0) {
            totalHoles++;
            const holeArea = ringAreaM2(ring);
            const [minX, minY, maxX, maxY] = ringBbox(ring);

            if (holeArea < 1_000_000) {
              // < 1 km² — likely a gap, not a legitimate water body
              gapHoles++;
              if (holeArea < 100) smallGapHoles++;
              issues.push({
                featureIndex: -1,
                type: holeArea < 100 ? "gap-tiny" : "gap-small",
                detail: `hole area=${holeArea < 1000 ? holeArea.toFixed(1) + "m²" : (holeArea / 1_000_000).toFixed(4) + "km²"}, ${ring.length} pts`,
                lng: (minX + maxX) / 2,
                lat: (minY + maxY) / 2
              });
            } else {
              // Large hole — could be water body or legitimate exclusion
              // Still report in verbose mode for completeness
              issues.push({
                featureIndex: -1,
                type: "hole-large",
                detail: `hole area=${(holeArea / 1_000_000).toFixed(2)}km², ${ring.length} pts`,
                lng: (minX + maxX) / 2,
                lat: (minY + maxY) / 2
              });
            }
          }
        }
      }
    }
    if (verbose) {
      process.stderr.write(
        `  topo-merge: ${topoMergeRings} rings, ${topoMergeSpikes} spikes, ` +
          `${totalHoles} holes (${gapHoles} likely gaps, ${smallGapHoles} tiny)\n`
      );
    }
  } catch (e: any) {
    if (verbose) process.stderr.write(`  topo-merge: FAILED: ${e.message}\n`);
  }

  return { issues, arcCount: numArcs, blockCount: numBlocks };
}

// ── TopoJSON helpers ──

function* walkTopoArcs(geom: any): Generator<number> {
  if (geom.type === "Polygon") {
    for (const ring of geom.arcs) for (const a of ring) yield a;
  } else if (geom.type === "MultiPolygon") {
    for (const poly of geom.arcs) for (const ring of poly) for (const a of ring) yield a;
  }
}

function decodeTopoArc(topo: any, arcIdx: number): number[][] {
  const arc = topo.arcs[arcIdx];
  const t = topo.transform;
  if (!t) return arc;
  const points: number[][] = [];
  let x = 0,
    y = 0;
  for (const [dx, dy] of arc) {
    x += dx;
    y += dy;
    points.push([x * t.scale[0] + t.translate[0], y * t.scale[1] + t.translate[1]]);
  }
  return points;
}

function decodeTopoGeometry(topo: any, geom: any): number[][][] | number[][][][] {
  // Decode arc references into coordinate arrays
  if (geom.type === "Polygon") {
    return geom.arcs.map((ring: number[]) => decodeTopoRing(topo, ring));
  }
  if (geom.type === "MultiPolygon") {
    return geom.arcs.map((poly: number[][]) =>
      poly.map((ring: number[]) => decodeTopoRing(topo, ring))
    );
  }
  return [];
}

function decodeTopoRing(topo: any, arcRefs: number[]): number[][] {
  const coords: number[][] = [];
  for (const ref of arcRefs) {
    const arcIdx = ref >= 0 ? ref : ~ref;
    let points = decodeTopoArc(topo, arcIdx);
    if (ref < 0) points = [...points].reverse();
    // Skip last point of each arc (shared with next arc's start), except for last arc
    for (let i = 0; i < points.length - 1; i++) {
      coords.push(points[i]);
    }
  }
  // Close ring
  if (coords.length > 0) coords.push(coords[0]);
  return coords;
}

function* iterCoordRings(
  coords: number[][][] | number[][][][],
  type: string
): Generator<number[][]> {
  if (type === "Polygon") {
    for (const ring of coords as number[][][]) yield ring;
  } else if (type === "MultiPolygon") {
    for (const poly of coords as number[][][][]) {
      for (const ring of poly) yield ring;
    }
  }
}

function getFirstCoord(coords: number[][][] | number[][][][], type: string): number[] | undefined {
  if (type === "Polygon") return (coords as number[][][])[0]?.[0];
  if (type === "MultiPolygon") return (coords as number[][][][])[0]?.[0]?.[0];
  return undefined;
}

// ── Boundary stitching validation ──
// Runs the actual boundary computation (same algorithm as the client) and checks
// the resulting district polygons for spike-like rings.

function buildReverseIndex(adjacency: Int32Array, numBlocks: number) {
  const numArcs = adjacency.length / 2;
  const counts = new Uint32Array(numBlocks);
  for (let i = 0; i < numArcs; i++) {
    const fwd = adjacency[i * 2];
    const rev = adjacency[i * 2 + 1];
    if (fwd >= 0) counts[fwd]++;
    if (rev >= 0) counts[rev]++;
  }
  const offsets = new Uint32Array(numBlocks + 1);
  for (let i = 0; i < numBlocks; i++) offsets[i + 1] = offsets[i] + counts[i];
  const arcIds = new Int32Array(offsets[numBlocks]);
  const pos = new Uint32Array(numBlocks);
  for (let i = 0; i < numArcs; i++) {
    const fwd = adjacency[i * 2];
    const rev = adjacency[i * 2 + 1];
    if (fwd >= 0) arcIds[offsets[fwd] + pos[fwd]++] = i;
    if (rev >= 0) arcIds[offsets[rev] + pos[rev]++] = ~i;
  }
  return { offsets, arcIds };
}

function findBoundaryArcs(
  blockSet: Set<number>,
  adjacency: Int32Array,
  reverseIndex: { offsets: Uint32Array; arcIds: Int32Array }
): number[] {
  const arcs: number[] = [];
  const seen = new Set<number>();
  for (const blockId of blockSet) {
    const start = reverseIndex.offsets[blockId];
    const end = reverseIndex.offsets[blockId + 1];
    for (let j = start; j < end; j++) {
      const signedArc = reverseIndex.arcIds[j];
      const arcId = signedArc >= 0 ? signedArc : ~signedArc;
      if (seen.has(arcId)) continue;
      seen.add(arcId);
      const fwdBlock = adjacency[arcId * 2];
      const revBlock = adjacency[arcId * 2 + 1];
      const fwdIn = fwdBlock >= 0 && blockSet.has(fwdBlock);
      const revIn = revBlock >= 0 && blockSet.has(revBlock);
      if (fwdIn && !revIn) arcs.push(arcId);
      else if (revIn && !fwdIn) arcs.push(~arcId);
    }
  }
  return arcs;
}

function buildArcEndpoints(arcCoords: Buffer, arcOffsets: Uint32Array, transform: any) {
  const isQuantized = transform !== null;
  const bytesPerPoint = isQuantized ? 8 : 16;
  const view = new DataView(arcCoords.buffer, arcCoords.byteOffset);

  function getStart(arcId: number): [number, number] {
    const offset = arcOffsets[arcId];
    if (isQuantized) return [view.getInt32(offset, true), view.getInt32(offset + 4, true)];
    return [view.getFloat64(offset, true), view.getFloat64(offset + 8, true)];
  }

  function getEnd(arcId: number): [number, number] {
    const startOffset = arcOffsets[arcId];
    const endOffset = arcOffsets[arcId + 1];
    const numPoints = (endOffset - startOffset) / bytesPerPoint;
    if (isQuantized) {
      let x = 0,
        y = 0;
      for (let i = 0; i < numPoints; i++) {
        const off = startOffset + i * 8;
        x += view.getInt32(off, true);
        y += view.getInt32(off + 4, true);
      }
      return [x, y];
    }
    const lastOffset = endOffset - bytesPerPoint;
    return [view.getFloat64(lastOffset, true), view.getFloat64(lastOffset + 8, true)];
  }

  return {
    start(signedArcId: number): string {
      const [p0, p1] = signedArcId >= 0 ? getStart(signedArcId) : getEnd(~signedArcId);
      return `${p0},${p1}`;
    },
    end(signedArcId: number): string {
      const [p0, p1] = signedArcId >= 0 ? getEnd(signedArcId) : getStart(~signedArcId);
      return `${p0},${p1}`;
    }
  };
}

function stitchArcsForTest(
  arcs: number[],
  endpoints: ReturnType<typeof buildArcEndpoints>,
  arcCoords: Buffer,
  arcOffsets: Uint32Array,
  transform: any
): number[][] {
  const isQuantized = transform !== null;
  const bytesPerPoint = isQuantized ? 8 : 16;
  const view = new DataView(arcCoords.buffer, arcCoords.byteOffset);

  // Move empty arcs to front (same as boundary.ts)
  let emptyIndex = -1;
  arcs.forEach((signedI, j) => {
    const i = signedI >= 0 ? signedI : ~signedI;
    const start = arcOffsets[i];
    const end = arcOffsets[i + 1];
    const numPoints = (end - start) / bytesPerPoint;
    if (numPoints < 3 && isQuantized) {
      const dx = view.getInt32(start + 8, true);
      const dy = view.getInt32(start + 12, true);
      if (!dx && !dy) {
        const t = arcs[++emptyIndex];
        arcs[emptyIndex] = signedI;
        arcs[j] = t;
      }
    }
  });

  const stitchedArcs: Record<number, number> = {};
  const fragmentByStart: Record<string, any> = {};
  const fragmentByEnd: Record<string, any> = {};
  const fragments: number[][] = [];

  arcs.forEach(i => {
    const start = endpoints.start(i);
    const end = endpoints.end(i);
    let f = fragmentByEnd[start];
    if (f) {
      delete fragmentByEnd[f.end];
      f.push(i);
      f.end = end;
      const g = fragmentByStart[end];
      if (g) {
        delete fragmentByStart[g.start];
        const fg = g === f ? f : f.concat(g);
        fg.start = f.start;
        fg.end = g.end;
        fragmentByStart[fg.start] = fragmentByEnd[fg.end] = fg;
      } else {
        fragmentByStart[f.start] = fragmentByEnd[f.end] = f;
      }
    } else {
      f = fragmentByStart[end];
      if (f) {
        delete fragmentByStart[f.start];
        f.unshift(i);
        f.start = start;
        const g = fragmentByEnd[start];
        if (g) {
          delete fragmentByEnd[g.end];
          const gf = g === f ? f : g.concat(f);
          gf.start = g.start;
          gf.end = f.end;
          fragmentByStart[gf.start] = fragmentByEnd[gf.end] = gf;
        } else {
          fragmentByStart[f.start] = fragmentByEnd[f.end] = f;
        }
      } else {
        f = [i] as any;
        f.start = start;
        f.end = end;
        fragmentByStart[start] = fragmentByEnd[end] = f;
      }
    }
  });

  function flush(byEnd: Record<string, any>, byStart: Record<string, any>) {
    for (const k in byEnd) {
      const f = byEnd[k];
      delete byStart[f.start];
      delete f.start;
      delete f.end;
      f.forEach((i: number) => {
        stitchedArcs[i < 0 ? ~i : i] = 1;
      });
      fragments.push(f);
    }
  }
  flush(fragmentByEnd, fragmentByStart);
  flush(fragmentByStart, fragmentByEnd);
  arcs.forEach(i => {
    if (!stitchedArcs[i < 0 ? ~i : i]) fragments.push([i]);
  });
  return fragments;
}

function decodeRingFromBinary(
  arcIndices: number[],
  arcCoords: Buffer,
  arcOffsets: Uint32Array,
  transform: any
): number[][] {
  const isQuantized = transform !== null;
  const bytesPerPoint = isQuantized ? 8 : 16;
  const view = new DataView(arcCoords.buffer, arcCoords.byteOffset);
  const ring: number[][] = [];

  for (const signedArc of arcIndices) {
    const arcId = signedArc >= 0 ? signedArc : ~signedArc;
    const forward = signedArc >= 0;
    const start = arcOffsets[arcId];
    const end = arcOffsets[arcId + 1];
    const numPoints = (end - start) / bytesPerPoint;
    const points: number[][] = [];
    if (isQuantized) {
      let x = 0,
        y = 0;
      for (let i = 0; i < numPoints; i++) {
        const off = start + i * 8;
        x += view.getInt32(off, true);
        y += view.getInt32(off + 4, true);
        points.push([
          x * transform.scale[0] + transform.translate[0],
          y * transform.scale[1] + transform.translate[1]
        ]);
      }
    } else {
      for (let i = 0; i < numPoints; i++) {
        const off = start + i * 16;
        points.push([view.getFloat64(off, true), view.getFloat64(off + 8, true)]);
      }
    }
    if (!forward) points.reverse();
    for (let i = 0; i < points.length - 1; i++) ring.push(points[i]);
  }
  if (ring.length > 0) ring.push(ring[0]);
  return ring;
}

async function validateBoundaryStitching(
  state: string,
  verbose: boolean
): Promise<{ issues: Issue[] }> {
  const dir = join(OUTPUT_DIR, state);
  const adjPath = join(dir, "adjacency.bin");
  const coordsPath = join(dir, "arc-coords.bin");
  const offsetsPath = join(dir, "arc-offsets.bin");
  const transformPath = join(dir, "transform.json");
  const blockIdsPath = join(dir, "block-ids.json");

  if (!existsSync(adjPath)) return { issues: [] };

  const adjacency = new Int32Array(readFileSync(adjPath).buffer);
  const arcCoordsBuf = readFileSync(coordsPath);
  const arcOffsets = new Uint32Array(readFileSync(offsetsPath).buffer);
  const transform = JSON.parse(readFileSync(transformPath, "utf8"));

  const numArcs = adjacency.length / 2;
  // Count blocks from adjacency data
  let numBlocks = 0;
  for (let i = 0; i < numArcs * 2; i++) {
    if (adjacency[i] >= numBlocks) numBlocks = adjacency[i] + 1;
  }

  const issues: Issue[] = [];
  const reverseIndex = buildReverseIndex(adjacency, numBlocks);
  const endpoints = buildArcEndpoints(arcCoordsBuf, arcOffsets, transform);

  // Test: assign ALL blocks to district 1, compute boundary, check for spikes
  // This tests the exterior boundary of the entire state
  if (verbose)
    process.stderr.write(`  boundary: computing full-state boundary (${numBlocks} blocks)...\n`);

  const allBlocks = new Set<number>();
  for (let i = 0; i < numBlocks; i++) allBlocks.add(i);
  const boundaryArcs = findBoundaryArcs(allBlocks, adjacency, reverseIndex);

  if (verbose)
    process.stderr.write(`  boundary: ${boundaryArcs.length} boundary arcs, stitching...\n`);

  const rings = stitchArcsForTest(
    [...boundaryArcs],
    endpoints,
    arcCoordsBuf,
    arcOffsets,
    transform
  );

  if (verbose) process.stderr.write(`  boundary: ${rings.length} rings produced\n`);

  // Decode and check each ring for spikes
  let boundarySpikes = 0;
  let unclosedRings = 0;
  let totalVertices = 0;
  for (let ri = 0; ri < rings.length; ri++) {
    const ring = decodeRingFromBinary(rings[ri], arcCoordsBuf, arcOffsets, transform);
    totalVertices += ring.length;

    // Check if ring is closed
    if (ring.length > 0) {
      const first = ring[0];
      const last = ring[ring.length - 1];
      if (Math.abs(first[0] - last[0]) > 0.0001 || Math.abs(first[1] - last[1]) > 0.0001) {
        unclosedRings++;
      }
    }

    // Check for spikes in the stitched ring
    const spike = detectSpike(ring);
    if (spike.isSpike) {
      boundarySpikes++;
      const [minX, minY, maxX, maxY] = ringBbox(ring);
      issues.push({
        featureIndex: ri,
        type: "boundary-spike",
        detail: spike.perimAreaRatio
          ? `ring ${ri}: perim/sqrt(area)=${spike.perimAreaRatio.toFixed(1)}, ${ring.length} pts`
          : `ring ${ri}: bboxDiag=${spike.maxDeviation?.toFixed(4)}°, ${ring.length} pts`,
        lng: (minX + maxX) / 2,
        lat: (minY + maxY) / 2
      });
    }
  }

  if (unclosedRings > 0) {
    issues.push({
      featureIndex: -1,
      type: "unclosed-rings",
      detail: `${unclosedRings} rings not properly closed after stitching`
    });
  }

  if (verbose) {
    process.stderr.write(
      `  boundary: ${rings.length} rings, ${totalVertices} total verts, ${boundarySpikes} spikes, ${unclosedRings} unclosed\n`
    );
  }

  return { issues };
}

// ── Main ──

interface StateReport {
  state: string;
  featureCount: number;
  arcCount: number;
  blockCount: number;
  issues: {
    degenerateFragments: number;
    spikes: number;
    excessiveVertices: number;
    topoDegenerates: number;
    overlapArcs: number;
    topoMergeSpikes: number;
    gapsTiny: number;
    gapsSmall: number;
    holesLarge: number;
    boundarySpikes: number;
    unclosedRings: number;
  };
  details: Issue[];
}

async function validateState(state: string, verbose: boolean): Promise<StateReport> {
  process.stderr.write(`\n=== ${state} ===\n`);

  const [inputResult, topoResult, boundaryResult] = await Promise.all([
    validateInputGeoJSON(state, verbose),
    validateTopoJSON(state, verbose),
    validateBoundaryStitching(state, verbose)
  ]);

  const allIssues = [...inputResult.issues, ...topoResult.issues, ...boundaryResult.issues];

  const report: StateReport = {
    state,
    featureCount: inputResult.featureCount,
    arcCount: topoResult.arcCount,
    blockCount: topoResult.blockCount,
    issues: {
      degenerateFragments: allIssues.filter(i => i.type === "degenerate-fragment").length,
      spikes: allIssues.filter(i => i.type === "spike").length,
      excessiveVertices: allIssues.filter(i => i.type === "excessive-vertices").length,
      topoDegenerates: allIssues.filter(i => i.type === "topo-degenerate").length,
      overlapArcs: allIssues.filter(i => i.type === "overlap-arc").length,
      topoMergeSpikes: allIssues.filter(i => i.type === "topo-merge-spike").length,
      gapsTiny: allIssues.filter(i => i.type === "gap-tiny").length,
      gapsSmall: allIssues.filter(i => i.type === "gap-small").length,
      holesLarge: allIssues.filter(i => i.type === "hole-large").length,
      boundarySpikes: allIssues.filter(i => i.type === "boundary-spike").length,
      unclosedRings: allIssues.filter(i => i.type === "unclosed-rings").length
    },
    details: allIssues
  };

  // Print summary for this state
  const counts = report.issues;
  const hasIssues = Object.values(counts).some(v => v > 0);
  if (hasIssues) {
    process.stderr.write(`  Issues found:\n`);
    if (counts.degenerateFragments > 0)
      process.stderr.write(`    Degenerate fragments (input): ${counts.degenerateFragments}\n`);
    if (counts.spikes > 0) process.stderr.write(`    Spikes (input): ${counts.spikes}\n`);
    if (counts.excessiveVertices > 0)
      process.stderr.write(`    Excessive vertices (input): ${counts.excessiveVertices}\n`);
    if (counts.topoDegenerates > 0)
      process.stderr.write(`    Degenerate blocks (topo): ${counts.topoDegenerates}\n`);
    if (counts.overlapArcs > 0)
      process.stderr.write(`    Overlap arcs (topo): ${counts.overlapArcs}\n`);
    if (counts.topoMergeSpikes > 0)
      process.stderr.write(`    Topo-merge spikes (topojson merge): ${counts.topoMergeSpikes}\n`);
    if (counts.gapsTiny > 0)
      process.stderr.write(`    Gaps tiny <100m² (merge holes): ${counts.gapsTiny}\n`);
    if (counts.gapsSmall > 0)
      process.stderr.write(`    Gaps small <1km² (merge holes): ${counts.gapsSmall}\n`);
    if (counts.holesLarge > 0)
      process.stderr.write(`    Large holes >1km² (merge holes): ${counts.holesLarge}\n`);
    if (counts.boundarySpikes > 0)
      process.stderr.write(`    Boundary spikes (stitching): ${counts.boundarySpikes}\n`);
    if (counts.unclosedRings > 0)
      process.stderr.write(`    Unclosed rings (stitching): ${counts.unclosedRings}\n`);

    if (verbose) {
      for (const issue of allIssues.slice(0, 20)) {
        const loc =
          issue.lng != null ? ` @ (${issue.lng?.toFixed(4)}, ${issue.lat?.toFixed(4)})` : "";
        process.stderr.write(
          `      ${issue.type}: ${issue.featureId || ""} ${issue.detail}${loc}\n`
        );
      }
      if (allIssues.length > 20) {
        process.stderr.write(`      ... and ${allIssues.length - 20} more\n`);
      }
    }
  } else {
    process.stderr.write(`  No issues detected\n`);
  }

  return report;
}

// ── Diagnose: attribute issues to pipeline stages ──
// Split blocks (GeoID with -N suffix) go through direct face collection.
// Whole blocks (no suffix) go through iterative GEOS union.
// By checking which block type each issue appears in, we can determine
// whether the union step, the noding step, or something else is responsible.

async function diagnoseState(state: string): Promise<void> {
  process.stderr.write(`\n=== DIAGNOSING ${state} ===\n`);

  // --- Part 1: Classify input.geojson issues by block type ---
  const filePath = join(OUTPUT_DIR, state, "input.geojson");
  if (!existsSync(filePath)) {
    process.stderr.write(`  No input.geojson found\n`);
    return;
  }

  const stats = {
    // Counts per issue type, split by block type
    spike: { whole: 0, split: 0, wholeExamples: [] as string[], splitExamples: [] as string[] },
    degenerate: {
      whole: 0,
      split: 0,
      wholeExamples: [] as string[],
      splitExamples: [] as string[]
    },
    excessiveVerts: {
      whole: 0,
      split: 0,
      wholeExamples: [] as string[],
      splitExamples: [] as string[]
    },
    // Geometry type breakdown
    wholeBlocks: { polygon: 0, multiPolygon: 0, total: 0 },
    splitBlocks: { polygon: 0, multiPolygon: 0, total: 0 }
  };

  const rl = createInterface({
    input: createReadStream(filePath, { encoding: "utf8" }),
    crlfDelay: Infinity
  });

  let featureIndex = 0;
  for await (const rawLine of rl) {
    const line = rawLine.trim();
    if (line.startsWith('{"type":"FeatureCollection"') || line === "]}") continue;
    const json = line.endsWith(",") ? line.slice(0, -1) : line;
    let feature: any;
    try {
      feature = JSON.parse(json);
    } catch {
      continue;
    }
    if (feature.type !== "Feature" || !feature.geometry) {
      featureIndex++;
      continue;
    }

    const geom = feature.geometry;
    const blockId: string = feature.properties?.block || "";
    const isSplit = /-\d+$/.test(blockId);

    // Track geometry types
    const bucket = isSplit ? stats.splitBlocks : stats.wholeBlocks;
    bucket.total++;
    if (geom.type === "Polygon") bucket.polygon++;
    else if (geom.type === "MultiPolygon") bucket.multiPolygon++;

    // Check for degenerates
    let totalArea = 0;
    for (const ring of getRings(geom)) totalArea += Math.abs(ringAreaM2(ring));
    if (totalArea < 10) {
      const cat = isSplit ? stats.degenerate.splitExamples : stats.degenerate.wholeExamples;
      if (isSplit) stats.degenerate.split++;
      else stats.degenerate.whole++;
      if (cat.length < 5) cat.push(`${blockId} (${totalArea.toFixed(2)}m²)`);
    }

    // Check for spikes
    for (const ring of getRings(geom)) {
      const spike = detectSpike(ring);
      if (spike.isSpike) {
        const cat = isSplit ? stats.spike.splitExamples : stats.spike.wholeExamples;
        if (isSplit) stats.spike.split++;
        else stats.spike.whole++;
        if (cat.length < 5) cat.push(`${blockId} (${spike.perimAreaRatio ? "PP" : "bbox"})`);
        break; // one spike per feature is enough
      }
    }

    // Check for excessive vertices
    const verts = countVertices(geom);
    if (verts > 5000) {
      const cat = isSplit ? stats.excessiveVerts.splitExamples : stats.excessiveVerts.wholeExamples;
      if (isSplit) stats.excessiveVerts.split++;
      else stats.excessiveVerts.whole++;
      if (cat.length < 5) cat.push(`${blockId} (${verts} verts)`);
    }

    featureIndex++;
    if (featureIndex % 100000 === 0) process.stderr.write(`  ${featureIndex} features...\n`);
  }

  console.log(`\n--- ${state}: Input GeoJSON Issue Attribution ---`);
  console.log(`Block counts: ${stats.wholeBlocks.total} whole, ${stats.splitBlocks.total} split`);
  console.log(
    `Geometry types (whole): ${stats.wholeBlocks.polygon} Polygon, ${stats.wholeBlocks.multiPolygon} MultiPolygon`
  );
  console.log(
    `Geometry types (split): ${stats.splitBlocks.polygon} Polygon, ${stats.splitBlocks.multiPolygon} MultiPolygon`
  );
  console.log();

  for (const [name, data] of Object.entries({
    spike: stats.spike,
    degenerate: stats.degenerate,
    excessiveVerts: stats.excessiveVerts
  })) {
    if (data.whole + data.split === 0) continue;
    const total = data.whole + data.split;
    const wholePct = total > 0 ? ((data.whole / total) * 100).toFixed(1) : "0";
    const splitPct = total > 0 ? ((data.split / total) * 100).toFixed(1) : "0";
    console.log(
      `${name}: ${data.whole} whole (${wholePct}%) + ${data.split} split (${splitPct}%) = ${total}`
    );
    if (data.wholeExamples.length > 0)
      console.log(`  whole examples: ${data.wholeExamples.join(", ")}`);
    if (data.splitExamples.length > 0)
      console.log(`  split examples: ${data.splitExamples.join(", ")}`);
  }

  // --- Part 2: Classify topo degenerates by block type ---
  const topoPath = join(OUTPUT_DIR, state, "topo.json");
  if (existsSync(topoPath)) {
    process.stderr.write(`  Loading topo.json for degenerate attribution...\n`);
    const topo = JSON.parse(readFileSync(topoPath, "utf8"));
    const blockLevel = Object.keys(topo.objects)[0];
    const geometries = (topo.objects[blockLevel] as any).geometries;
    const transform = topo.transform;

    let topoDegenWhole = 0,
      topoDegenSplit = 0;
    const topoWholeEx: string[] = [],
      topoSplitEx: string[] = [];

    if (transform) {
      for (let bi = 0; bi < geometries.length; bi++) {
        const geom = geometries[bi];
        const coords = decodeTopoGeometry(topo, geom);
        let totalArea = 0;
        for (const ring of iterCoordRings(coords, geom.type)) {
          totalArea += Math.abs(ringAreaM2(ring));
        }
        if (totalArea < 10) {
          const geoId: string = geom.properties?.[blockLevel] || `#${bi}`;
          const isSplit = /-\d+$/.test(geoId);
          if (isSplit) {
            topoDegenSplit++;
            if (topoSplitEx.length < 5) topoSplitEx.push(`${geoId} (${totalArea.toFixed(2)}m²)`);
          } else {
            topoDegenWhole++;
            if (topoWholeEx.length < 5) topoWholeEx.push(`${geoId} (${totalArea.toFixed(2)}m²)`);
          }
        }
      }
    }

    const tdTotal = topoDegenWhole + topoDegenSplit;
    if (tdTotal > 0) {
      const wholePct = ((topoDegenWhole / tdTotal) * 100).toFixed(1);
      const splitPct = ((topoDegenSplit / tdTotal) * 100).toFixed(1);
      console.log(
        `\ntopo-degenerate: ${topoDegenWhole} whole (${wholePct}%) + ${topoDegenSplit} split (${splitPct}%) = ${tdTotal}`
      );
      if (topoWholeEx.length > 0) console.log(`  whole examples: ${topoWholeEx.join(", ")}`);
      if (topoSplitEx.length > 0) console.log(`  split examples: ${topoSplitEx.join(", ")}`);
    }

    // --- Part 3: Attribute gaps via single-reference arc analysis ---
    // Single-ref arcs form the boundaries of gaps (and the exterior).
    // By checking which blocks own single-ref arcs, we can see if gaps
    // are between whole blocks (union path) or split blocks (face collection).
    process.stderr.write(`  Attributing gaps via single-ref arc owners...\n`);
    {
      const numArcs = topo.arcs.length;
      const arcRefCount = new Int32Array(numArcs);
      const arcOwner: string[] = new Array(numArcs).fill(""); // first block to reference

      for (let bi = 0; bi < geometries.length; bi++) {
        const geom = geometries[bi];
        const geoId: string = geom.properties?.[blockLevel] || `#${bi}`;
        for (const arcIdx of walkTopoArcs(geom)) {
          const canonical = arcIdx >= 0 ? arcIdx : ~arcIdx;
          arcRefCount[canonical]++;
          if (!arcOwner[canonical]) arcOwner[canonical] = geoId;
        }
      }

      // Classify single-ref arcs by owner type
      // Exterior arcs are expected (they form the state boundary).
      // Internal single-ref arcs form gap boundaries.
      // We can't easily distinguish them, but the owner classification
      // still tells us which block types have unshared edges.
      let singleRefWhole = 0,
        singleRefSplit = 0;
      let totalSingleRef = 0;
      // Also check: is the PAIR of blocks on either side of a double-ref arc always
      // the same type? If gaps form between whole-whole or split-split but not mixed,
      // that tells us something.
      const arcPairOwners: string[][] = new Array(numArcs);
      for (let i = 0; i < numArcs; i++) arcPairOwners[i] = [];
      for (let bi = 0; bi < geometries.length; bi++) {
        const geom = geometries[bi];
        const geoId: string = geom.properties?.[blockLevel] || `#${bi}`;
        for (const arcIdx of walkTopoArcs(geom)) {
          const canonical = arcIdx >= 0 ? arcIdx : ~arcIdx;
          if (arcPairOwners[canonical].length < 3) arcPairOwners[canonical].push(geoId);
        }
      }

      for (let i = 0; i < numArcs; i++) {
        if (arcRefCount[i] === 1) {
          totalSingleRef++;
          if (/-\d+$/.test(arcOwner[i])) singleRefSplit++;
          else singleRefWhole++;
        }
      }

      // Now use the merge to find INTERNAL holes, and for each hole, identify
      // which arcs form its boundary by matching coordinates
      const merged = topoMerge(topo, geometries) as any;
      let totalHoles = 0;
      let holeOwnerStats = { wholeSide: 0, splitSide: 0, bothSide: 0, unknownSide: 0 };

      if (merged && merged.coordinates) {
        // Build a coordinate→arc lookup for matching hole boundary coords to arcs
        // Use start+end point pairs as keys for quick matching
        const arcMidpoints = new Map<string, { arcIdx: number; owners: string[] }>();
        for (let ai = 0; ai < numArcs; ai++) {
          if (arcRefCount[ai] !== 1) continue; // only interested in single-ref arcs
          const decoded = decodeTopoArc(topo, ai);
          if (decoded.length >= 2) {
            // Use midpoint as key
            const mid = decoded[Math.floor(decoded.length / 2)];
            const key = `${mid[0].toFixed(6)},${mid[1].toFixed(6)}`;
            arcMidpoints.set(key, { arcIdx: ai, owners: arcPairOwners[ai] });
          }
        }

        for (const poly of merged.coordinates) {
          for (let ri = 1; ri < poly.length; ri++) {
            totalHoles++;
            const ring = poly[ri];
            // Sample points along the hole boundary and try to match to single-ref arcs
            let foundWhole = false,
              foundSplit = false;
            // Check every few points along the ring
            const step = Math.max(1, Math.floor(ring.length / 20));
            for (let pi = 0; pi < ring.length; pi += step) {
              const key = `${ring[pi][0].toFixed(6)},${ring[pi][1].toFixed(6)}`;
              const match = arcMidpoints.get(key);
              if (match) {
                for (const owner of match.owners) {
                  if (/-\d+$/.test(owner)) foundSplit = true;
                  else foundWhole = true;
                }
              }
            }
            if (foundWhole && foundSplit) holeOwnerStats.bothSide++;
            else if (foundWhole) holeOwnerStats.wholeSide++;
            else if (foundSplit) holeOwnerStats.splitSide++;
            else holeOwnerStats.unknownSide++;
          }
        }
      }

      if (totalSingleRef > 0) {
        const wholePct = ((singleRefWhole / totalSingleRef) * 100).toFixed(1);
        const splitPct = ((singleRefSplit / totalSingleRef) * 100).toFixed(1);
        console.log(`\nsingle-ref arcs (gap/exterior boundaries): ${totalSingleRef} total`);
        console.log(`  owned by whole blocks: ${singleRefWhole} (${wholePct}%)`);
        console.log(`  owned by split blocks: ${singleRefSplit} (${splitPct}%)`);
      }

      if (totalHoles > 0) {
        console.log(`\ngap hole boundary attribution (${totalHoles} holes):`);
        console.log(
          `  bordered by whole blocks only: ${holeOwnerStats.wholeSide} (${((holeOwnerStats.wholeSide / totalHoles) * 100).toFixed(1)}%)`
        );
        console.log(
          `  bordered by split blocks only: ${holeOwnerStats.splitSide} (${((holeOwnerStats.splitSide / totalHoles) * 100).toFixed(1)}%)`
        );
        console.log(
          `  bordered by both types: ${holeOwnerStats.bothSide} (${((holeOwnerStats.bothSide / totalHoles) * 100).toFixed(1)}%)`
        );
        console.log(
          `  unmatched: ${holeOwnerStats.unknownSide} (${((holeOwnerStats.unknownSide / totalHoles) * 100).toFixed(1)}%)`
        );
      }
    }

    // --- Part 4: Check overlap arcs (NC-specific) ---
    const numArcs = topo.arcs.length;
    const arcRefCount = new Int32Array(numArcs);
    const arcBlockIds: string[][] = new Array(numArcs);
    for (let i = 0; i < numArcs; i++) arcBlockIds[i] = [];

    for (let bi = 0; bi < geometries.length; bi++) {
      const geom = geometries[bi];
      const geoId: string = geom.properties?.[blockLevel] || `#${bi}`;
      for (const arcIdx of walkTopoArcs(geom)) {
        const canonical = arcIdx >= 0 ? arcIdx : ~arcIdx;
        arcRefCount[canonical]++;
        if (arcBlockIds[canonical].length < 4) arcBlockIds[canonical].push(geoId);
      }
    }

    let overlapCount = 0;
    const overlapPatterns: Record<string, number> = {};
    for (let i = 0; i < numArcs; i++) {
      if (arcRefCount[i] > 2) {
        overlapCount++;
        const ids = arcBlockIds[i];
        const pattern = ids
          .map(id => (/-\d+$/.test(id) ? "split" : "whole"))
          .sort()
          .join("+");
        overlapPatterns[pattern] = (overlapPatterns[pattern] || 0) + 1;
      }
    }
    if (overlapCount > 0) {
      console.log(`\noverlap arcs: ${overlapCount}`);
      for (const [pattern, count] of Object.entries(overlapPatterns).sort((a, b) => b[1] - a[1])) {
        console.log(`  ${pattern}: ${count}`);
      }
      // Show a few examples
      let shown = 0;
      for (let i = 0; i < numArcs && shown < 5; i++) {
        if (arcRefCount[i] > 2) {
          console.log(`  example arc ${i}: blocks [${arcBlockIds[i].join(", ")}]`);
          shown++;
        }
      }
    }
  }
}

async function main() {
  const args = process.argv.slice(2);
  const verbose = args.includes("--verbose") || args.includes("-v");
  const diagnoseMode = args.includes("diagnose");
  const stateArg = args.find(a => !a.startsWith("-") && a !== "diagnose");

  if (!stateArg) {
    console.error("Usage: npx tsx validate-geometry.ts <STATE|all> [--verbose]");
    console.error("       npx tsx validate-geometry.ts diagnose <STATE|all>");
    process.exit(1);
  }

  const states =
    stateArg === "all"
      ? readdirSync(OUTPUT_DIR)
          .filter((d: string) => d.length === 2 && d === d.toUpperCase())
          .sort()
      : [stateArg.toUpperCase()];

  if (diagnoseMode) {
    for (const state of states) {
      if (!existsSync(join(OUTPUT_DIR, state))) {
        process.stderr.write(`\nSkipping ${state}: no data directory\n`);
        continue;
      }
      await diagnoseState(state);
    }
    return;
  }

  const reports: StateReport[] = [];
  for (const state of states) {
    if (!existsSync(join(OUTPUT_DIR, state))) {
      process.stderr.write(`\nSkipping ${state}: no data directory\n`);
      continue;
    }
    reports.push(await validateState(state, verbose));
  }

  // Print summary table
  console.log("\n=== SUMMARY ===");
  console.log(
    "State | Features | Degen | Spikes | HiVert | TopoDgn | Overlap | MrgSpk | GapTny | GapSml | LrgHole | BndSpk | Unclsd"
  );
  console.log(
    "------|----------|-------|--------|--------|---------|---------|--------|--------|--------|---------|--------|------"
  );
  for (const r of reports) {
    const c = r.issues;
    const hasAny = Object.values(c).some(v => v > 0);
    if (!hasAny && states.length > 1) continue; // skip clean states in multi-state runs
    console.log(
      `${r.state.padEnd(5)} | ${String(r.featureCount).padStart(8)} | ${String(c.degenerateFragments).padStart(5)} | ${String(c.spikes).padStart(6)} | ${String(c.excessiveVertices).padStart(6)} | ${String(c.topoDegenerates).padStart(7)} | ${String(c.overlapArcs).padStart(7)} | ${String(c.topoMergeSpikes).padStart(6)} | ${String(c.gapsTiny).padStart(6)} | ${String(c.gapsSmall).padStart(6)} | ${String(c.holesLarge).padStart(7)} | ${String(c.boundarySpikes).padStart(6)} | ${String(c.unclosedRings).padStart(6)}`
    );
  }

  // Output full JSON report to stdout
  if (verbose) {
    console.log("\n=== DETAILED REPORT (JSON) ===");
    console.log(JSON.stringify(reports, null, 2));
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
