/**
 * Client-side district boundary computation using pre-computed adjacency index.
 *
 * Replaces the server's topojson.mergeArcs() with a typed-array-based approach:
 * 1. Scan adjacency index to find boundary arcs per district
 * 2. Group blocks into connected components (for contiguity)
 * 3. Stitch arcs into closed rings per component
 * 4. Decode arc coordinates using transform
 */

import { MultiPolygon } from "geojson";
import { Contiguity, DistrictsDefinition, GeoUnitHierarchy } from "../shared/entities";

export interface AdjacencyData {
  readonly adjacency: Int32Array; // [forwardBlock, reverseBlock] per arc
  readonly arcCoords: ArrayBuffer; // packed coordinates
  readonly arcOffsets: Uint32Array; // byte offsets into arcCoords
  readonly transform: { scale: [number, number]; translate: [number, number] } | null;
}

export interface ReverseIndex {
  readonly offsets: Uint32Array; // block -> start position in arcIds
  readonly arcIds: Int32Array; // signed arc IDs per block
}

// --- Build reverse index from adjacency (block -> arcs) ---

export function buildReverseIndex(adjacency: Int32Array, numBlocks: number): ReverseIndex {
  const numArcs = adjacency.length / 2;

  // Pass 1: count arcs per block
  const counts = new Uint32Array(numBlocks);
  for (let i = 0; i < numArcs; i++) {
    const fwd = adjacency[i * 2];
    const rev = adjacency[i * 2 + 1];
    if (fwd >= 0) counts[fwd]++;
    if (rev >= 0) counts[rev]++;
  }

  // Prefix sum -> offsets
  const offsets = new Uint32Array(numBlocks + 1);
  for (let i = 0; i < numBlocks; i++) {
    offsets[i + 1] = offsets[i] + counts[i];
  }

  // Pass 2: fill signed arc IDs
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

// --- Build flat block -> district assignment from DistrictsDefinition ---

export function buildBlockAssignment(
  districtsDefinition: DistrictsDefinition,
  geoUnitHierarchy: GeoUnitHierarchy,
  numBlocks: number
): Uint8Array {
  const assignment = new Uint8Array(numBlocks);
  function walk(defn: DistrictsDefinition | number, hierarchy: GeoUnitHierarchy | number) {
    if (typeof hierarchy === "number") {
      assignment[hierarchy] = typeof defn === "number" ? defn : 0;
    } else {
      for (let i = 0; i < hierarchy.length; i++) {
        const subDefn = typeof defn === "number" ? defn : defn[i];
        walk(subDefn as DistrictsDefinition | number, hierarchy[i]);
      }
    }
  }
  walk(districtsDefinition, geoUnitHierarchy);
  return assignment;
}

// --- Find connected components of same-district blocks ---

function findComponents(
  districtBlocks: number[],
  adjacency: Int32Array,
  reverseIndex: ReverseIndex
): number[][] {
  const blockSet = new Set(districtBlocks);
  const visited = new Set<number>();
  const components: number[][] = [];
  const numArcs = adjacency.length / 2;

  for (const block of districtBlocks) {
    if (visited.has(block)) continue;
    const component: number[] = [];
    const stack = [block];
    visited.add(block);
    while (stack.length > 0) {
      const b = stack.pop()!;
      component.push(b);
      // Find neighbors via reverse index
      const start = reverseIndex.offsets[b];
      const end = reverseIndex.offsets[b + 1];
      for (let j = start; j < end; j++) {
        const signedArc = reverseIndex.arcIds[j];
        const arcId = signedArc >= 0 ? signedArc : ~signedArc;
        // The other block sharing this arc
        const fwd = adjacency[arcId * 2];
        const rev = adjacency[arcId * 2 + 1];
        const neighbor = fwd === b ? rev : fwd;
        if (neighbor >= 0 && blockSet.has(neighbor) && !visited.has(neighbor)) {
          visited.add(neighbor);
          stack.push(neighbor);
        }
      }
    }
    components.push(component);
  }
  return components;
}

// --- Find boundary arcs for a connected component ---

function findComponentBoundaryArcs(
  blockSet: Set<number>,
  adjacency: Int32Array,
  reverseIndex: ReverseIndex
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

// --- Stitch arcs into rings (port of topojson-client/src/stitch.js) ---

interface ArcEndpoints {
  start(arcId: number): string;
  end(arcId: number): string;
}

function buildArcEndpoints(
  arcCoords: ArrayBuffer,
  arcOffsets: Uint32Array,
  transform: AdjacencyData["transform"]
): ArcEndpoints {
  const isQuantized = transform !== null;
  const bytesPerPoint = isQuantized ? 8 : 16;
  const view = new DataView(arcCoords);

  function getStart(arcId: number): [number, number] {
    const offset = arcOffsets[arcId];
    if (isQuantized) {
      return [view.getInt32(offset, true), view.getInt32(offset + 4, true)];
    }
    return [view.getFloat64(offset, true), view.getFloat64(offset + 8, true)];
  }

  function getEnd(arcId: number): [number, number] {
    const startOffset = arcOffsets[arcId];
    const endOffset = arcOffsets[arcId + 1];
    const numPoints = (endOffset - startOffset) / bytesPerPoint;

    if (isQuantized) {
      // Delta-encoded: accumulate all deltas to get final position
      let x = 0, y = 0;
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

function stitchArcs(
  arcs: number[],
  endpoints: ArcEndpoints,
  arcCoords: ArrayBuffer,
  arcOffsets: Uint32Array,
  transform: AdjacencyData["transform"]
): number[][] {
  const isQuantized = transform !== null;
  const bytesPerPoint = isQuantized ? 8 : 16;

  // Check for empty arcs (2 points where delta is [0,0]) and move them to front
  const view = new DataView(arcCoords);
  let emptyIndex = -1;
  arcs.forEach((signedI, j) => {
    const i = signedI >= 0 ? signedI : ~signedI;
    const start = arcOffsets[i];
    const end = arcOffsets[i + 1];
    const numPoints = (end - start) / bytesPerPoint;
    if (numPoints < 3 && isQuantized) {
      // Check if second point delta is [0,0]
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

// --- Decode arc coordinates into a GeoJSON ring ---

function decodeRing(
  arcIndices: number[],
  arcCoords: ArrayBuffer,
  arcOffsets: Uint32Array,
  transform: AdjacencyData["transform"]
): number[][] {
  const isQuantized = transform !== null;
  const bytesPerPoint = isQuantized ? 8 : 16;
  const view = new DataView(arcCoords);
  const ring: number[][] = [];

  for (const signedArc of arcIndices) {
    const arcId = signedArc >= 0 ? signedArc : ~signedArc;
    const forward = signedArc >= 0;
    const start = arcOffsets[arcId];
    const end = arcOffsets[arcId + 1];
    const numPoints = (end - start) / bytesPerPoint;

    // Decode points
    const points: number[][] = [];
    if (isQuantized) {
      let x = 0, y = 0;
      for (let i = 0; i < numPoints; i++) {
        const off = start + i * 8;
        x += view.getInt32(off, true);
        y += view.getInt32(off + 4, true);
        points.push([
          x * transform!.scale[0] + transform!.translate[0],
          y * transform!.scale[1] + transform!.translate[1]
        ]);
      }
    } else {
      for (let i = 0; i < numPoints; i++) {
        const off = start + i * 16;
        points.push([view.getFloat64(off, true), view.getFloat64(off + 8, true)]);
      }
    }

    if (!forward) points.reverse();

    // Append all except last point (shared with next arc's start)
    for (let i = 0; i < points.length - 1; i++) {
      ring.push(points[i]);
    }
  }

  // Close the ring
  if (ring.length > 0) {
    ring.push(ring[0]);
  }
  return ring;
}

// --- Ring area (shoelace formula) for exterior/hole classification ---

function ringArea(ring: number[][]): number {
  let area = 0;
  const n = ring.length;
  let b = ring[n - 1];
  for (let i = 0; i < n; i++) {
    const a = b;
    b = ring[i];
    area += a[0] * b[1] - a[1] * b[0];
  }
  return Math.abs(area);
}

// --- Compute Polsby-Popper compactness ---

function calcPolsbyPopper(
  coordinates: number[][][][]
): [number, Contiguity] {
  if (coordinates.length === 0) return [0, ""];
  if (coordinates.length > 1) return [0, "non-contiguous"];

  // Single polygon — compute area and perimeter on the exterior ring
  // Using geodesic approximation (Haversine-based) for accuracy
  const exteriorRing = coordinates[0][0];

  // Area via spherical excess (simplified for small regions)
  const toRad = Math.PI / 180;
  let sphericalArea = 0;
  for (let i = 0; i < exteriorRing.length - 1; i++) {
    const [lng1, lat1] = exteriorRing[i];
    const [lng2, lat2] = exteriorRing[i + 1];
    sphericalArea += (lng2 - lng1) * toRad * (2 + Math.sin(lat1 * toRad) + Math.sin(lat2 * toRad));
  }
  const earthRadius = 6371008.8;
  const areaM2 = Math.abs(sphericalArea * earthRadius * earthRadius / 2);

  // Perimeter via Haversine
  let perimeter = 0;
  for (let i = 0; i < exteriorRing.length - 1; i++) {
    const [lng1, lat1] = exteriorRing[i];
    const [lng2, lat2] = exteriorRing[i + 1];
    const dLat = (lat2 - lat1) * toRad;
    const dLng = (lng2 - lng1) * toRad;
    const a = Math.sin(dLat / 2) ** 2 +
      Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLng / 2) ** 2;
    perimeter += 2 * earthRadius * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  if (perimeter === 0) return [0, "contiguous"];
  return [(4 * Math.PI * areaM2) / (perimeter * perimeter), "contiguous"];
}

// --- Main: compute district boundaries ---

export interface DistrictBoundary {
  readonly geometry: MultiPolygon;
  readonly compactness: number;
  readonly contiguity: Contiguity;
}

export function computeDistrictBoundaries(
  adjacencyData: AdjacencyData,
  reverseIndex: ReverseIndex,
  assignment: Uint8Array,
  numberOfDistricts: number
): DistrictBoundary[] {
  const { adjacency, arcCoords, arcOffsets, transform } = adjacencyData;
  const numArcs = adjacency.length / 2;
  const endpoints = buildArcEndpoints(arcCoords, arcOffsets, transform);

  const results: DistrictBoundary[] = [];

  for (let d = 0; d <= numberOfDistricts; d++) {
    // Collect blocks in this district
    const districtBlocks: number[] = [];
    for (let i = 0; i < assignment.length; i++) {
      if (assignment[i] === d) districtBlocks.push(i);
    }

    if (districtBlocks.length === 0) {
      results.push({
        geometry: { type: "MultiPolygon", coordinates: [] },
        compactness: 0,
        contiguity: ""
      });
      continue;
    }

    // Find connected components
    const components = findComponents(districtBlocks, adjacency, reverseIndex);

    // Build MultiPolygon: one polygon per component
    const multiPolyCoords: number[][][][] = [];
    for (const component of components) {
      const blockSet = new Set(component);
      const boundaryArcs = findComponentBoundaryArcs(blockSet, adjacency, reverseIndex);
      if (boundaryArcs.length === 0) continue;

      const rings = stitchArcs([...boundaryArcs], endpoints, arcCoords, arcOffsets, transform);
      if (rings.length === 0) continue;

      // Decode rings to coordinates
      const decodedRings = rings.map(r => decodeRing(r, arcCoords, arcOffsets, transform));

      if (decodedRings.length > 1) {
        // Sort by area, largest first (exterior ring)
        const areas = decodedRings.map(r => ringArea(r));
        const indexed = areas.map((a, i) => ({ area: a, idx: i }));
        indexed.sort((a, b) => b.area - a.area);
        multiPolyCoords.push(indexed.map(x => decodedRings[x.idx]));
      } else {
        multiPolyCoords.push(decodedRings);
      }
    }

    const [compactness, contiguity] = calcPolsbyPopper(multiPolyCoords);

    results.push({
      geometry: { type: "MultiPolygon", coordinates: multiPolyCoords },
      compactness,
      contiguity
    });
  }

  return results;
}
