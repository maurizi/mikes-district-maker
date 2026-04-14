import * as Comlink from "comlink";
import simplify from "simplify-geojson";
import bbox from "@turf/bbox";

import {
  DemographicCounts,
  DistrictImportField,
  DistrictsDefinition,
  DistrictsImportApiResponse,
  GeoUnits,
  GeoUnitIndices,
  GeoUnitHierarchy,
  ImportRowFlag,
  IProject,
  IStaticMetadata,
  NestedArray,
  S3URI,
  ThumbnailGeoJSON
} from "../shared/entities";
import { FIPS, MAX_IMPORT_ERRORS } from "../shared/constants";
import { StaticCounts, DistrictsGeoJSON } from "../client/types";
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

let regionData: RegionData | undefined;

let cachedAdjacency: CachedAdjacency | undefined;

function fetchRegionData(regionURI: S3URI, staticMetadata: IStaticMetadata): RegionData {
  if (!regionData || regionData.uri !== regionURI) {
    regionData = {
      uri: regionURI,
      data: fetchWorkerStaticData(regionURI, staticMetadata)
    };
  }
  return regionData;
}

function getAdjacencyData(regionURI: S3URI): CachedAdjacency {
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

let cachedBlockIds: { uri: S3URI; data: Promise<readonly string[]> } | undefined;

function getBlockIds(regionURI: S3URI): Promise<readonly string[]> {
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

// Parse a simple two-column `BLOCKID,DISTRICT` CSV (header row + data rows).
// This intentionally does not handle quoted fields — BEF files are flat
// integer/string pairs. Empty trailing lines are skipped.
function parseBlockDistrictCsv(csvText: string): [string, string][] {
  const lines = csvText.split(/\r?\n/);
  const records: [string, string][] = [];
  // Skip the header row (line 0).
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const commaIdx = line.indexOf(",");
    if (commaIdx === -1) continue;
    records.push([line.slice(0, commaIdx), line.slice(commaIdx + 1)]);
  }
  return records;
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
    // eslint-disable-next-line functional/immutable-data
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
    // eslint-disable-next-line functional/immutable-data
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

  // Build split-block lookup: base block → its sub-block variants
  // (e.g. "42001..." → ["42001...-1", "42001...-2"]). When a CSV references
  // the base block but the region data has split it during processing, we
  // expand the assignment across all sub-blocks.
  const allBlockIds: Set<string> = new Set(blockIds);
  const splitBlockMap: Map<string, string[]> = new Map();
  blockIds.forEach(id => {
    const dashIdx = id.indexOf("-");
    if (dashIdx === -1) return;
    const baseId = id.substring(0, dashIdx);
    const existing = splitBlockMap.get(baseId);
    if (existing) {
      // eslint-disable-next-line functional/immutable-data
      existing.push(id);
    } else {
      splitBlockMap.set(baseId, [id]);
    }
  });

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
  const blockToDistricts: { [blockId: string]: number } = {};
  unflaggedRows.forEach(([block, district]) => {
    const d = Number(district);
    if (allBlockIds.has(block)) {
      // eslint-disable-next-line functional/immutable-data
      blockToDistricts[block] = d;
    }
    const splits = splitBlockMap.get(block);
    if (splits) {
      splits.forEach(splitId => {
        // eslint-disable-next-line functional/immutable-data
        blockToDistricts[splitId] = d;
      });
    }
  });

  const districtsDefinition = importCsvToDefinition(
    blockIds,
    geoUnitHierarchy,
    blockToDistricts
  );

  const maxDistrictId = Object.values(blockToDistricts).reduce((a, b) => Math.max(a, b), 0);
  const rowFlags = flaggedRows.filter((r): r is ImportRowFlag => !!r);
  const numFlags = rowFlags.length;

  return {
    districtsDefinition,
    maxDistrictId,
    numFlags: numFlags || undefined,
    rowFlags: numFlags > 0 ? rowFlags.slice(0, MAX_IMPORT_ERRORS) : undefined
  };
}

// Thumbnail serialized JSON size cap. The /api/projects PATCH carries
// districtsDefinition + thumbnail + metadata; Nest's default body limit is
// ~5MB, leave headroom for the rest of the payload.
const THUMBNAIL_MAX_BYTES = 3 * 1024 * 1024;
const THUMBNAIL_MAX_ITERATIONS = 6;

function simplifyForThumbnail(districts: DistrictsGeoJSON): ThumbnailGeoJSON {
  // Small states (DC, RI, etc.) have tiny bbox area and need a finer tolerance
  // than continent-sized states, else the whole state collapses to a point.
  const box = bbox(districts);
  const boxArea = (box[2] - box[0]) * (box[3] - box[1]);
  let tolerance = boxArea > 1 ? 0.005 : 0.001;

  const simplifyOnce = (t: number): ThumbnailGeoJSON => ({
    type: "FeatureCollection",
    features: districts.features.map(feature => {
      try {
        return simplify(feature, t);
      } catch {
        return feature;
      }
    })
  });

  let thumbnail = simplifyOnce(tolerance);
  for (let i = 0; i < THUMBNAIL_MAX_ITERATIONS; i++) {
    if (JSON.stringify(thumbnail).length <= THUMBNAIL_MAX_BYTES) {
      break;
    }
    tolerance *= 2;
    thumbnail = simplifyOnce(tolerance);
  }
  return thumbnail;
}

const functions = {
  mergeDistricts: async (
    staticMetadata: IStaticMetadata,
    regionURI: S3URI,
    districtsDefinition: DistrictsDefinition,
    numberOfDistricts: number
  ): Promise<{
    readonly districts: DistrictsGeoJSON;
    readonly thumbnail: ThumbnailGeoJSON;
    readonly isComplete: boolean;
  }> => {
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
    regionURI: S3URI,
    csvText: string
  ): Promise<DistrictsImportApiResponse> => {
    const [geoUnitHierarchy, blockIds] = await Promise.all([
      fetchGeoUnitHierarchy(regionURI),
      getBlockIds(regionURI)
    ]);
    return runCsvImport(csvText, blockIds, geoUnitHierarchy);
  },
  getTotalSelectedDemographics: async (
    staticMetadata: IStaticMetadata,
    regionURI: S3URI,
    selectedGeounits: GeoUnits
  ): Promise<StaticCounts> => {
    const data = await fetchRegionData(regionURI, staticMetadata).data;
    // Build up set of blocks ids corresponding to selected geounits

    const selectedBaseIndices: Set<number> = new Set();
    allGeoUnitIndices(selectedGeounits).forEach(geoUnitIndices =>
      baseIndicesForGeoUnit(data.geoUnitHierarchy, geoUnitIndices).forEach(index =>
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
        getDemographics(baseGeounitIdsForDistrict, staticMetadata, project.regionConfig.s3URI).then(
          staticCounts => staticCounts.demographics
        )
      )
    );
  }
};

export type WorkerFunctions = typeof functions;

Comlink.expose(functions);
