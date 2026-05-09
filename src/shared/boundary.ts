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

// TEMP perf instrumentation — broadcast to the same channel the
// ctopo client uses; main thread mirrors it to the page console.
// Remove after texas perf investigation.
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

// --- Main: compute district boundaries ---

export interface DistrictBoundary {
  readonly geometry: MultiPolygon;
  readonly compactness: number;
  readonly contiguity: Contiguity;
}

export async function computeDistrictBoundaries(
  client: CtopoClient,
  baseLayer: string,
  assignment: Uint8Array,
  numberOfDistricts: number,
  signal?: AbortSignal
): Promise<DistrictBoundary[]> {
  const t0 = performance.now();
  perfLog(`[boundary] start (${numberOfDistricts} districts)`);
  const adjacency = await neighbors(client, baseLayer, signal);
  perfLog(`[boundary] neighbors ready at ${(performance.now() - t0).toFixed(0)}ms`);

  // Bucket blocks by district id (0..numberOfDistricts inclusive —
  // index 0 is the unassigned "district").
  const districtBlocks: number[][] = Array.from({ length: numberOfDistricts + 1 }, () => []);
  for (let i = 0; i < assignment.length; i++) {
    districtBlocks[assignment[i]].push(i);
  }

  // Compute each district in parallel — every merge call goes through
  // the client's range coalescer, which dedupes overlapping arc fetches
  // across districts.
  const result = await Promise.all(
    districtBlocks.map(async blocks => {
      if (blocks.length === 0) {
        return {
          geometry: { type: "MultiPolygon" as const, coordinates: [] },
          compactness: 0,
          contiguity: "" as Contiguity
        };
      }

      const components = findComponents(blocks, adjacency);
      // Merge each component independently so each ends up as its own
      // polygon in the final MultiPolygon. ctopo.merge collapses all
      // rings of a single call into one polygon (largest ring as
      // exterior, the rest as holes), which is exactly the per-component
      // shape we want.
      const componentPolys = await Promise.all(
        components.map(async component => {
          const result = await merge(client, [{ layer: baseLayer, indices: component }], signal);
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
    })
  );
  perfLog(`[boundary] done at ${(performance.now() - t0).toFixed(0)}ms`);
  return result;
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
