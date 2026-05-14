// SPDX-License-Identifier: AGPL-3.0-or-later
// Modifications © 2026 Michael Maurizi Jr.

import * as Comlink from "comlink";
import stringify from "json-stable-stringify";
import memoize from "memoizee";
import { type MultiPolygon } from "geojson";

import {
  type DemographicCounts,
  type DistrictsDefinition,
  type DistrictsImportApiResponse,
  type GeoUnits,
  type IProject,
  type IStaticMetadata,
  type ThumbnailGeoJSON
} from "../shared/entities";
import { type DistrictsGeoJSON, type StaticCounts, type StaticProjectData } from "../client/types";
import {
  fetchGeoUnitHierarchy,
  fetchStaticMetadata,
  getCtopoClient,
  regionContainerUri
} from "./s3";
import { type WorkerFunctions } from "./worker";
import { rebuildDistrictGeometries } from "../shared/boundary";

const worker = Comlink.wrap<WorkerFunctions>(
  new Worker(new URL("./worker.ts", import.meta.url), { type: "module" })
);

// Mirror BroadcastChannel summary messages onto the page console.
// `boundary.ts` now runs on the UI thread but the cloud-topo lib's own
// fetch chatter still posts to the same channel; the filter narrows
// the console to the per-merge summary line. Relax the filter when
// you need deeper perf data.
if (typeof BroadcastChannel !== "undefined") {
  const ch = new BroadcastChannel("ctopo-perf");
  ch.onmessage = (e: MessageEvent<string>) => {
    if (!e.data.startsWith("[worker]")) return;
    // eslint-disable-next-line no-console
    console.log(e.data);
  };
}

// Tracks which (keyPrefix, version) pairs have already had a port
// shipped to our Comlink worker. Without this, every `getCtopoClient`
// caller would mint a fresh `MessagePort` and the worker would have to
// close it again on the receiving side.
const attachedRegions = new Set<string>();

function regionKey(keyPrefix: string, version: Date | string | number): string {
  return `${keyPrefix}#${new Date(version).getTime()}`;
}

// One-shot, idempotent. The UI thread owns the cloud-topo worker (it's
// spawned by `getCtopoClient` on the UI side); the worker proxy attaches
// to that same cloud-topo worker via a `MessagePort` so both threads'
// `CtopoClient`s point at the same `CtopoCore` (shared byte-range cache).
async function ensureWorkerAttached(
  keyPrefix: string,
  version: Date | string | number,
  staticMetadata?: IStaticMetadata
): Promise<void> {
  const key = regionKey(keyPrefix, version);
  if (attachedRegions.has(key)) return;
  attachedRegions.add(key);
  try {
    const client = await getCtopoClient(keyPrefix, version);
    const port = client.attachPort();
    const url = regionContainerUri(keyPrefix, version);
    await worker.attachCtopoClient(
      keyPrefix,
      version,
      url,
      Comlink.transfer(port, [port]) as unknown as MessagePort,
      staticMetadata
    );
  } catch (err) {
    // Allow a retry on transient failure (rare; usually means the open
    // call itself rejected). Without this the region would be wedged
    // until full page reload.
    attachedRegions.delete(key);
    throw err;
  }
}

// --- Public API ---

// Fetch the JSON sidecars locally and ask the worker for the
// `.ctopo`-resident staticGeoLevels. The UI thread spawns the
// cloud-topo internal worker (via `getCtopoClient`) and ships a
// `MessagePort` to our Comlink worker so it can open a sibling client
// against the same cloud-topo worker — both clients share the
// underlying byte-range cache.
export async function fetchAllStaticData(
  keyPrefix: string,
  version: Date | string | number
): Promise<StaticProjectData> {
  // Start the cloud-topo client open immediately; subsequent steps
  // chain off it.
  const clientP = getCtopoClient(keyPrefix, version);

  const staticMetadataP = fetchStaticMetadata(keyPrefix, version);
  const geoUnitHierarchyP = fetchGeoUnitHierarchy(keyPrefix, version);

  // Hand the worker its own attached port as soon as staticMetadata
  // arrives — the worker uses both the port and the metadata to
  // bootstrap its caches.
  const attachedP = staticMetadataP.then(sm => ensureWorkerAttached(keyPrefix, version, sm));

  // Speculatively prewarm the base layer's CSR sections (poly_offsets,
  // ring_offsets, arc_refs) — every merge needs them, and the 7.9 MB
  // arc_refs is the boundary critical-path bottleneck. The prewarm
  // populates cloud-topo's shared byte-range cache, so both threads'
  // clients benefit.
  const prewarmP = Promise.all([clientP, staticMetadataP]).then(([client, sm]) => {
    const baseLayer = sm.geoLevelHierarchy[0].id;
    return client.layerGeometry(baseLayer);
  });
  void prewarmP;

  const staticGeoLevelsP = Promise.all([attachedP, staticMetadataP]).then(([, sm]) =>
    worker.fetchStaticGeoLevels(keyPrefix, version, sm)
  );
  const [staticMetadata, geoUnitHierarchy, staticGeoLevels] = await Promise.all([
    staticMetadataP,
    geoUnitHierarchyP,
    staticGeoLevelsP
  ]);
  return { staticMetadata, geoUnitHierarchy, staticGeoLevels };
}

function replacer(this: unknown, key: string | number, value: unknown): unknown {
  if (value instanceof Set) {
    return [...value].sort();
  } else if (value instanceof Map) {
    return [...value.entries()].sort(([a], [b]) => (a === b ? 0 : a < b ? -1 : 1));
  } else {
    return value;
  }
}

// Merge: the whole merge — index-space planning, the cloud-topo merge
// calls, Polsby-Popper, demographics aggregation, and the thumbnail
// simplify pass — runs in the Comlink worker. This thread only rebuilds
// the worker's flat (transferable) geometry into nested GeoJSON and
// assembles the FeatureCollections. See worker.ts mergeDistricts.
export async function mergeDistricts(
  staticMetadata: IStaticMetadata,
  keyPrefix: string,
  version: Date | string | number,
  districtsDefinition: DistrictsDefinition,
  numberOfDistricts: number,
  requestedDemographics: readonly string[],
  requestedVoting: readonly string[]
): Promise<{
  readonly districts: DistrictsGeoJSON;
  readonly thumbnail: ThumbnailGeoJSON;
  readonly isComplete: boolean;
  readonly geometryVersion: string;
}> {
  const t0 = performance.now();
  await ensureWorkerAttached(keyPrefix, version, staticMetadata);
  const result = await worker.mergeDistricts(
    staticMetadata,
    keyPrefix,
    version,
    districtsDefinition,
    numberOfDistricts,
    requestedDemographics,
    requestedVoting
  );

  // Rebuild the worker's flat (transferable) geometry into nested
  // GeoJSON — a tight indexed loop, ~60ms for a state-sized region.
  const fullResGeoms = rebuildDistrictGeometries(result.fullRes);
  const thumbnailGeoms = rebuildDistrictGeometries(result.thumbnail);

  // Properties are per-district and shared between the full-resolution
  // districts FC and the simplified thumbnail FC.
  const propsPerDistrict = fullResGeoms.map((_, i) => ({
    compactness: result.compactness[i],
    contiguity: result.contiguity[i],
    demographics: result.demographics[i],
    voting: result.voting[i]
  }));

  const districts: DistrictsGeoJSON = {
    type: "FeatureCollection",
    features: fullResGeoms.map((geometry, i) => ({
      type: "Feature" as const,
      id: i,
      geometry,
      properties: propsPerDistrict[i]
    }))
  };
  const thumbnail: ThumbnailGeoJSON = {
    type: "FeatureCollection",
    features: thumbnailGeoms.map((geometry, i) => ({
      type: "Feature" as const,
      id: i,
      geometry,
      properties: propsPerDistrict[i]
    }))
  };
  // eslint-disable-next-line no-console
  console.log(
    `[worker] mergeDistricts done in ${(performance.now() - t0).toFixed(0)}ms ` +
      `(${numberOfDistricts} districts)`
  );
  return {
    districts,
    thumbnail,
    isComplete: result.isComplete,
    geometryVersion: result.geometryVersion
  };
}

// Re-aggregate per-district demographics + voting for a new requested field
// set. Unlike mergeDistricts this carries no geometry — the reducer patches
// feature.properties on the existing geojson. Used when only requestedFields
// changed (e.g. evaluate mode), so the unchanged district geometry is never
// re-cloned, re-transferred, or re-rebuilt.
export async function aggregateFields(
  staticMetadata: IStaticMetadata,
  keyPrefix: string,
  version: Date | string | number,
  districtsDefinition: DistrictsDefinition,
  numberOfDistricts: number,
  requestedDemographics: readonly string[],
  requestedVoting: readonly string[]
): Promise<{
  readonly demographics: readonly DemographicCounts[];
  readonly voting: readonly DemographicCounts[];
  readonly isComplete: boolean;
}> {
  const t0 = performance.now();
  await ensureWorkerAttached(keyPrefix, version, staticMetadata);
  const counts = await worker.aggregateFields(
    staticMetadata,
    keyPrefix,
    version,
    districtsDefinition,
    numberOfDistricts,
    requestedDemographics,
    requestedVoting
  );
  // eslint-disable-next-line no-console
  console.log(
    `[worker] aggregateFields done in ${(performance.now() - t0).toFixed(0)}ms ` +
      `(${requestedDemographics.length} demo + ${requestedVoting.length} voting fields)`
  );
  return counts;
}

// Dissolve the entire region into a single MultiPolygon by assigning every
// block to district 1 and running the boundary stitcher. Used to build an
// accurate state outline polygon for the basemap label `within` filter.
// The whole dissolve runs in the worker; this thread only rebuilds the
// flat (transferable) geometry into nested GeoJSON.
export const computeRegionOutline = memoize(
  async (
    staticMetadata: IStaticMetadata,
    keyPrefix: string,
    version: Date | string | number
  ): Promise<MultiPolygon> => {
    await ensureWorkerAttached(keyPrefix, version, staticMetadata);
    const flat = await worker.regionOutline(staticMetadata, keyPrefix, version);
    // District 1 is the whole-region dissolve (0 is the empty unassigned
    // district).
    return rebuildDistrictGeometries(flat)[1];
  },
  { normalizer: args => `${args[1]}#${new Date(args[2]).getTime()}`, primitive: true }
);

export async function exportCsv(
  staticMetadata: IStaticMetadata,
  keyPrefix: string,
  version: Date | string | number,
  districtsDefinition: DistrictsDefinition
): Promise<string> {
  await ensureWorkerAttached(keyPrefix, version, staticMetadata);
  return worker.exportCsv(staticMetadata, keyPrefix, version, districtsDefinition);
}

export async function importCsv(
  keyPrefix: string,
  version: Date | string | number,
  csvText: string
): Promise<DistrictsImportApiResponse> {
  await ensureWorkerAttached(keyPrefix, version);
  return worker.importCsv(keyPrefix, version, csvText);
}

export const getTotalSelectedDemographics = memoize(
  async (
    staticMetadata: IStaticMetadata,
    keyPrefix: string,
    version: Date | string | number,
    selectedGeounits: GeoUnits,
    requestedDemographics: readonly string[],
    requestedVoting: readonly string[]
  ): Promise<StaticCounts> => {
    await ensureWorkerAttached(keyPrefix, version, staticMetadata);
    return worker.getTotalSelectedDemographics(
      staticMetadata,
      keyPrefix,
      version,
      selectedGeounits,
      requestedDemographics,
      requestedVoting
    );
  },
  {
    normalizer: args =>
      stringify(
        [args[1], new Date(args[2]).getTime(), args[3], [...args[4]].sort(), [...args[5]].sort()],
        { replacer }
      ) || "",
    primitive: true
  }
);

export const getSavedDistrictSelectedDemographics = memoize(
  async (
    project: IProject,
    staticMetadata: IStaticMetadata,
    selectedGeounits: GeoUnits,
    requestedDemographics: readonly string[],
    requestedVoting: readonly string[]
  ): Promise<readonly DemographicCounts[]> => {
    await ensureWorkerAttached(
      project.regionConfig.keyPrefix,
      project.regionConfig.version,
      staticMetadata
    );
    return worker.getSavedDistrictSelectedDemographics(
      project,
      staticMetadata,
      project.regionConfig.keyPrefix,
      project.regionConfig.version,
      selectedGeounits,
      requestedDemographics,
      requestedVoting
    );
  },
  {
    normalizer: args =>
      stringify([args[0], args[2], [...args[3]].sort(), [...args[4]].sort()], { replacer }) || "",
    primitive: true
  }
);
