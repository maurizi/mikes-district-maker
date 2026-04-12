import {
  TypedArray,
  DemographicCounts,
  IStaticMetadata,
  IStaticFile,
  MetricsList,
  VotingMetricsList,
  VotingMetricField,
  DemographicsGroup
} from "../shared/entities";
import { CORE_METRIC_FIELDS, DEMOGRAPHIC_FIELDS_ORDER } from "./constants";

// Helper for finding all indices in an array buffer matching a value.
// Note: mutation is used, because the union type of array buffers proved
// too difficult to line up types for reduce or map/filter.
export function getAllIndices(arrayBuf: TypedArray, vals: ReadonlySet<number>): readonly number[] {
  // eslint-disable-next-line
  let indices: number[] = [];
  arrayBuf.forEach((el: number, ind: number) => {
    // eslint-disable-next-line
    if (vals.has(el)) {
      // eslint-disable-next-line
      indices.push(ind);
    }
  });
  return indices;
}

// Recursively finds all base indices matching a set of values at a specified level
export function getAllBaseIndices(
  descGeoLevels: readonly TypedArray[],
  levelIndex: number,
  vals: readonly number[]
): readonly number[] {
  // eslint-disable-next-line
  if (vals.length === 0 || levelIndex === descGeoLevels.length) {
    return vals;
  }
  return getAllBaseIndices(
    descGeoLevels,
    levelIndex + 1,
    getAllIndices(descGeoLevels[levelIndex], new Set(vals))
  );
}

export function getDemographics(
  baseIndices: readonly number[] | ReadonlySet<number>,
  staticMetadata: IStaticMetadata,
  staticDemographics: readonly TypedArray[]
): DemographicCounts {
  return getAggregatedCounts(
    baseIndices,
    staticMetadata,
    staticDemographics,
    staticMetadata.demographics
  );
}

export function getVoting(
  baseIndices: readonly number[] | ReadonlySet<number>,
  staticMetadata: IStaticMetadata,
  staticVoting: readonly TypedArray[]
): DemographicCounts {
  return staticMetadata.voting
    ? getAggregatedCounts(baseIndices, staticMetadata, staticVoting, staticMetadata.voting)
    : {};
}

export function getAggregatedCounts(
  baseIndices: readonly number[] | ReadonlySet<number>,
  staticMetadata: IStaticMetadata,
  staticFiles: readonly TypedArray[],
  fileProperties: readonly IStaticFile[]
): DemographicCounts {
  // Aggregate numeric data for the IDs
  return fileProperties.reduce((data, props, ind) => {
    let count: number = 0; // eslint-disable-line
    baseIndices.forEach((v: number) => {
      if (!isNaN(staticFiles[ind][v])) {
        count += staticFiles[ind][v];
      }
    });
    return { ...data, [props.id]: count };
  }, {} as DemographicCounts);
}

export function getDemographicLabel(id: string) {
  return id === "native"
    ? "Native American"
    : id === "pacific"
    ? "Pacific Islander"
    : id.split(/(?=[A-Z])/).join(" ");
}

export const getMetricFieldForDemographicsId = (id: string) =>
  id === "population" ? id : `${id}Population`;

export function getDemographicsMetricFields(staticMetadata: IStaticMetadata): MetricsList {
  // eslint-disable-next-line functional/prefer-readonly-type
  const data: (readonly [string, string])[] = staticMetadata.demographics.flatMap(file =>
    CORE_METRIC_FIELDS.includes(file.id)
      ? []
      : [[file.id, getMetricFieldForDemographicsId(file.id)]]
  );
  // If the configuration has demographic groups specified use that order, otherwise use the default ordering
  const order: readonly string[] =
    staticMetadata.demographicsGroups?.flatMap(g =>
      g.total ? [g.total, ...g.subgroups] : g.subgroups
    ) || DEMOGRAPHIC_FIELDS_ORDER;
  // eslint-disable-next-line functional/immutable-data
  data.sort(([a], [b]) => order.indexOf(a) - order.indexOf(b));
  return data;
}

// Only bare presidential voting columns (no office prefix) become header
// fields here — office-specific columns flow through VotingSidebarTooltip.
// File ids look like: "democrat" / "republican" / "other party" (legacy, 2016)
// or "democrat20" / "republican24" / "other party22" (any 2-digit year).
const PARTY_RANK: Record<string, number> = { dem: 0, rep: 1, other: 2 };

function parseBareVotingFileId(id: string): VotingMetricField | undefined {
  if (id.includes("_")) return undefined; // office-prefixed, skip
  const m = id.match(/^(democrat|republican|other party|other)(\d{0,2})$/);
  if (!m) return undefined;
  const partyName = m[1];
  const year = m[2] || "16"; // legacy bare "democrat" ≡ 2016
  const partyShort = partyName === "democrat" ? "dem" : partyName === "republican" ? "rep" : "other";
  return `${partyShort}${year}` as VotingMetricField;
}

function parseVotingMetric(field: VotingMetricField): { year: number; rank: number } {
  const m = field.match(/^(dem|rep|other)(\d{2})$/);
  if (!m) return { year: 99, rank: 99 };
  return { year: parseInt(m[2], 10), rank: PARTY_RANK[m[1]] ?? 99 };
}

export function getVotingMetricFields(staticMetadata: IStaticMetadata): VotingMetricsList {
  // eslint-disable-next-line functional/prefer-readonly-type
  const data: (readonly [string, VotingMetricField])[] =
    staticMetadata.voting?.flatMap(file => {
      const field = parseBareVotingFileId(file.id);
      return field !== undefined ? [[file.id, field] as const] : [];
    }) || [];
  // eslint-disable-next-line functional/immutable-data
  data.sort(([, a], [, b]) => {
    const pa = parseVotingMetric(a);
    const pb = parseVotingMetric(b);
    return pa.year - pb.year || pa.rank - pb.rank;
  });
  return data;
}

export function getDemographicsGroups(
  staticMetadata: IStaticMetadata
): readonly DemographicsGroup[] {
  const demographicsMetricFields = getDemographicsMetricFields(staticMetadata);
  return (
    staticMetadata.demographicsGroups || [
      { total: "population", subgroups: demographicsMetricFields?.map(([id]) => id) || [] }
    ]
  );
}
