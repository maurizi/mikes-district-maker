// SPDX-License-Identifier: AGPL-3.0-or-later
// Modifications © 2026 Michael Maurizi Jr.

import * as Comlink from "comlink";
import { neighbors, openContainer, type CtopoClient } from "cloud-topo";
import memoize from "memoizee";
import stringify from "json-stable-stringify";

import {
  type Contiguity,
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
  type TypedArray,
  type TypedArrays
} from "../shared/entities";
import {
  type DistrictComponentPlan,
  type FlatDistrictGeometry,
  buildBlockAssignment,
  executeDistrictBoundaries,
  flattenDistrictGeometries,
  planDistrictComponents
} from "../shared/boundary";
import { simplifyForThumbnail } from "../shared/thumbnail";
import { FIPS, MAX_IMPORT_ERRORS } from "../shared/constants";
import {
  buildSplitBlockMap,
  expandBlockToDistrict,
  importCsvToDefinition,
  parseBlockDistrictCsv
} from "../shared/csv-import";
import { type DistrictsGeoJSON, type StaticCounts } from "../client/types";
import {
  getDemographics as getDemographicsBase,
  getVoting as getVotingBase
} from "../shared/functions";
import { allGeoUnitIndices } from "./functions";
import { fetchSections, fetchBlockIds, fetchGeoUnitHierarchy } from "./s3";

// Per-region attached client. Populated by `attachCtopoClient` (called
// once per region from the UI thread, which transfers the
// `MessagePort` from its own client's `attachPort()`). The worker
// opens its own `CtopoClient` against the transferred port, which
// dedupes the underlying `CtopoCore` in cloud-topo's internal worker
// — both threads' clients share the byte-range cache.
const attachedClients = new Map<string, Promise<CtopoClient>>();

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

function getAttachedClient(
  keyPrefix: string,
  version: Date | string | number
): Promise<CtopoClient> {
  const key = cacheKey(keyPrefix, version);
  const client = attachedClients.get(key);
  if (client === undefined) {
    return Promise.reject(
      new Error(
        `worker: no ctopo client attached for ${key} — UI thread must call attachCtopoClient first`
      )
    );
  }
  return client;
}

// Base-layer block adjacency is invariant per region build (it depends
// only on the geometry, not the district assignment), yet every plan —
// the districts merge, every edit re-merge, and regionOutline — used to
// recompute it (~0.7–1.5s via neighbors()). Memoize it per region so
// only the first computation pays. `attachCtopoClient` warms it eagerly
// so that one computation overlaps the rest of page load instead of
// sitting on the first merge's critical path.
const adjacencyCache = new Map<string, Promise<ReadonlyArray<ReadonlyArray<number>>>>();

function getAdjacency(
  keyPrefix: string,
  version: Date | string | number,
  baseLayer: string
): Promise<ReadonlyArray<ReadonlyArray<number>>> {
  const key = cacheKey(keyPrefix, version);
  let adjacency = adjacencyCache.get(key);
  if (adjacency === undefined) {
    adjacency = getAttachedClient(keyPrefix, version).then(client => neighbors(client, baseLayer));
    adjacencyCache.set(key, adjacency);
  }
  return adjacency;
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
      clientPromise: getAttachedClient(keyPrefix, version),
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
    cachedBlockIds = {
      uri: key,
      data: getAttachedClient(keyPrefix, version).then(client => fetchBlockIds(client))
    };
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

// --- Merge (worker-side) ---
//
// The whole merge runs in this worker: index-space orchestration
// (assignment build, adjacency, connected components), the cloud-topo
// merge calls, Polsby-Popper, demographics aggregation, and the
// thumbnail simplify pass (which JSON-stringifies a multi-MB FC up to
// six times to size-fit — far too expensive for the UI thread). Only
// the final flat→GeoJSON rebuild happens on the UI thread; district
// geometry crosses the boundary as transferable typed arrays.

// What the UI thread gets back per merge. The two FlatDistrictGeometry
// payloads are transferred (zero-copy); the UI rebuilds nested GeoJSON.
// demographics / voting / compactness / contiguity are per-district
// (index 0..numberOfDistricts, 0 is the unassigned "district").
export interface WorkerMergeResult {
  readonly fullRes: FlatDistrictGeometry;
  readonly thumbnail: FlatDistrictGeometry;
  readonly compactness: readonly number[];
  readonly contiguity: readonly Contiguity[];
  readonly demographics: readonly DemographicCounts[];
  readonly voting: readonly DemographicCounts[];
  readonly isComplete: boolean;
  // Stable identity for the merged geometry — an FNV-1a hash of the
  // block assignment. District geometry depends only on the assignment,
  // so two merges with the same geometryVersion produce identical
  // geometry, letting the UI skip a redundant maplibre setData.
  readonly geometryVersion: string;
}

// FNV-1a over the assignment bytes — cheap, runs worker-side. Used as a
// stable proxy for produceGeometry's memo key (which is itself keyed on
// the same definition).
function hashAssignment(assignment: Uint8Array): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < assignment.length; i++) {
    h ^= assignment[i];
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

interface PlannedComponents {
  readonly plan: DistrictComponentPlan;
  readonly assignment: Uint8Array;
  readonly numBlocks: number;
}

// Memoized on (keyPrefix, version, districtsDefinition, numberOfDistricts).
// Builds the assignment and runs connected-component analysis over the
// region adjacency; the json-stable-stringify normalizer runs here in
// the worker, off the main thread.
const planComponents = memoize(
  async (
    staticMetadata: IStaticMetadata,
    keyPrefix: string,
    version: Date | string | number,
    districtsDefinition: DistrictsDefinition,
    numberOfDistricts: number
  ): Promise<PlannedComponents> => {
    const region = fetchRegionData(keyPrefix, version, staticMetadata);
    const [geoUnitHierarchy, client] = await Promise.all([
      region.geoUnitHierarchy,
      region.clientPromise
    ]);
    const numBlocks = accumulateBaseIndices(geoUnitHierarchy).length;
    const assignment = buildBlockAssignment(districtsDefinition, geoUnitHierarchy, numBlocks);
    const baseLayer = staticMetadata.geoLevelHierarchy[0].id;
    const adjacency = await getAdjacency(keyPrefix, version, baseLayer);
    const plan = await planDistrictComponents(
      client,
      baseLayer,
      assignment,
      numberOfDistricts,
      undefined,
      adjacency
    );
    return { plan, assignment, numBlocks };
  },
  {
    normalizer: args => stringify([args[1], new Date(args[2]).getTime(), args[3], args[4]]) || "",
    primitive: true
  }
);

interface ProducedGeometry {
  readonly fullRes: FlatDistrictGeometry;
  readonly thumbnail: FlatDistrictGeometry;
  readonly compactness: readonly number[];
  readonly contiguity: readonly Contiguity[];
}

// Memoized on the same key as planComponents. The merged geometry and
// simplified thumbnail depend only on the assignment, not on which
// demographic fields the caller asked for — so a re-merge of the same
// definition with a different field set (ProjectScreen's
// prefetchedAllVoting effect) reuses this entirely.
const produceGeometry = memoize(
  async (
    staticMetadata: IStaticMetadata,
    keyPrefix: string,
    version: Date | string | number,
    districtsDefinition: DistrictsDefinition,
    numberOfDistricts: number
  ): Promise<ProducedGeometry> => {
    const { plan } = await planComponents(
      staticMetadata,
      keyPrefix,
      version,
      districtsDefinition,
      numberOfDistricts
    );
    const region = fetchRegionData(keyPrefix, version, staticMetadata);
    const client = await region.clientPromise;
    const baseLayer = staticMetadata.geoLevelHierarchy[0].id;
    const boundaries = await executeDistrictBoundaries(client, baseLayer, plan);
    // The thumbnail simplify runs on geometry-only stub features —
    // properties don't influence simplification, only the size-fitting
    // JSON length, and per-district properties are negligible vs
    // coordinate data.
    const stubDistricts: DistrictsGeoJSON = {
      type: "FeatureCollection",
      features: boundaries.map((b, i) => ({
        type: "Feature" as const,
        id: i,
        geometry: b.geometry,
        properties: {
          compactness: b.compactness,
          contiguity: b.contiguity,
          demographics: {} as DemographicCounts,
          voting: {}
        }
      }))
    };
    const thumbnailFC = simplifyForThumbnail(stubDistricts);
    return {
      fullRes: flattenDistrictGeometries(boundaries.map(b => b.geometry)),
      thumbnail: flattenDistrictGeometries(thumbnailFC.features.map(f => f.geometry)),
      compactness: boundaries.map(b => b.compactness),
      contiguity: boundaries.map(b => b.contiguity)
    };
  },
  {
    normalizer: args => stringify([args[1], new Date(args[2]).getTime(), args[3], args[4]]) || "",
    primitive: true
  }
);

// Clone a FlatDistrictGeometry's buffers so the memoized produceGeometry
// entry survives the Comlink transfer — transfer detaches the buffers,
// which would corrupt the cached entry for the next caller.
function cloneFlat(g: FlatDistrictGeometry): FlatDistrictGeometry {
  return {
    coords: g.coords.slice(),
    ringOffsets: g.ringOffsets.slice(),
    polyRingOffsets: g.polyRingOffsets.slice(),
    districtPolyOffsets: g.districtPolyOffsets.slice()
  };
}

interface AggregatedCounts {
  readonly demographics: readonly DemographicCounts[];
  readonly voting: readonly DemographicCounts[];
  readonly isComplete: boolean;
}

// Per-district demographic + voting aggregation. Depends only on the block
// assignment and the requested field set — NOT on geometry — so it's
// memoized separately from produceGeometry and keyed to include the
// requested fields. This is what makes a requestedFields-only change (eg.
// entering evaluate mode) cheap: the geometry is reused untouched and a
// repeat aggregation for the same definition + field set is a cache hit.
// Returns plain objects (no transferable buffers), so memoizing is safe —
// nothing here gets detached by a Comlink transfer.
const aggregateCounts = memoize(
  async (
    staticMetadata: IStaticMetadata,
    keyPrefix: string,
    version: Date | string | number,
    districtsDefinition: DistrictsDefinition,
    numberOfDistricts: number,
    requestedDemographics: readonly string[],
    requestedVoting: readonly string[]
  ): Promise<AggregatedCounts> => {
    const { assignment, numBlocks } = await planComponents(
      staticMetadata,
      keyPrefix,
      version,
      districtsDefinition,
      numberOfDistricts
    );
    const region = fetchRegionData(keyPrefix, version, staticMetadata);
    const [demoMap, voteMap] = await Promise.all([
      ensureFields(region, "demographics", requestedDemographics),
      staticMetadata.voting
        ? ensureFields(region, "voting", requestedVoting)
        : Promise.resolve(undefined as Record<string, TypedArray> | undefined)
    ]);

    // Bucket block indices by district for per-district aggregation.
    const districtBlockIndices: number[][] = Array.from(
      { length: numberOfDistricts + 1 },
      () => []
    );
    for (let i = 0; i < numBlocks; i++) {
      districtBlockIndices[assignment[i]].push(i);
    }
    const demographics = districtBlockIndices.map(idx => getDemographicsBase(idx, demoMap));
    const voting = districtBlockIndices.map(idx =>
      voteMap ? getVotingBase(idx, voteMap) : ({} as DemographicCounts)
    );
    // "Complete" means nothing landed in the unassigned district (0).
    const isComplete = districtBlockIndices[0].length === 0;
    return { demographics, voting, isComplete };
  },
  {
    normalizer: args =>
      stringify([
        args[1],
        new Date(args[2]).getTime(),
        args[3],
        args[4],
        [...args[5]].sort(),
        [...args[6]].sort()
      ]) || "",
    primitive: true
  }
);

const functions = {
  // The UI thread opens its own `CtopoClient` first (which spawns the
  // shared cloud-topo internal worker), then calls `attachPort()` on
  // it to mint a `MessagePort` and transfers that port here. The
  // worker opens its `CtopoClient` against the port — cloud-topo sees
  // the same URL on both clients and dedupes the underlying
  // `CtopoCore`, so the byte-range cache is shared.
  //
  // Re-attaching against the same (keyPrefix, version) is a no-op.
  // When `staticMetadata` is provided, the base layer's CSR sections
  // are speculatively prewarmed (poly_offsets / ring_offsets /
  // arc_refs); every merge needs them and the 7.9 MB arc_refs is the
  // boundary critical-path bottleneck.
  attachCtopoClient: (
    keyPrefix: string,
    version: Date | string | number,
    url: string,
    port: MessagePort,
    staticMetadata?: IStaticMetadata
  ): Promise<void> => {
    const key = cacheKey(keyPrefix, version);
    let clientP = attachedClients.get(key);
    if (clientP === undefined) {
      clientP = openContainer(url, { port });
      attachedClients.set(key, clientP);
    } else {
      // Already attached — close the incoming port so we don't leak
      // a MessageChannel half. The proxy will throw if anyone tries
      // to use this client.
      port.close();
    }
    if (staticMetadata) {
      const baseLayer = staticMetadata.geoLevelHierarchy[0].id;
      void clientP.then(client => client.layerGeometry(baseLayer));
      // Warm the block adjacency now so its ~1s compute overlaps the rest
      // of page load rather than landing on the first merge's critical
      // path. Memoized, so the first merge (and regionOutline) reuse it.
      void getAdjacency(keyPrefix, version, baseLayer);
    }
    return clientP.then(() => undefined);
  },
  // Run the whole merge. Index-space planning + the cloud-topo merge
  // calls + Polsby-Popper + the thumbnail simplify pass all happen in
  // this worker; only the final flat→GeoJSON rebuild is left for the UI
  // thread. Geometry crosses the boundary as transferable typed arrays.
  mergeDistricts: async (
    staticMetadata: IStaticMetadata,
    keyPrefix: string,
    version: Date | string | number,
    districtsDefinition: DistrictsDefinition,
    numberOfDistricts: number,
    requestedDemographics: readonly string[],
    requestedVoting: readonly string[]
  ): Promise<WorkerMergeResult> => {
    const [{ assignment }, geometry, counts] = await Promise.all([
      planComponents(staticMetadata, keyPrefix, version, districtsDefinition, numberOfDistricts),
      produceGeometry(staticMetadata, keyPrefix, version, districtsDefinition, numberOfDistricts),
      aggregateCounts(
        staticMetadata,
        keyPrefix,
        version,
        districtsDefinition,
        numberOfDistricts,
        requestedDemographics,
        requestedVoting
      )
    ]);

    // Clone the geometry buffers out of the memoized produceGeometry
    // entry before transferring — transfer detaches them.
    const fullRes = cloneFlat(geometry.fullRes);
    const thumbnail = cloneFlat(geometry.thumbnail);
    const result: WorkerMergeResult = {
      fullRes,
      thumbnail,
      compactness: geometry.compactness,
      contiguity: geometry.contiguity,
      demographics: counts.demographics,
      voting: counts.voting,
      isComplete: counts.isComplete,
      geometryVersion: hashAssignment(assignment)
    };
    return Comlink.transfer(result, [
      fullRes.coords.buffer,
      fullRes.ringOffsets.buffer,
      fullRes.polyRingOffsets.buffer,
      fullRes.districtPolyOffsets.buffer,
      thumbnail.coords.buffer,
      thumbnail.ringOffsets.buffer,
      thumbnail.polyRingOffsets.buffer,
      thumbnail.districtPolyOffsets.buffer
    ]);
  },
  // Re-aggregate per-district demographics + voting for a new requested
  // field set, WITHOUT touching geometry. The UI calls this instead of a
  // full mergeDistricts when only requestedFields changed (e.g. entering
  // evaluate mode) — the district boundaries are unchanged, so there's no
  // reason to re-clone / re-transfer / re-rebuild them. Returns plain
  // objects (structured-cloned, not transferred).
  aggregateFields: (
    staticMetadata: IStaticMetadata,
    keyPrefix: string,
    version: Date | string | number,
    districtsDefinition: DistrictsDefinition,
    numberOfDistricts: number,
    requestedDemographics: readonly string[],
    requestedVoting: readonly string[]
  ): Promise<AggregatedCounts> =>
    aggregateCounts(
      staticMetadata,
      keyPrefix,
      version,
      districtsDefinition,
      numberOfDistricts,
      requestedDemographics,
      requestedVoting
    ),
  // Dissolve every block into one district and return the merged
  // geometry. Used by computeRegionOutline to build the basemap label
  // `within` filter polygon. The whole dissolve — planning and the
  // boundary stitch — runs in the worker; geometry crosses the boundary
  // as transferable typed arrays. No demographics needed.
  regionOutline: async (
    staticMetadata: IStaticMetadata,
    keyPrefix: string,
    version: Date | string | number
  ): Promise<FlatDistrictGeometry> => {
    const region = fetchRegionData(keyPrefix, version, staticMetadata);
    const [geoUnitHierarchy, client] = await Promise.all([
      region.geoUnitHierarchy,
      region.clientPromise
    ]);
    const numBlocks = accumulateBaseIndices(geoUnitHierarchy).length;
    const baseLayer = staticMetadata.geoLevelHierarchy[0].id;
    const assignment = new Uint8Array(numBlocks).fill(1);
    const adjacency = await getAdjacency(keyPrefix, version, baseLayer);
    const plan = await planDistrictComponents(
      client,
      baseLayer,
      assignment,
      1,
      undefined,
      adjacency
    );
    const boundaries = await executeDistrictBoundaries(client, baseLayer, plan);
    const flat = flattenDistrictGeometries(boundaries.map(b => b.geometry));
    return Comlink.transfer(flat, [
      flat.coords.buffer,
      flat.ringOffsets.buffer,
      flat.polyRingOffsets.buffer,
      flat.districtPolyOffsets.buffer
    ]);
  },
  // Owned by the worker so the demographic/voting field caches live
  // in exactly one place per thread. The main thread fetches the JSON
  // sidecars itself and asks the worker for staticGeoLevels via
  // Comlink — see worker-functions.ts fetchAllStaticData.
  fetchStaticGeoLevels: async (
    keyPrefix: string,
    version: Date | string | number,
    staticMetadata: IStaticMetadata
  ): Promise<TypedArrays> => {
    const client = await getAttachedClient(keyPrefix, version);
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
    // detached those caches and corrupted every subsequent read.
    return arrays;
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
