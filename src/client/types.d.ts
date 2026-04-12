import { FeatureCollection, MultiPolygon } from "geojson";
import {
  DistrictGeoJSON,
  DistrictsGeoJSON,
  IProject,
  IStaticMetadata,
  TypedArrays,
  GeoUnitHierarchy,
  DemographicCounts,
  PaginationMetadata,
  IReferenceLayer,
  ThumbnailGeoJSON
} from "../shared/entities";

export { DistrictGeoJSON, DistrictsGeoJSON, ThumbnailGeoJSON };

export interface DynamicProjectData {
  readonly project: IProject;
  readonly geojson: DistrictsGeoJSON;
}

export interface PaginatedResponse<T> {
  readonly items: readonly T[];
  readonly meta: PaginationMetadata;
}

export interface StaticProjectData {
  readonly staticMetadata: IStaticMetadata;
  readonly staticGeoLevels: TypedArrays;
  readonly geoUnitHierarchy: GeoUnitHierarchy;
}

export interface WorkerProjectData {
  readonly staticDemographics: TypedArrays;
  readonly staticVotingData?: TypedArrays;
  readonly geoUnitHierarchy: GeoUnitHierarchy;
}

export interface StaticCounts {
  // nest demographics and voting data together
  readonly demographics: DemographicCounts;
  readonly voting?: DemographicCounts;
}

export type ProjectData = DynamicProjectData & StaticProjectData;

export type SavingState = "unsaved" | "saving" | "saved" | "failed";

export interface AuthLocationState {
  readonly from: { pathname: string; search?: string };
}

export type MetricKey =
  | "equalPopulation"
  | "contiguity"
  | "competitiveness"
  | "compactness"
  | "majorityMinority"
  | "countySplits";

export interface BaseEvaluateMetric {
  readonly key: MetricKey;
  readonly name: string;
  readonly description: string;
  readonly longText?: string;
  readonly shortText?: string;
  readonly showInSummary: boolean;
}

export type ElectionYear = string;

export interface PviBucket {
  readonly name: string;
  readonly label: string;
  readonly color: string;
  readonly count?: number;
}

export interface EvaluateMetricWithValue extends BaseEvaluateMetric {
  readonly type: "fraction" | "percent" | "count" | "pvibydistrict";
  readonly value?: number;
  readonly total?: number;
  readonly hasMultipleElections?: boolean;
  readonly electionYear?: ElectionYear;
  readonly populationPerRepresentative?: number;
  readonly numberOfMembers?: readonly number[];
  readonly popThreshold?: number;
  readonly pviByDistrict?: readonly (PviBucket | undefined)[] | undefined;
  readonly status?: boolean;
  // eslint-disable-next-line
  readonly [key: string]: any;
}

export type ChoroplethSteps = readonly (readonly [number, string])[];

export type ReferenceLayerGeojson =
  | FeatureCollection<MultiPolygon, ReferenceLayerProperties>
  | FeatureCollection<Point, ReferenceLayerProperties>;

export interface ReferenceLayerImportResponse {
  readonly geojson?: ReferenceLayerGeojson;
  readonly valid: boolean;
  readonly fields?: readonly string[];
}

export interface ReferenceLayerWithGeojson extends IReferenceLayer {
  readonly layer: ReferenceLayerGeojson;
}
