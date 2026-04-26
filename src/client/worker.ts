// SPDX-License-Identifier: AGPL-3.0-or-later
// Modifications © 2026 Michael Maurizi Jr.

import * as Comlink from "comlink";
import { type MultiPolygon } from "geojson";

import {
  type DemographicCounts,
  type DistrictImportField,
  type DistrictsDefinition,
  type DistrictsImportApiResponse,
  type GeoUnits,
  type GeoUnitIndices,
  type GeoUnitHierarchy,
  type ImportRowFlag,
  type IProject,
  type IStaticMetadata,
  type NestedArray,
  type ThumbnailGeoJSON
} from "../shared/entities";
import { FIPS, MAX_IMPORT_ERRORS } from "../shared/constants";
import {
  buildSplitBlockMap,
  expandBlockToDistrict,
  importCsvToDefinition,
  parseBlockDistrictCsv
} from "../shared/csv-import";
import { simplifyForThumbnail } from "../shared/thumbnail";
import { type StaticCounts, type DistrictsGeoJSON } from "../client/types";
import {
  getDemographics as getDemographicsBase,
  getVoting as getVotingBase
} from "../shared/functions";
import { allGeoUnitIndices } from "./functions";
import {
  fetchWorkerStaticData,
  fetchAdjacencyData,
  fetchBlockIds,
  fetchGeoUnitHierarchy
} from "./s3";
import { type WorkerProjectData } from "./types";
import {
  type AdjacencyData,
  type ReverseIndex,
  buildReverseIndex,
  buildBlockAssignment,
  computeDistrictBoundaries
} from "../shared/boundary";

interface RegionData {
  readonly uri: string;
  readonly data: Promise<WorkerProjectData>;
}

interface CachedAdjacency {
  readonly uri: string;
  readonly data: Promise<AdjacencyData>;
  reverseIndex?: ReverseIndex;
  numBlocks?: number;
}

let regionData: RegionData | undefined;

let cachedAdjacency: CachedAdjacency | undefined;

// keyPrefix + version together identify a region build — the cache must
// invalidate if either changes (republish bumps version even when prefix is
// reused).
function cacheKey(keyPrefix: string, version: Date | string | number): string {
  return `${keyPrefix}#${new Date(version).getTime()}`;
}

function fetchRegionData(
  keyPrefix: string,
  version: Date | string | number,
  staticMetadata: IStaticMetadata
): RegionData {
  const key = cacheKey(keyPrefix, version);
  if (!regionData || regionData.uri !== key) {
    regionData = {
      uri: key,
      data: fetchWorkerStaticData(keyPrefix, version, staticMetadata)
    };
  }
  return regionData;
}

function getAdjacencyData(
  keyPrefix: string,
  version: Date | string | number
): CachedAdjacency {
  const key = cacheKey(keyPrefix, version);
  if (!cachedAdjacency || cachedAdjacency.uri !== key) {
    cachedAdjacency = {
      uri: key,
      data: fetchAdjacencyData(keyPrefix, version)
    };
  }
  return cachedAdjacency;
}

async function getAdjacencyWithIndex(
  keyPrefix: string,
  version: Date | string | number,
  numBlocks: number
): Promise<{ adjacencyData: AdjacencyData; reverseIndex: ReverseIndex }> {
  const cached = getAdjacencyData(keyPrefix, version);
  const adjacencyData = await cached.data;
  if (!cached.reverseIndex || cached.numBlocks !== numBlocks) {
    cached.reverseIndex = buildReverseIndex(adjacencyData.adjacency, numBlocks);
    cached.numBlocks = numBlocks;
  }
  return { adjacencyData, reverseIndex: cached.reverseIndex };
}

let cachedBlockIds: { uri: string; data: Promise<readonly string[]> } | undefined;

function getBlockIds(
  keyPrefix: string,
  version: Date | string | number
): Promise<readonly string[]> {
  const key = cacheKey(keyPrefix, version);
  if (!cachedBlockIds || cachedBlockIds.uri !== key) {
    cachedBlockIds = { uri: key, data: fetchBlockIds(keyPrefix, version) };
  }
  return cachedBlockIds.data;
}

async function getDemographics(
  baseIndices: readonly number[] | ReadonlySet<number>,
  staticMetadata: IStaticMetadata,
  keyPrefix: string,
  version: Date | string | number
): Promise<StaticCounts> {
  const data = await fetchRegionData(keyPrefix, version, staticMetadata).data;
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
): number[] {
  const [geoUnitIndex, ...remainingGeoUnitIndices] = geoUnitIndices;
  const indicesForGeoLevel: number | NestedArray<number> = geoUnitHierarchy[geoUnitIndex];

  if (remainingGeoUnitIndices.length) {
    // Need to recurse to find the geounit in question in the hierarchy
    return baseIndicesForGeoUnit(indicesForGeoLevel as GeoUnitHierarchy, remainingGeoUnitIndices);
  }
  // We've reached the geounit we're after. Now we need to return all the base geounit ids below it

  if (typeof indicesForGeoLevel === "number") {
    // Must be working with base geounit. Wrap it in an array and return.
    return [indicesForGeoLevel];
  }
  return accumulateBaseIndices(indicesForGeoLevel);
}

/*
 * Return all base indices for this subset of the geounit hierarchy.
 */

function accumulateBaseIndices(geoUnitHierarchy: GeoUnitHierarchy): number[] {
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

// Full CSV → DistrictsImportApiResponse pipeline, ported from the former
// server endpoint at src/server/src/districts/controllers/districts.controller.ts.
// Runs entirely in the worker so large-state CSVs (TX ~13MB) don't hit
// Lambda's 6 MB sync-invoke payload ceiling.
function runCsvImport(
  csvText: string,
  blockIds: readonly string[],
  geoUnitHierarchy: GeoUnitHierarchy
): DistrictsImportApiResponse {
  const records = parseBlockDistrictCsv(csvText);
  if (records.length === 0) {
    return { error: "CSV is empty or contains only a header row" };
  }

  const flaggedRows: ImportRowFlag[] = [];
  const setFlag = (
    row: readonly string[],
    rowNumber: number,
    field: DistrictImportField,
    errorText: string
  ): void => {
    flaggedRows[rowNumber] = { rowNumber, errorText, rowValue: row, field };
  };

  const stateFips = records[0][0]?.slice(0, 2);
  if (!stateFips || !(stateFips in FIPS)) {
    return { error: "First row has an invalid FIPS code; cannot determine state" };
  }
  const regionCode = FIPS[stateFips];

  // Pass 1: per-row validation (FIPS match, duplicates, district numeric).
  const blockIdCounts: { [blockId: string]: number } = {};
  records.forEach((record, i) => {
    const rowFips = record[0]?.slice(0, 2);
    const blockId = record[0];

    blockIdCounts[blockId] = blockIdCounts[blockId] ? blockIdCounts[blockId] + 1 : 1;

    if (!rowFips || !(rowFips in FIPS)) {
      setFlag(record, i, "BLOCKID", "Invalid FIPS code");
    }
    if (rowFips !== stateFips && !flaggedRows[i]) {
      setFlag(record, i, "BLOCKID", "All geounits in an import must be within the same state");
    }
    if (blockIdCounts[blockId] > 1 && !flaggedRows[i]) {
      setFlag(record, i, "BLOCKID", "Duplicate BLOCKID included in import");
    }
    if (isNaN(Number(record[1])) && !flaggedRows[i]) {
      setFlag(record, i, "DISTRICT", "Invalid district ID, must be numeric");
    }
  });

  const allBlockIds: Set<string> = new Set(blockIds);
  const splitBlockMap = buildSplitBlockMap(blockIds);

  // Pass 2: flag unknown block IDs (not present as real or split-parent).
  const invalidRecords = records.filter((record, i) => {
    if (flaggedRows[i]) return false;
    if (allBlockIds.has(record[0])) return false;
    if (splitBlockMap.has(record[0])) return false;
    setFlag(record, i, "BLOCKID", "Invalid block ID");
    return true;
  });

  // Heuristic: if nearly every row is invalid the user probably uploaded a
  // CSV for the wrong census year. Bail early with a human-readable error.
  if (invalidRecords.length > MAX_IMPORT_ERRORS) {
    return {
      error: `There were ${invalidRecords.length} invalid block IDs for ${regionCode}, ensure the CSV uploaded is for the correct census year`
    };
  }

  // Build block → district, expanding split parents to all their sub-blocks.
  const unflaggedRows = records.filter((_, i) => !flaggedRows[i]);
  const { blockToDistrict: blockToDistricts, maxDistrictId } = expandBlockToDistrict(
    unflaggedRows,
    allBlockIds,
    splitBlockMap
  );

  const districtsDefinition = importCsvToDefinition(blockIds, geoUnitHierarchy, blockToDistricts);

  const rowFlags = flaggedRows.filter((r): r is ImportRowFlag => !!r);
  const numFlags = rowFlags.length;

  return {
    districtsDefinition,
    maxDistrictId,
    numFlags: numFlags || undefined,
    rowFlags: numFlags > 0 ? rowFlags.slice(0, MAX_IMPORT_ERRORS) : undefined
  };
}

const functions = {
  mergeDistricts: async (
    staticMetadata: IStaticMetadata,
    keyPrefix: string,
    version: Date | string | number,
    districtsDefinition: DistrictsDefinition,
    numberOfDistricts: number
  ): Promise<{
    readonly districts: DistrictsGeoJSON;
    readonly thumbnail: ThumbnailGeoJSON;
    readonly isComplete: boolean;
  }> => {
    const data = await fetchRegionData(keyPrefix, version, staticMetadata).data;
    const numBlocks = accumulateBaseIndices(data.geoUnitHierarchy).length;
    const { adjacencyData, reverseIndex } = await getAdjacencyWithIndex(
      keyPrefix,
      version,
      numBlocks
    );
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

    const districts: DistrictsGeoJSON = {
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
    // "Complete" means every base geounit is assigned to a real district —
    // i.e. nothing landed in the unassigned district (index 0).
    const isComplete = districtBlockIndices[0].length === 0;
    return { districts, thumbnail: simplifyForThumbnail(districts), isComplete };
  },
  // Dissolve the entire region into a single MultiPolygon by assigning every
  // block to district 1 and running the boundary stitcher. Used to build an
  // accurate state outline polygon for the basemap label `within` filter.
  computeRegionOutline: async (
    staticMetadata: IStaticMetadata,
    keyPrefix: string,
    version: Date | string | number
  ): Promise<MultiPolygon> => {
    const data = await fetchRegionData(keyPrefix, version, staticMetadata).data;
    const numBlocks = accumulateBaseIndices(data.geoUnitHierarchy).length;
    const { adjacencyData, reverseIndex } = await getAdjacencyWithIndex(
      keyPrefix,
      version,
      numBlocks
    );
    const assignment = new Uint8Array(numBlocks).fill(1);
    const boundaries = computeDistrictBoundaries(adjacencyData, reverseIndex, assignment, 1);
    return boundaries[1].geometry;
  },
  exportCsv: async (
    staticMetadata: IStaticMetadata,
    keyPrefix: string,
    version: Date | string | number,
    districtsDefinition: DistrictsDefinition
  ): Promise<string> => {
    const [data, blockIds] = await Promise.all([
      fetchRegionData(keyPrefix, version, staticMetadata).data,
      getBlockIds(keyPrefix, version)
    ]);
    return exportDistrictsToCsv(blockIds, districtsDefinition, data.geoUnitHierarchy);
  },
  importCsv: async (
    keyPrefix: string,
    version: Date | string | number,
    csvText: string
  ): Promise<DistrictsImportApiResponse> => {
    const [geoUnitHierarchy, blockIds] = await Promise.all([
      fetchGeoUnitHierarchy(keyPrefix, version),
      getBlockIds(keyPrefix, version)
    ]);
    return runCsvImport(csvText, blockIds, geoUnitHierarchy);
  },
  getTotalSelectedDemographics: async (
    staticMetadata: IStaticMetadata,
    keyPrefix: string,
    version: Date | string | number,
    selectedGeounits: GeoUnits
  ): Promise<StaticCounts> => {
    const data = await fetchRegionData(keyPrefix, version, staticMetadata).data;
    // Build up set of blocks ids corresponding to selected geounits

    const selectedBaseIndices: Set<number> = new Set();
    allGeoUnitIndices(selectedGeounits).forEach(geoUnitIndices =>
      baseIndicesForGeoUnit(data.geoUnitHierarchy, geoUnitIndices).forEach(index =>
        selectedBaseIndices.add(index)
      )
    );
    // Aggregate all counts for selected blocks
    return await getDemographics(selectedBaseIndices, staticMetadata, keyPrefix, version);
  },
  // Drill into the district definition and collect the base geounits for
  // every district that's part of the selection
  getSavedDistrictSelectedDemographics: async (
    project: IProject,
    staticMetadata: IStaticMetadata,
    keyPrefix: string,
    version: Date | string | number,
    selectedGeounits: GeoUnits
  ): Promise<readonly DemographicCounts[]> => {
    const data = await fetchRegionData(keyPrefix, version, staticMetadata).data;

    // Note: not using Array.fill to populate these, because the empty array in memory gets shared
    const mutableDistrictGeounitAccum: number[][] = [];
    for (let i = 0; i <= project.numberOfDistricts; i = i + 1) {
      mutableDistrictGeounitAccum[i] = [];
    }

    // Collect all base geounits found in the selection
    const accumulateGeounits = (
      subIndices: GeoUnitIndices,
      subDefinition: DistrictsDefinition | number,
      subHierarchy: GeoUnitHierarchy | number
    ) => {
      if (typeof subHierarchy === "number" && typeof subDefinition === "number") {
        // The base case: we made it to the bottom of the trees and need to assign this
        // base geonunit to the district found in the district definition

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
        getDemographics(
          baseGeounitIdsForDistrict,
          staticMetadata,
          project.regionConfig.keyPrefix,
          project.regionConfig.version
        ).then(staticCounts => staticCounts.demographics)
      )
    );
  }
};

export type WorkerFunctions = typeof functions;

Comlink.expose(functions);
