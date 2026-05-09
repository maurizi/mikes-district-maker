// SPDX-License-Identifier: AGPL-3.0-or-later
// Modifications © 2026 Michael Maurizi Jr.

import * as Comlink from "comlink";
import { type MultiPolygon } from "geojson";

// TEMP perf instrumentation — same channel the ctopo client uses; the
// main thread mirrors it to the page console. Remove after texas perf.
const _perfChannel =
  typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel("ctopo-perf");
function perfLog(msg: string): void {
  if (_perfChannel !== null) _perfChannel.postMessage(msg);
}

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
  type ThumbnailGeoJSON,
  type TypedArray,
  type TypedArrays
} from "../shared/entities";
import { type CtopoClient } from "cloud-topo";
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
import { fetchSections, fetchBlockIds, fetchGeoUnitHierarchy, getCtopoClient } from "./s3";
import { buildBlockAssignment, computeDistrictBoundaries } from "../shared/boundary";

// Per-region cache. Each demographic / voting field is its own
// Promise<TypedArray>, populated on demand by ensureFields(). This
// lets the page-load critical path fetch only the subset the sidebar
// will actually render (driven by pinned metrics + active drawing
// options), and top up lazily when the user pins more, expands the
// metrics view, switches population/year/office, or opens evaluate.
interface RegionPromises {
  readonly uri: string;
  readonly staticMetadata: IStaticMetadata;
  readonly geoUnitHierarchy: Promise<GeoUnitHierarchy>;
  readonly clientPromise: Promise<CtopoClient>;
  readonly demographicFields: Map<string, Promise<TypedArray>>;
  readonly votingFields: Map<string, Promise<TypedArray>>;
}

let regionPromises: RegionPromises | undefined;

// keyPrefix + version together identify a region build — caches must
// invalidate if either changes (republish bumps version even when prefix
// is reused).
function cacheKey(keyPrefix: string, version: Date | string | number): string {
  return `${keyPrefix}#${new Date(version).getTime()}`;
}

function fetchRegionData(
  keyPrefix: string,
  version: Date | string | number,
  staticMetadata: IStaticMetadata
): RegionPromises {
  const key = cacheKey(keyPrefix, version);
  if (regionPromises === undefined || regionPromises.uri !== key) {
    regionPromises = {
      uri: key,
      staticMetadata,
      geoUnitHierarchy: fetchGeoUnitHierarchy(keyPrefix, version),
      clientPromise: getCtopoClient(keyPrefix, version),
      demographicFields: new Map(),
      votingFields: new Map()
    };
  }
  return regionPromises;
}

// Resolve typed arrays for a subset of demographic / voting fields,
// fetching any not already in the cache. Issuing all missing
// property() calls in the same tick lets the ctopo client's
// microtask-batched range fetcher coalesce them into one Range GET.
async function ensureFields(
  region: RegionPromises,
  kind: "demographics" | "voting",
  ids: readonly string[]
): Promise<Record<string, TypedArray>> {
  const cache = kind === "demographics" ? region.demographicFields : region.votingFields;
  const files =
    kind === "demographics" ? region.staticMetadata.demographics : region.staticMetadata.voting;
  const available: ReadonlySet<string> = new Set((files || []).map(f => f.id));
  const baseLayer = region.staticMetadata.geoLevelHierarchy[0].id;
  // Filter to ids that actually exist in the region — silently drop
  // anything else (caller may not know which optional fields exist).
  const wanted = ids.filter(id => available.has(id));
  const missing = wanted.filter(id => !cache.has(id));
  if (missing.length > 0) {
    const client = await region.clientPromise;
    for (const id of missing) {
      cache.set(
        id,
        client.property(`${baseLayer}/${id}`).then(v => v as unknown as TypedArray)
      );
    }
  }
  const out: Record<string, TypedArray> = {};
  await Promise.all(
    wanted.map(async id => {
      out[id] = await cache.get(id)!;
    })
  );
  return out;
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
  version: Date | string | number,
  requestedDemographics: readonly string[],
  requestedVoting: readonly string[]
): Promise<StaticCounts> {
  const region = fetchRegionData(keyPrefix, version, staticMetadata);
  const [demoMap, voteMap] = await Promise.all([
    ensureFields(region, "demographics", requestedDemographics),
    staticMetadata.voting
      ? ensureFields(region, "voting", requestedVoting)
      : Promise.resolve(undefined as Record<string, TypedArray> | undefined)
  ]);
  return voteMap
    ? {
        demographics: getDemographicsBase(baseIndices, demoMap),
        voting: getVotingBase(baseIndices, voteMap)
      }
    : { demographics: getDemographicsBase(baseIndices, demoMap) };
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
  // Start the ctopo openContainer Range GET immediately so it flies
  // concurrently with the (large) hierarchy JSON fetch on the main
  // thread. openContainer only needs the URL, not staticMetadata.
  //
  // When staticMetadata is provided, also speculatively prefetch the
  // base layer's CSR sections (poly_offsets, ring_offsets, arc_refs)
  // — every merge needs them, and the 7.9MB arc_refs is the boundary
  // critical-path bottleneck. By the time the merge actually starts
  // (after the Redux round-trip), these bytes are already in the
  // ctopo byte-range cache.
  warmCtopoClient: (
    keyPrefix: string,
    version: Date | string | number,
    staticMetadata?: IStaticMetadata
  ): void => {
    const clientP = getCtopoClient(keyPrefix, version);
    if (staticMetadata) {
      const baseLayer = staticMetadata.geoLevelHierarchy[0].id;
      void clientP.then(client => client.layerGeometry(baseLayer));
    }
  },
  // Owned by the worker so the ctopo client (and its bootstrap chain)
  // lives in exactly one context. The main thread fetches the JSON
  // sidecars itself and asks the worker for staticGeoLevels via
  // Comlink — see worker-functions.ts fetchAllStaticData.
  fetchStaticGeoLevels: async (
    keyPrefix: string,
    version: Date | string | number,
    staticMetadata: IStaticMetadata
  ): Promise<TypedArrays> => {
    const client = await getCtopoClient(keyPrefix, version);
    const sectionNames = staticMetadata.geoLevels.map((entry, i) => {
      const parentId = entry.id;
      const childId = staticMetadata.geoLevelHierarchy[i].id;
      return `${childId}/${parentId}Idx`;
    });
    const arrays = await fetchSections(client, sectionNames);
    // Comlink will structuredClone the typed arrays across the
    // worker/main boundary — this copies the bytes once but leaves
    // the worker's caches intact. Earlier code used Comlink.transfer
    // to avoid the copy, but the underlying ArrayBuffers were also
    // referenced by the client's propertyCache and byteRangeCache
    // (typed-array views share their parent buffer); transferring
    // detached those caches and corrupted every subsequent read,
    // which produced the runaway-fetch behavior we were chasing.
    return arrays;
  },
  mergeDistricts: async (
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
    const t0 = performance.now();
    perfLog(`[worker] mergeDistricts start`);

    // Three independent network paths run concurrently:
    //   1. ctopo client opens (header+arc_offsets prefix prefetch)
    //   2. geoUnitHierarchy JSON sidecar fetches
    //   3. requested demographic + voting sections fetch via the client
    // Boundary computation only needs (1) and (2). Demographics +
    // voting are needed to assemble the final FeatureCollection but
    // can run in parallel with boundary work — previously the whole
    // merge was gated on the demographics fetch finishing, which
    // pinned the critical path to whichever section happened to be
    // largest.
    const region = fetchRegionData(keyPrefix, version, staticMetadata);
    const clientPromise = getCtopoClient(keyPrefix, version);
    const demoMapPromise = ensureFields(region, "demographics", requestedDemographics);
    const voteMapPromise = staticMetadata.voting
      ? ensureFields(region, "voting", requestedVoting)
      : Promise.resolve(undefined as Record<string, TypedArray> | undefined);

    const boundariesPromise = (async () => {
      const [client, geoUnitHierarchy] = await Promise.all([
        clientPromise,
        region.geoUnitHierarchy
      ]);
      perfLog(
        `[worker] mergeDistricts: client+hierarchy ready at ${(performance.now() - t0).toFixed(0)}ms`
      );
      const numBlocks = accumulateBaseIndices(geoUnitHierarchy).length;
      const baseLayer = staticMetadata.geoLevelHierarchy[0].id;
      const assignment = buildBlockAssignment(districtsDefinition, geoUnitHierarchy, numBlocks);
      const boundaries = await computeDistrictBoundaries(
        client,
        baseLayer,
        assignment,
        numberOfDistricts
      );
      return { boundaries, assignment, numBlocks };
    })();

    const [{ boundaries, assignment, numBlocks }, demoMap, voteMap] = await Promise.all([
      boundariesPromise,
      demoMapPromise,
      voteMapPromise
    ]);
    perfLog(`[worker] mergeDistricts: all data ready at ${(performance.now() - t0).toFixed(0)}ms`);

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
          demographics: getDemographicsBase(districtBlockIndices[i], demoMap),
          voting: voteMap ? getVotingBase(districtBlockIndices[i], voteMap) : {}
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
    // Region outline only needs the hierarchy (for numBlocks) and the
    // ctopo client (for the merge). Demographics + voting are not
    // needed here, so don't await them.
    const region = fetchRegionData(keyPrefix, version, staticMetadata);
    const [client, geoUnitHierarchy] = await Promise.all([
      getCtopoClient(keyPrefix, version),
      region.geoUnitHierarchy
    ]);
    const numBlocks = accumulateBaseIndices(geoUnitHierarchy).length;
    const baseLayer = staticMetadata.geoLevelHierarchy[0].id;
    const assignment = new Uint8Array(numBlocks).fill(1);
    const boundaries = await computeDistrictBoundaries(client, baseLayer, assignment, 1);
    return boundaries[1].geometry;
  },
  exportCsv: async (
    staticMetadata: IStaticMetadata,
    keyPrefix: string,
    version: Date | string | number,
    districtsDefinition: DistrictsDefinition
  ): Promise<string> => {
    const region = fetchRegionData(keyPrefix, version, staticMetadata);
    const [geoUnitHierarchy, blockIds] = await Promise.all([
      region.geoUnitHierarchy,
      getBlockIds(keyPrefix, version)
    ]);
    return exportDistrictsToCsv(blockIds, districtsDefinition, geoUnitHierarchy);
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
    selectedGeounits: GeoUnits,
    requestedDemographics: readonly string[],
    requestedVoting: readonly string[]
  ): Promise<StaticCounts> => {
    const geoUnitHierarchy = await fetchRegionData(keyPrefix, version, staticMetadata)
      .geoUnitHierarchy;
    // Build up set of blocks ids corresponding to selected geounits

    const selectedBaseIndices: Set<number> = new Set();
    allGeoUnitIndices(selectedGeounits).forEach(geoUnitIndices =>
      baseIndicesForGeoUnit(geoUnitHierarchy, geoUnitIndices).forEach(index =>
        selectedBaseIndices.add(index)
      )
    );
    // Aggregate counts for selected blocks across the requested fields
    return await getDemographics(
      selectedBaseIndices,
      staticMetadata,
      keyPrefix,
      version,
      requestedDemographics,
      requestedVoting
    );
  },
  // Drill into the district definition and collect the base geounits for
  // every district that's part of the selection
  getSavedDistrictSelectedDemographics: async (
    project: IProject,
    staticMetadata: IStaticMetadata,
    keyPrefix: string,
    version: Date | string | number,
    selectedGeounits: GeoUnits,
    requestedDemographics: readonly string[],
    requestedVoting: readonly string[]
  ): Promise<readonly DemographicCounts[]> => {
    const geoUnitHierarchy = await fetchRegionData(keyPrefix, version, staticMetadata)
      .geoUnitHierarchy;

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
      accumulateGeounits(geoUnitIndices, project.districtsDefinition, geoUnitHierarchy);
    });

    return Promise.all(
      mutableDistrictGeounitAccum.map(baseGeounitIdsForDistrict =>
        getDemographics(
          baseGeounitIdsForDistrict,
          staticMetadata,
          project.regionConfig.keyPrefix,
          project.regionConfig.version,
          requestedDemographics,
          requestedVoting
        ).then(staticCounts => staticCounts.demographics)
      )
    );
  }
};

export type WorkerFunctions = typeof functions;

Comlink.expose(functions);
