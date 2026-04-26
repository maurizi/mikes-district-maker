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
import { type DistrictsGeoJSON, type StaticCounts } from "../client/types";
import { type WorkerFunctions } from "./worker";

const worker = Comlink.wrap<WorkerFunctions>(
  new Worker(new URL("./worker.ts", import.meta.url), { type: "module" })
);

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
    districtsDefinition: DistrictsDefinition,
    numberOfDistricts: number
  ): Promise<{
    readonly districts: DistrictsGeoJSON;
    readonly thumbnail: ThumbnailGeoJSON;
    readonly isComplete: boolean;
  }> => {
    return worker.mergeDistricts(staticMetadata, keyPrefix, districtsDefinition, numberOfDistricts);
  },
  {
    normalizer: args => stringify([args[1], args[2]], { replacer }) || "",
    primitive: true
  }
);

export const computeRegionOutline = memoize(
  async (staticMetadata: IStaticMetadata, keyPrefix: string): Promise<MultiPolygon> => {
    return worker.computeRegionOutline(staticMetadata, keyPrefix);
  },
  { normalizer: args => args[1], primitive: true }
);

export async function exportCsv(
  staticMetadata: IStaticMetadata,
  keyPrefix: string,
  districtsDefinition: DistrictsDefinition
): Promise<string> {
  return worker.exportCsv(staticMetadata, keyPrefix, districtsDefinition);
}

export async function importCsv(
  keyPrefix: string,
  csvText: string
): Promise<DistrictsImportApiResponse> {
  return worker.importCsv(keyPrefix, csvText);
}

export const getTotalSelectedDemographics = memoize(
  async (
    staticMetadata: IStaticMetadata,
    keyPrefix: string,
    selectedGeounits: GeoUnits
  ): Promise<StaticCounts> => {
    return worker.getTotalSelectedDemographics(staticMetadata, keyPrefix, selectedGeounits);
  },
  {
    normalizer: args => stringify([args[1], args[2]], { replacer }) || "",
    primitive: true
  }
);

export const getSavedDistrictSelectedDemographics = memoize(
  async (
    project: IProject,
    staticMetadata: IStaticMetadata,
    selectedGeounits: GeoUnits
  ): Promise<readonly DemographicCounts[]> => {
    return worker.getSavedDistrictSelectedDemographics(
      project,
      staticMetadata,
      project.regionConfig.keyPrefix,
      selectedGeounits
    );
  },
  {
    normalizer: args => stringify([args[0], args[2]], { replacer }) || "",
    primitive: true
  }
);
