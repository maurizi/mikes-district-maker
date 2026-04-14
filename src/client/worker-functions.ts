import * as Comlink from "comlink";
import stringify from "json-stable-stringify";
import memoize from "memoizee";

import {
  DemographicCounts,
  DistrictsDefinition,
  DistrictsImportApiResponse,
  GeoUnits,
  IProject,
  IStaticMetadata,
  S3URI,
  ThumbnailGeoJSON
} from "../shared/entities";
import { DistrictsGeoJSON, StaticCounts } from "../client/types";
import { WorkerFunctions } from "./worker";

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
    regionURI: S3URI,
    districtsDefinition: DistrictsDefinition,
    numberOfDistricts: number
  ): Promise<{
    readonly districts: DistrictsGeoJSON;
    readonly thumbnail: ThumbnailGeoJSON;
    readonly isComplete: boolean;
  }> => {
    return worker.mergeDistricts(staticMetadata, regionURI, districtsDefinition, numberOfDistricts);
  },
  {
    normalizer: args => stringify([args[1], args[2]], { replacer }) || "",
    primitive: true
  }
);

export async function exportCsv(
  staticMetadata: IStaticMetadata,
  regionURI: S3URI,
  districtsDefinition: DistrictsDefinition
): Promise<string> {
  return worker.exportCsv(staticMetadata, regionURI, districtsDefinition);
}

export async function importCsv(
  regionURI: S3URI,
  csvText: string
): Promise<DistrictsImportApiResponse> {
  return worker.importCsv(regionURI, csvText);
}

export const getTotalSelectedDemographics = memoize(
  async (
    staticMetadata: IStaticMetadata,
    regionURI: S3URI,
    selectedGeounits: GeoUnits
  ): Promise<StaticCounts> => {
    return worker.getTotalSelectedDemographics(staticMetadata, regionURI, selectedGeounits);
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
      project.regionConfig.s3URI,
      selectedGeounits
    );
  },
  {
    normalizer: args => stringify([args[0], args[2]], { replacer }) || "",
    primitive: true
  }
);
