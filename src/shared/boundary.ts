// SPDX-License-Identifier: AGPL-3.0-or-later
// © 2026 Michael Maurizi Jr.

/**
 * District boundary computation. Domain layer over the generic ctopo
 * library: builds per-district block sets from a districts definition,
 * splits each into connected components, and asks ctopo.merge to
 * compute the union of arcs (interior cancellation, ring stitching,
 * coord decode) for each component. Returns one MultiPolygon per
 * district plus its Polsby-Popper compactness and contiguity flag.
 */

import { type MultiPolygon } from "geojson";

import { type CtopoClient, merge, neighbors } from "cloud-topo";
import { type Contiguity, type DistrictsDefinition, type GeoUnitHierarchy } from "./entities";

// Per-stage boundary timing. Posted to the same BroadcastChannel the
// ctopo client and worker use; the main-thread listener filters this
// out by default (only `[worker]` summary lines reach the page
// console) — relax the filter in worker-functions.ts when you need
// these timings.
const _perfChannel =
  typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel("ctopo-perf");
function perfLog(msg: string): void {
  if (_perfChannel !== null) _perfChannel.postMessage(msg);
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
  blockIds: ReadonlyArray<number>,
  adjacency: ReadonlyArray<ReadonlyArray<number>>
): number[][] {
  const inDistrict = new Set(blockIds);
  const visited = new Set<number>();
  const components: number[][] = [];

  for (const seed of blockIds) {
    if (visited.has(seed)) continue;
    const component: number[] = [];
    const stack = [seed];
    visited.add(seed);
    while (stack.length > 0) {
      const block = stack.pop()!;
      component.push(block);
      for (const neighbor of adjacency[block]) {
        if (inDistrict.has(neighbor) && !visited.has(neighbor)) {
          visited.add(neighbor);
          stack.push(neighbor);
        }
      }
    }
    components.push(component);
  }
  return components;
}

// --- Compute district boundaries: plan / execute split ---
//
// Boundary computation is two phases that run on different threads:
//
//   planDistrictComponents  — index-space orchestration (adjacency
//     deserialize, component finding). Runs in our Comlink worker so
//     the ~668K-block walks don't jank the UI thread.
//   executeDistrictBoundaries — coordinate-space work (ctopo.merge,
//     ring assembly, Polsby-Popper). Runs on the UI thread, where its
//     own ctopo client talks straight to the cloud-topo worker so the
//     merged GeoJSON is delivered UI-ward and serialized exactly once.
//
// The plan crosses the worker→UI boundary as flat transferable typed
// arrays (zero-copy) rather than nested `number[][][]`.

export interface DistrictBoundary {
  readonly geometry: MultiPolygon;
  readonly compactness: number;
  readonly contiguity: Contiguity;
}

// Per-district connected components, flattened for a zero-copy
// worker→UI transfer:
//   componentBlocks          — every block index, concatenated across
//                              all components of all districts.
//   componentOffsets         — componentOffsets[c]..componentOffsets[c+1]
//                              is component c's slice of componentBlocks.
//   districtComponentOffsets — districtComponentOffsets[d]..[d+1] is
//                              district d's slice of the component list.
//                              Length is numberOfDistricts + 2 (districts
//                              0..numberOfDistricts inclusive, index 0 is
//                              the unassigned "district").
export interface DistrictComponentPlan {
  readonly componentBlocks: Int32Array;
  readonly componentOffsets: Int32Array;
  readonly districtComponentOffsets: Int32Array;
}

export async function planDistrictComponents(
  client: CtopoClient,
  baseLayer: string,
  assignment: Uint8Array,
  numberOfDistricts: number,
  signal?: AbortSignal,
  // Base-layer adjacency is invariant per region build (it depends only
  // on the geometry, not the assignment). Callers that run many plans —
  // every re-merge, plus regionOutline — can compute it once and pass it
  // in here to skip the ~0.7–1.5s neighbors() recompute each time.
  precomputedAdjacency?: ReadonlyArray<ReadonlyArray<number>>
): Promise<DistrictComponentPlan> {
  const t0 = performance.now();
  perfLog(`[boundary] plan start (${numberOfDistricts} districts)`);
  const adjacency = precomputedAdjacency ?? (await neighbors(client, baseLayer, signal));
  perfLog(
    `[boundary] neighbors ready at ${(performance.now() - t0).toFixed(0)}ms` +
      (precomputedAdjacency !== undefined ? " (cached)" : "")
  );

  // Bucket blocks by district id (0..numberOfDistricts inclusive —
  // index 0 is the unassigned "district").
  const districtBlocks: number[][] = Array.from({ length: numberOfDistricts + 1 }, () => []);
  for (let i = 0; i < assignment.length; i++) {
    districtBlocks[assignment[i]].push(i);
  }

  // findComponents per district, flattened into the transferable
  // structure. Every block is assigned to exactly one district and
  // lands in exactly one component, so componentBlocks is exactly
  // assignment.length long.
  const componentBlocks = new Int32Array(assignment.length);
  const districtComponentOffsets = new Int32Array(numberOfDistricts + 2);
  const componentOffsetsList: number[] = [0];
  let blockCursor = 0;
  let componentCount = 0;
  for (let d = 0; d <= numberOfDistricts; d++) {
    districtComponentOffsets[d] = componentCount;
    const blocks = districtBlocks[d];
    if (blocks.length > 0) {
      for (const component of findComponents(blocks, adjacency)) {
        for (const block of component) componentBlocks[blockCursor++] = block;
        componentOffsetsList.push(blockCursor);
        componentCount++;
      }
    }
  }
  districtComponentOffsets[numberOfDistricts + 1] = componentCount;

  perfLog(`[boundary] plan done at ${(performance.now() - t0).toFixed(0)}ms`);
  return {
    componentBlocks,
    componentOffsets: Int32Array.from(componentOffsetsList),
    districtComponentOffsets
  };
}

export async function executeDistrictBoundaries(
  client: CtopoClient,
  baseLayer: string,
  plan: DistrictComponentPlan,
  signal?: AbortSignal
): Promise<DistrictBoundary[]> {
  const t0 = performance.now();
  perfLog(`[boundary] execute start`);
  const { componentBlocks, componentOffsets, districtComponentOffsets } = plan;
  const numberOfDistricts = districtComponentOffsets.length - 2;

  // Compute each district in parallel — every merge call goes through
  // the client's range coalescer, which dedupes overlapping arc fetches
  // across districts.
  const districtPromises: Promise<DistrictBoundary>[] = [];
  for (let d = 0; d <= numberOfDistricts; d++) {
    const compStart = districtComponentOffsets[d];
    const compEnd = districtComponentOffsets[d + 1];
    if (compStart === compEnd) {
      districtPromises.push(
        Promise.resolve({
          geometry: { type: "MultiPolygon" as const, coordinates: [] },
          compactness: 0,
          contiguity: "" as Contiguity
        })
      );
      continue;
    }
    const componentIndices: number[] = [];
    for (let c = compStart; c < compEnd; c++) componentIndices.push(c);
    districtPromises.push(
      (async () => {
        // Merge each component independently so each ends up as its own
        // polygon in the final MultiPolygon. ctopo.merge collapses all
        // rings of a single call into one polygon (largest ring as
        // exterior, the rest as holes), which is exactly the
        // per-component shape we want. The index slice is a zero-copy
        // subarray view; ctopo.merge accepts any Iterable<number>.
        const componentPolys = await Promise.all(
          componentIndices.map(async c => {
            const indices = componentBlocks.subarray(componentOffsets[c], componentOffsets[c + 1]);
            const result = await merge(client, [{ layer: baseLayer, indices }], signal);
            return result.coordinates;
          })
        );

        const multiPolyCoords: number[][][][] = [];
        for (const polys of componentPolys) {
          for (const poly of polys) multiPolyCoords.push(poly);
        }

        const [compactness, contiguity] = calcPolsbyPopper(multiPolyCoords);
        return {
          geometry: { type: "MultiPolygon" as const, coordinates: multiPolyCoords },
          compactness,
          contiguity
        };
      })()
    );
  }
  const result = await Promise.all(districtPromises);
  perfLog(`[boundary] execute done at ${(performance.now() - t0).toFixed(0)}ms`);
  return result;
}

// Convenience composition of the plan + execute phases for single-thread
// callers — the manage CLI commands run in Node with one ctopo client and
// no UI thread to keep responsive, so the split buys them nothing. The
// client app deliberately does NOT use this: it runs the two phases on
// separate threads.
export async function computeDistrictBoundaries(
  client: CtopoClient,
  baseLayer: string,
  assignment: Uint8Array,
  numberOfDistricts: number,
  signal?: AbortSignal
): Promise<DistrictBoundary[]> {
  const plan = await planDistrictComponents(
    client,
    baseLayer,
    assignment,
    numberOfDistricts,
    signal
  );
  return executeDistrictBoundaries(client, baseLayer, plan, signal);
}

// --- Flat (transferable) packing for a set of district MultiPolygons ---
//
// One CSR structure covering N districts, each a MultiPolygon. The four
// typed arrays are transferable, so the worker→UI handoff of district
// geometry is zero-copy; the UI thread rebuilds nested GeoJSON via
// `rebuildDistrictGeometries` (a tight indexed loop, ~10ms for a
// state-sized region — far cheaper than structured-cloning the nested
// FeatureCollection).
//
//   coords              — [x0,y0,x1,y1,…] every position, all districts.
//   ringOffsets         — ring r spans positions ringOffsets[r]..[r+1].
//   polyRingOffsets     — polygon p spans rings polyRingOffsets[p]..[p+1].
//   districtPolyOffsets — district d spans polygons
//                         districtPolyOffsets[d]..[d+1]; length is
//                         numDistricts + 1.
export interface FlatDistrictGeometry {
  readonly coords: Float64Array;
  readonly ringOffsets: Uint32Array;
  readonly polyRingOffsets: Uint32Array;
  readonly districtPolyOffsets: Uint32Array;
}

export function flattenDistrictGeometries(
  geometries: ReadonlyArray<MultiPolygon>
): FlatDistrictGeometry {
  let nPos = 0;
  let nRings = 0;
  let nPolys = 0;
  for (const g of geometries) {
    for (const poly of g.coordinates) {
      nPolys++;
      for (const ring of poly) {
        nRings++;
        nPos += ring.length;
      }
    }
  }
  const coords = new Float64Array(nPos * 2);
  const ringOffsets = new Uint32Array(nRings + 1);
  const polyRingOffsets = new Uint32Array(nPolys + 1);
  const districtPolyOffsets = new Uint32Array(geometries.length + 1);
  let posCursor = 0;
  let ringCursor = 0;
  let polyCursor = 0;
  for (let d = 0; d < geometries.length; d++) {
    districtPolyOffsets[d] = polyCursor;
    for (const poly of geometries[d].coordinates) {
      polyRingOffsets[polyCursor++] = ringCursor;
      for (const ring of poly) {
        ringOffsets[ringCursor++] = posCursor;
        for (const pt of ring) {
          coords[posCursor * 2] = pt[0];
          coords[posCursor * 2 + 1] = pt[1];
          posCursor++;
        }
      }
    }
  }
  districtPolyOffsets[geometries.length] = polyCursor;
  polyRingOffsets[nPolys] = ringCursor;
  ringOffsets[nRings] = posCursor;
  return { coords, ringOffsets, polyRingOffsets, districtPolyOffsets };
}

export function rebuildDistrictGeometries(flat: FlatDistrictGeometry): MultiPolygon[] {
  const { coords, ringOffsets, polyRingOffsets, districtPolyOffsets } = flat;
  const numDistricts = districtPolyOffsets.length - 1;
  const out = new Array<MultiPolygon>(numDistricts);
  for (let d = 0; d < numDistricts; d++) {
    const pStart = districtPolyOffsets[d];
    const pEnd = districtPolyOffsets[d + 1];
    const polygons = new Array<number[][][]>(pEnd - pStart);
    for (let p = pStart; p < pEnd; p++) {
      const rStart = polyRingOffsets[p];
      const rEnd = polyRingOffsets[p + 1];
      const rings = new Array<number[][]>(rEnd - rStart);
      for (let r = rStart; r < rEnd; r++) {
        const posStart = ringOffsets[r];
        const posEnd = ringOffsets[r + 1];
        const ring = new Array<number[]>(posEnd - posStart);
        for (let i = 0; i < ring.length; i++) {
          const off = (posStart + i) * 2;
          ring[i] = [coords[off], coords[off + 1]];
        }
        rings[r - rStart] = ring;
      }
      polygons[p - pStart] = rings;
    }
    out[d] = { type: "MultiPolygon", coordinates: polygons };
  }
  return out;
}

// --- Compute Polsby-Popper compactness ---

function calcPolsbyPopper(coordinates: number[][][][]): [number, Contiguity] {
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
  const areaM2 = Math.abs((sphericalArea * earthRadius * earthRadius) / 2);

  // Perimeter via Haversine
  let perimeter = 0;
  for (let i = 0; i < exteriorRing.length - 1; i++) {
    const [lng1, lat1] = exteriorRing[i];
    const [lng2, lat2] = exteriorRing[i + 1];
    const dLat = (lat2 - lat1) * toRad;
    const dLng = (lng2 - lng1) * toRad;
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLng / 2) ** 2;
    perimeter += 2 * earthRadius * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  if (perimeter === 0) return [0, "contiguous"];
  return [(4 * Math.PI * areaM2) / (perimeter * perimeter), "contiguous"];
}
