import * as Comlink from "comlink";

import {
  DemographicCounts,
  DistrictsDefinition,
  GeoUnits,
  GeoUnitIndices,
  GeoUnitHierarchy,
  IProject,
  IStaticMetadata,
  NestedArray,
  S3URI
} from "../shared/entities";
import { StaticCounts, DistrictsGeoJSON } from "../client/types";
import {
  getDemographics as getDemographicsBase,
  getVoting as getVotingBase
} from "../shared/functions";
import { allGeoUnitIndices } from "./functions";
import { fetchWorkerStaticData, fetchAdjacencyData, fetchBlockIds } from "./s3";
import { WorkerProjectData } from "./types";
import {
  AdjacencyData,
  ReverseIndex,
  buildReverseIndex,
  buildBlockAssignment,
  computeDistrictBoundaries
} from "./boundary";

interface RegionData {
  readonly uri: S3URI;
  readonly data: Promise<WorkerProjectData>;
}

interface CachedAdjacency {
  readonly uri: S3URI;
  readonly data: Promise<AdjacencyData>;
  reverseIndex?: ReverseIndex;
  numBlocks?: number;
}

// eslint-disable-next-line
let regionData: RegionData | undefined;
// eslint-disable-next-line
let cachedAdjacency: CachedAdjacency | undefined;

function fetchRegionData(regionURI: S3URI, staticMetadata: IStaticMetadata): RegionData {
  // eslint-disable-next-line
  if (!regionData || regionData.uri !== regionURI) {
    regionData = {
      uri: regionURI,
      data: fetchWorkerStaticData(regionURI, staticMetadata)
    };
  }
  return regionData;
}

function getAdjacencyData(regionURI: S3URI): CachedAdjacency {
  // eslint-disable-next-line
  if (!cachedAdjacency || cachedAdjacency.uri !== regionURI) {
    cachedAdjacency = {
      uri: regionURI,
      data: fetchAdjacencyData(regionURI)
    };
  }
  return cachedAdjacency;
}

async function getAdjacencyWithIndex(
  regionURI: S3URI,
  numBlocks: number
): Promise<{ adjacencyData: AdjacencyData; reverseIndex: ReverseIndex }> {
  const cached = getAdjacencyData(regionURI);
  const adjacencyData = await cached.data;
  if (!cached.reverseIndex || cached.numBlocks !== numBlocks) {
    cached.reverseIndex = buildReverseIndex(adjacencyData.adjacency, numBlocks);
    cached.numBlocks = numBlocks;
  }
  return { adjacencyData, reverseIndex: cached.reverseIndex };
}

// eslint-disable-next-line
let cachedBlockIds: { uri: S3URI; data: Promise<readonly string[]> } | undefined;

function getBlockIds(regionURI: S3URI): Promise<readonly string[]> {
  // eslint-disable-next-line
  if (!cachedBlockIds || cachedBlockIds.uri !== regionURI) {
    cachedBlockIds = { uri: regionURI, data: fetchBlockIds(regionURI) };
  }
  return cachedBlockIds.data;
}

async function getDemographics(
  baseIndices: readonly number[] | ReadonlySet<number>,
  staticMetadata: IStaticMetadata,
  regionURI: S3URI
): Promise<StaticCounts> {
  const data = await fetchRegionData(regionURI, staticMetadata).data;
  return data.staticVotingData
    ? {
        demographics: getDemographicsBase(baseIndices, staticMetadata, data.staticDemographics),
        voting: getVotingBase(baseIndices, staticMetadata, data.staticVotingData)
      }
    : { demographics: getDemographicsBase(baseIndices, staticMetadata, data.staticDemographics) };
}

/*
 * Return all corresponding base indices (i.e. smallest geounit, eg. blocks) for a given geounit.
 */
function baseIndicesForGeoUnit(
  geoUnitHierarchy: GeoUnitHierarchy,
  geoUnitIndices: GeoUnitIndices
  // eslint-disable-next-line
): number[] {
  const [geoUnitIndex, ...remainingGeoUnitIndices] = geoUnitIndices;
  const indicesForGeoLevel: number | NestedArray<number> = geoUnitHierarchy[geoUnitIndex];
  // eslint-disable-next-line
  if (remainingGeoUnitIndices.length) {
    // Need to recurse to find the geounit in question in the hierarchy
    return baseIndicesForGeoUnit(indicesForGeoLevel as GeoUnitHierarchy, remainingGeoUnitIndices);
  }
  // We've reached the geounit we're after. Now we need to return all the base geounit ids below it
  // eslint-disable-next-line
  if (typeof indicesForGeoLevel === "number") {
    // Must be working with base geounit. Wrap it in an array and return.
    return [indicesForGeoLevel];
  }
  return accumulateBaseIndices(indicesForGeoLevel);
}

/*
 * Return all base indices for this subset of the geounit hierarchy.
 */
// eslint-disable-next-line
function accumulateBaseIndices(geoUnitHierarchy: GeoUnitHierarchy): number[] {
  // eslint-disable-next-line
  const baseIndices: number[] = [];
  const stack: (GeoUnitHierarchy | number)[] = [geoUnitHierarchy];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (typeof current === "number") {
      baseIndices.push(current);
    } else {
      // Push in reverse so we process in original order
      for (let i = current.length - 1; i >= 0; i--) {
        stack.push(current[i]);
      }
    }
  }
  return baseIndices;
}

function exportDistrictsToCsv(
  blockIds: readonly string[],
  districtsDefinition: DistrictsDefinition,
  geoUnitHierarchy: GeoUnitHierarchy
): string {
  const rows: string[] = ["BLOCKID,DISTRICT"];
  function walk(defn: DistrictsDefinition | number, hierarchy: GeoUnitHierarchy | number) {
    if (typeof hierarchy === "number") {
      const districtId = typeof defn === "number" ? defn : 0;
      rows.push(`${blockIds[hierarchy]},${districtId}`);
    } else {
      for (let i = 0; i < hierarchy.length; i++) {
        const subDefn = typeof defn === "number" ? defn : defn[i];
        walk(subDefn as DistrictsDefinition | number, hierarchy[i]);
      }
    }
  }
  walk(districtsDefinition, geoUnitHierarchy);
  return rows.join("\n");
}

function importCsvToDefinition(
  blockIds: readonly string[],
  geoUnitHierarchy: GeoUnitHierarchy,
  blockToDistrict: { readonly [blockId: string]: number }
): DistrictsDefinition {
  // Build reverse lookup: blockId → index
  const idToIndex = new Map<string, number>();
  for (let i = 0; i < blockIds.length; i++) {
    idToIndex.set(blockIds[i], i);
  }

  // Build flat assignment array
  const assignment = new Uint8Array(blockIds.length);
  for (const [blockId, district] of Object.entries(blockToDistrict)) {
    const idx = idToIndex.get(blockId);
    if (idx !== undefined) {
      assignment[idx] = district;
    }
  }

  // Walk hierarchy and build definition, simplifying where possible
  function walk(hierarchy: GeoUnitHierarchy | number): DistrictsDefinition | number {
    if (typeof hierarchy === "number") {
      return assignment[hierarchy];
    }
    const results: (DistrictsDefinition | number)[] = hierarchy.map(h => walk(h));
    // Simplify: if all children are the same value, collapse
    if (results.length !== 1 && results.every(item => item === results[0])) {
      return results[0];
    }
    return results;
  }
  return walk(geoUnitHierarchy) as DistrictsDefinition;
}

const functions = {
  mergeDistricts: async (
    staticMetadata: IStaticMetadata,
    regionURI: S3URI,
    districtsDefinition: DistrictsDefinition,
    numberOfDistricts: number
  ): Promise<DistrictsGeoJSON> => {
    const data = await fetchRegionData(regionURI, staticMetadata).data;
    const numBlocks = accumulateBaseIndices(data.geoUnitHierarchy).length;
    const { adjacencyData, reverseIndex } = await getAdjacencyWithIndex(regionURI, numBlocks);
    const assignment = buildBlockAssignment(districtsDefinition, data.geoUnitHierarchy, numBlocks);
    const boundaries = computeDistrictBoundaries(
      adjacencyData,
      reverseIndex,
      assignment,
      numberOfDistricts
    );

    // Build per-district block indices for demographics
    const districtBlockIndices: number[][] = Array.from(
      { length: numberOfDistricts + 1 },
      () => []
    );
    for (let i = 0; i < numBlocks; i++) {
      districtBlockIndices[assignment[i]].push(i);
    }

    return {
      type: "FeatureCollection",
      features: boundaries.map((b, i) => ({
        type: "Feature" as const,
        id: i,
        geometry: b.geometry,
        properties: {
          compactness: b.compactness,
          contiguity: b.contiguity,
          demographics: getDemographicsBase(
            districtBlockIndices[i],
            staticMetadata,
            data.staticDemographics
          ),
          voting: data.staticVotingData
            ? getVotingBase(districtBlockIndices[i], staticMetadata, data.staticVotingData)
            : {}
        }
      }))
    };
  },
  exportCsv: async (
    staticMetadata: IStaticMetadata,
    regionURI: S3URI,
    districtsDefinition: DistrictsDefinition
  ): Promise<string> => {
    const [data, blockIds] = await Promise.all([
      fetchRegionData(regionURI, staticMetadata).data,
      getBlockIds(regionURI)
    ]);
    return exportDistrictsToCsv(blockIds, districtsDefinition, data.geoUnitHierarchy);
  },
  importCsv: async (
    staticMetadata: IStaticMetadata,
    regionURI: S3URI,
    blockToDistrict: { readonly [blockId: string]: number }
  ): Promise<DistrictsDefinition> => {
    const [data, blockIds] = await Promise.all([
      fetchRegionData(regionURI, staticMetadata).data,
      getBlockIds(regionURI)
    ]);
    return importCsvToDefinition(blockIds, data.geoUnitHierarchy, blockToDistrict);
  },
  getTotalSelectedDemographics: async (
    staticMetadata: IStaticMetadata,
    regionURI: S3URI,
    selectedGeounits: GeoUnits
  ): Promise<StaticCounts> => {
    const data = await fetchRegionData(regionURI, staticMetadata).data;
    // Build up set of blocks ids corresponding to selected geounits
    // eslint-disable-next-line
    const selectedBaseIndices: Set<number> = new Set();
    allGeoUnitIndices(selectedGeounits).forEach(geoUnitIndices =>
      baseIndicesForGeoUnit(data.geoUnitHierarchy, geoUnitIndices).forEach(index =>
        // eslint-disable-next-line
        selectedBaseIndices.add(index)
      )
    );
    // Aggregate all counts for selected blocks
    return await getDemographics(selectedBaseIndices, staticMetadata, regionURI);
  },
  // Drill into the district definition and collect the base geounits for
  // every district that's part of the selection
  getSavedDistrictSelectedDemographics: async (
    project: IProject,
    staticMetadata: IStaticMetadata,
    regionURI: S3URI,
    selectedGeounits: GeoUnits
  ): Promise<readonly DemographicCounts[]> => {
    const data = await fetchRegionData(regionURI, staticMetadata).data;
    /* eslint-disable */
    // Note: not using Array.fill to populate these, because the empty array in memory gets shared
    const mutableDistrictGeounitAccum: number[][] = [];
    for (let i = 0; i <= project.numberOfDistricts; i = i + 1) {
      mutableDistrictGeounitAccum[i] = [];
    }
    /* eslint-enable */

    // Collect all base geounits found in the selection
    const accumulateGeounits = (
      subIndices: GeoUnitIndices,
      subDefinition: DistrictsDefinition | number,
      subHierarchy: GeoUnitHierarchy | number
    ) => {
      if (typeof subHierarchy === "number" && typeof subDefinition === "number") {
        // The base case: we made it to the bottom of the trees and need to assign this
        // base geonunit to the district found in the district definition
        // eslint-disable-next-line
        mutableDistrictGeounitAccum[subDefinition].push(subHierarchy);
        return;
      } else if (subIndices.length === 0 && typeof subHierarchy !== "number") {
        // We've exhausted the base indices. This means we ned to grab all the indices found
        // at this level and accumulate them all
        subHierarchy.forEach((_, ind) => accumulateGeounits([ind], subDefinition, subHierarchy));
        return;
      } else {
        // Recurse by drilling into all three data structures:
        // geounit indices, district definition, and geounit hierarchy
        const currIndex = subIndices[0];
        const currDefn =
          typeof subDefinition === "number"
            ? subDefinition
            : (subDefinition[currIndex] as DistrictsDefinition);
        const currHierarchy =
          typeof subHierarchy === "number" ? subHierarchy : subHierarchy[currIndex];
        accumulateGeounits(subIndices.slice(1), currDefn, currHierarchy);
        return;
      }
    };

    allGeoUnitIndices(selectedGeounits).forEach(geoUnitIndices => {
      accumulateGeounits(geoUnitIndices, project.districtsDefinition, data.geoUnitHierarchy);
    });

    return Promise.all(
      mutableDistrictGeounitAccum.map(baseGeounitIdsForDistrict =>
        getDemographics(baseGeounitIdsForDistrict, staticMetadata, project.regionConfig.s3URI).then(
          staticCounts => staticCounts.demographics
        )
      )
    );
  }
};

export type WorkerFunctions = typeof functions;

Comlink.expose(functions);
