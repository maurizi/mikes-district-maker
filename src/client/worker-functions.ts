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
import { fetchGeoUnitHierarchy, fetchStaticMetadata } from "./s3";
import { type WorkerFunctions } from "./worker";

const worker = Comlink.wrap<WorkerFunctions>(
  new Worker(new URL("./worker.ts", import.meta.url), { type: "module" })
);

// Mirror worker BroadcastChannel summary messages onto the page
// console (worker `console.log` shows up in a separate dev-tools tab).
// Per-fetch / per-decompress chatter from cloud-topo and boundary.ts
// also lands on this channel; drop it here so the console shows just
// one summary line per merge — relax the filter when you need deeper
// perf data.
if (typeof BroadcastChannel !== "undefined") {
  const ch = new BroadcastChannel("ctopo-perf");
  ch.onmessage = (e: MessageEvent<string>) => {
    if (!e.data.startsWith("[worker]")) return;
    // eslint-disable-next-line no-console
    console.log(e.data);
  };
}

// Fetch the JSON sidecars locally and ask the worker for the
// `.ctopo`-resident staticGeoLevels — only the worker opens a ctopo
// client, so the bootstrap chain runs once per session instead of
// once per JS context.
export async function fetchAllStaticData(
  keyPrefix: string,
  version: Date | string | number
): Promise<StaticProjectData> {
  // Warm the ctopo client in the worker immediately — openContainer
  // only needs the URL, so its header Range GET flies concurrently
  // with everything else.
  worker.warmCtopoClient(keyPrefix, version);
  // Warm the hierarchy fetch (memoized in s3.ts) without awaiting it —
  // it's large and only needed once the user saves a selection, so it
  // stays off the merge / first-paint critical path. The save path
  // awaits the same memoized promise when it actually needs it.
  fetchGeoUnitHierarchy(keyPrefix, version);
  const staticMetadata = await fetchStaticMetadata(keyPrefix, version);
  // As soon as staticMetadata arrives, speculatively prefetch the
  // base layer's CSR sections (poly_offsets, ring_offsets, arc_refs)
  // — every merge needs them and the 7.9MB arc_refs is the boundary
  // critical-path bottleneck.
  worker.warmCtopoClient(keyPrefix, version, staticMetadata);
  const staticGeoLevels = await worker.fetchStaticGeoLevels(keyPrefix, version, staticMetadata);
  return { staticMetadata, staticGeoLevels };
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

export const mergeDistricts = memoize(
  async (
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
  }> => {
    return worker.mergeDistricts(
      staticMetadata,
      keyPrefix,
      version,
      districtsDefinition,
      numberOfDistricts,
      requestedDemographics,
      requestedVoting
    );
  },
  {
    normalizer: args =>
      stringify(
        [args[1], new Date(args[2]).getTime(), args[3], [...args[5]].sort(), [...args[6]].sort()],
        { replacer }
      ) || "",
    primitive: true
  }
);

export const computeRegionOutline = memoize(
  async (
    staticMetadata: IStaticMetadata,
    keyPrefix: string,
    version: Date | string | number
  ): Promise<MultiPolygon> => {
    return worker.computeRegionOutline(staticMetadata, keyPrefix, version);
  },
  { normalizer: args => `${args[1]}#${new Date(args[2]).getTime()}`, primitive: true }
);

export async function exportCsv(
  staticMetadata: IStaticMetadata,
  keyPrefix: string,
  version: Date | string | number,
  districtsDefinition: DistrictsDefinition
): Promise<string> {
  return worker.exportCsv(staticMetadata, keyPrefix, version, districtsDefinition);
}

export async function importCsv(
  keyPrefix: string,
  version: Date | string | number,
  csvText: string
): Promise<DistrictsImportApiResponse> {
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
