import { isThisYear, isToday } from "date-fns";
import format from "date-fns/format";
import { type FeatureCollection, type Feature, type Point } from "geojson";
import { cloneDeep, mapKeys, mapValues, pick, pickBy } from "lodash";
import { toast } from "react-toastify";

import {
  type DemographicCounts,
  type DistrictsDefinition,
  type MutableGeoUnitCollection,
  type GeoLevelHierarchy,
  type GeoUnits,
  type GeoUnitIndices,
  type GeoUnitHierarchy,
  type NestedArray,
  type IStaticMetadata,
  type ReferenceLayerProperties,
  type GroupTotal,
  type DemographicsGroup,
  type IProject
} from "../shared/entities";
import { type State } from "./reducers";

import { type Resource, type WriteResource } from "./resource";
import {
  type ChoroplethSteps,
  type DistrictGeoJSON,
  type ElectionYear,
  type DistrictsGeoJSON,
  type ReferenceLayerGeojson,
  type PviBucket
} from "./types";

export function areAnyGeoUnitsSelected(geoUnits: GeoUnits) {
  return Object.values(geoUnits).some(geoUnitsForLevel => geoUnitsForLevel.size);
}

export function canSwitchGeoLevels(
  currentIndex: number,
  newIndex: number,
  geoLevelHierarchy: GeoLevelHierarchy,
  selectedGeounits: GeoUnits
): boolean {
  const areGeoUnitsSelected = areAnyGeoUnitsSelected(selectedGeounits);
  const isBaseLevelAlwaysVisible = isBaseGeoLevelAlwaysVisible(geoLevelHierarchy);
  const isBaseGeoLevelSelected = newIndex === geoLevelHierarchy.length - 1;
  const isCurrentLevelBaseGeoLevel = currentIndex === geoLevelHierarchy.length - 1;
  return !(
    !isBaseLevelAlwaysVisible &&
    areGeoUnitsSelected &&
    // block level selected, so disable all higher geolevels
    ((isBaseGeoLevelSelected && !isCurrentLevelBaseGeoLevel) ||
      // non-block level selected, so disable block level
      (!isBaseGeoLevelSelected && isCurrentLevelBaseGeoLevel))
  );
}

// Determines if we are in a scenario where all geolevels have the same minimum zoom,
// and thus, the base geolevel doesn't require special handling
export function isBaseGeoLevelAlwaysVisible(geoLevelHierarchy: GeoLevelHierarchy) {
  return new Set(geoLevelHierarchy.map(level => level.minZoom)).size === 1;
}

export function allGeoUnitIndices(geoUnits: GeoUnits) {
  return Object.values(geoUnits).flatMap(geoUnitForLevel => Array.from(geoUnitForLevel.values()));
}

export function allGeoUnitIds(geoUnits: GeoUnits) {
  return Object.values(geoUnits).flatMap(geoUnitForLevel => Array.from(geoUnitForLevel.keys()));
}

export const capitalizeFirstLetter = (s: string) =>
  s.substring(0, 1).toUpperCase() + s.substring(1);

export const getPartyColor = (party: string) =>
  party === "republican" ? "#BF4E6A" : party === "democrat" ? "#4E56BF" : "#F7AD00";

export const getMajorityRaceDisplay = (feature: DistrictGeoJSON) =>
  feature.properties.majorityRace && capitalizeFirstLetter(feature.properties.majorityRace);

/* Creates array of party-labelled pvi bucket counts as strings */
export function formatPviByDistrict(
  pviBuckets: readonly (PviBucket | undefined)[] | undefined
): readonly string[] | undefined {
  const partyLabels = ["R", "E (Even)", "D"];
  // Count by partyLabels
  const bucketCounts = pviBuckets?.reduce(
    (allBuckets: { readonly [key: string]: number } | undefined, bucket: PviBucket | undefined) => {
      const name =
        bucket &&
        partyLabels.find(label => bucket.name.includes(label) || label.includes(bucket.name));
      return name
        ? allBuckets && name in allBuckets
          ? { ...allBuckets, [name]: allBuckets[name] + 1 }
          : { ...allBuckets, [name]: 1 }
        : allBuckets;
    },
    {}
  );
  // Create string with partyLabels label
  const bucketCountsStrings =
    bucketCounts &&
    partyLabels
      .map((label: string) => {
        return bucketCounts[label]
          ? `${bucketCounts[label].toLocaleString(undefined, {
              maximumFractionDigits: 0
            })} ${label}`
          : undefined;
      })
      .filter((bucket: string | undefined): bucket is string => bucket !== undefined);
  return bucketCountsStrings && bucketCountsStrings.length > 0 ? bucketCountsStrings : undefined;
}

function computeRowFillInterval(stops: ChoroplethSteps, value?: number) {
  if (value) {
    for (let i = 0; i < stops.length; i++) {
      const r = stops[i];
      if (value >= r[0]) {
        if (i < stops.length - 1) {
          const r1 = stops[i + 1];
          if (value < r1[0]) {
            return r[1];
          }
        } else {
          return r[1];
        }
      } else {
        return r[1];
      }
    }
  }
  return "#fff";
}

export function computeRowFill(stops: ChoroplethSteps, value?: number, interval?: boolean): string {
  let i = 0;
  if (!interval) {
    while (i < stops.length) {
      const r = stops[i];
      if (value && value < r[0]) {
        return r[1];
      } else {
        i++;
      }
    }
    return "#fff";
  } else {
    return computeRowFillInterval(stops, value);
  }
}

// National Democratic two-party presidential vote share, per Cook Political
// Report PVI methodology. 2016 / 2020 values from the 2022 Cook PVI release;
// 2024 computed from Wikipedia two-party popular vote totals (75,017,613 Dem
// / 77,302,580 Rep). Update when Cook publishes the 2025 PVI revision.
const NATIONAL_DEM_VOTE_SHARE: Record<string, number> = {
  "16": 51.1,
  "20": 52.3,
  "24": 49.2
};

// Computes share of votes for party1
export function calculatePartyVoteShare(
  party1Votes: number,
  otherVotes: number
): number | undefined {
  const total = party1Votes + otherVotes;
  return total ? (100 * party1Votes) / total : undefined;
}

export function getPartyVoteShareDisplay(percent?: number): string {
  return percent ? percent.toLocaleString(undefined, { maximumFractionDigits: 0 }) : "0";
}

export function computeDemographicSplit(demographic: number, total: number): string | undefined {
  const percent = total !== 0 ? Math.abs(demographic / total) * 100 : undefined;
  return percent ? percent.toLocaleString(undefined, { maximumFractionDigits: 0 }) : "0";
}

export function isMajorityMinority(f: DistrictGeoJSON): boolean {
  return (
    (f.properties.majorityRace && f.properties.majorityRace !== "white" && f.id !== 0) || false
  );
}

/** The population key to use for deviation calculations.
 *  Only "population" and "adj_population" affect deviation; VAP/CVAP do not. */
export function getDeviationPopulationKey(populationKey: GroupTotal): GroupTotal {
  return populationKey === "adj_population" ? "adj_population" : "population";
}

export function getDemographicsPercentages(
  demographics: { readonly [id: string]: number },
  demographicsGroups: readonly DemographicsGroup[],
  populationKey: GroupTotal
): { readonly [id: string]: number } {
  // To handle cases where adjustments have caused negative pop. use absolute values
  const total = Math.abs(demographics[populationKey]);
  const group =
    demographicsGroups.find(group => group.total === populationKey) || demographicsGroups[0];
  // Fall back to the "population" group's subgroups when the selected group has none
  // (e.g. DE adjusted data has no racial breakdown)
  const subgroups =
    group.subgroups.length > 0
      ? group.subgroups
      : demographicsGroups.find(g => g.total === "population")?.subgroups || [];
  const selectedDemographics = pick(demographics, subgroups);
  // Strip the group prefix so the chart gets lowercase race keys (white, black, ...).
  // VAP/CVAP subgroups are formatted "VAP White"/"CVAP Black" (space-separated).
  // adj_population subgroups are formatted "adj_white"/"adj_black" (underscore).
  // population group keys are already the right shape.
  const stripPrefix = (key: string): string => {
    if (populationKey === "population") return key;
    if (populationKey === "adj_population" && key.startsWith("adj_") && key !== "adj_population")
      return key.slice(4);
    if (key.startsWith(populationKey + " "))
      return key.slice(populationKey.length + 1).toLowerCase();
    return key;
  };
  const renamedDemographics = mapKeys(selectedDemographics, (_v, key) => stripPrefix(key));
  const percentages = mapValues(renamedDemographics, (population: number) =>
    Math.min((total ? population / total : 0) * 100, 100)
  );
  return percentages;
}

/**
 * Computes the Cook Political Partisan Voting Index (PVI).
 * Positive values indicate that a district leans Democrat,
 * and negative values indicate that a district leans Republican.
 * @param  {[DemographicCounts]} voting
 * @return {[number | undefined]} pvi
 */
// Presidential years present in a voting record (keys like `democrat20` with
// matching `republican20`). Excludes office-prefixed columns (`USS_democrat20`).
function getPresidentialYearsInVoting(voting: DemographicCounts): readonly string[] {
  const years = new Set<string>();
  for (const key of Object.keys(voting)) {
    const m = key.match(/^democrat(\d{2})$/);
    if (m && `republican${m[1]}` in voting) years.add(m[1]);
  }
  return Array.from(years).sort();
}

function pviForYear(voting: DemographicCounts, year: string): number | undefined {
  const dem = (voting as Record<string, number>)[`democrat${year}`];
  const rep = (voting as Record<string, number>)[`republican${year}`];
  if (dem === undefined || rep === undefined) return undefined;
  const share = calculatePartyVoteShare(dem, rep);
  const baseline = NATIONAL_DEM_VOTE_SHARE[year];
  if (share === undefined || baseline === undefined) return undefined;
  return share - baseline;
}

export function calculatePVI(voting: DemographicCounts, year?: ElectionYear): number | undefined {
  // Explicit year override (tooltip / flyout can pin to a specific year).
  if (year) {
    const pv = pviForYear(voting, year);
    if (pv !== undefined) return pv;
    // Fall through to defaults if the requested year isn't present.
  }

  // Default: average of the two most recent presidential years present.
  const years = getPresidentialYearsInVoting(voting);
  if (years.length >= 2) {
    const [y1, y2] = years.slice(-2);
    const share1 = calculatePartyVoteShare(
      (voting as Record<string, number>)[`democrat${y1}`],
      (voting as Record<string, number>)[`republican${y1}`]
    );
    const share2 = calculatePartyVoteShare(
      (voting as Record<string, number>)[`democrat${y2}`],
      (voting as Record<string, number>)[`republican${y2}`]
    );
    const base1 = NATIONAL_DEM_VOTE_SHARE[y1];
    const base2 = NATIONAL_DEM_VOTE_SHARE[y2];
    if (
      share1 !== undefined &&
      share2 !== undefined &&
      base1 !== undefined &&
      base2 !== undefined
    ) {
      return (share1 + share2) / 2 - (base1 + base2) / 2;
    }
  } else if (years.length === 1) {
    return pviForYear(voting, years[0]);
  }

  // Legacy path: bare `democrat` / `republican` columns with no year suffix.
  // These only exist in older region builds; treat them as 2016.
  if ("democrat" in voting && "republican" in voting) {
    const share = calculatePartyVoteShare(
      (voting as Record<string, number>).democrat,
      (voting as Record<string, number>).republican
    );
    if (share !== undefined) return share - NATIONAL_DEM_VOTE_SHARE["16"];
  }
  return undefined;
}

export const getAvailableElectionYears = (staticMetadata?: IStaticMetadata): readonly string[] => {
  const years = new Set<string>();
  for (const file of staticMetadata?.voting || []) {
    const { year } = parseVotingId(file.id);
    if (year) years.add(year);
  }
  return Array.from(years).sort();
};

export const hasMultipleElections = (staticMetadata?: IStaticMetadata) =>
  getAvailableElectionYears(staticMetadata).length > 1;

// True if the region exposes any presidential voting columns for the given
// 2-digit year (e.g. "20" or "24"). Replaces the old year-specific helpers.
export const hasElectionYear = (staticMetadata: IStaticMetadata | undefined, year: string) =>
  getAvailableElectionYears(staticMetadata).includes(year);

// True if any presidential voting data exists at all.
export const hasAnyElection = (staticMetadata?: IStaticMetadata) =>
  getAvailableElectionYears(staticMetadata).length > 0;

export function extractYear(voting: DemographicCounts, year?: ElectionYear): DemographicCounts {
  return year
    ? mapKeys(
        pickBy(voting, (val, key) => key.endsWith(year)),
        (val, key) => key.slice(0, -2)
      )
    : voting;
}

const OFFICE_NAMES: Record<string, string> = {
  "": "Presidential",
  USS: "US Senate",
  GOV: "Governor",
  ATG: "Atty General",
  AUD: "Auditor",
  LTG: "Lt. Governor",
  SOS: "Sec. of State",
  TRE: "Treasurer",
  INS: "Insurance",
  AGR: "Agriculture",
  SPI: "Superintendent",
  PSC: "Public Service",
  SAC: "Sup. Court",
  SSC: "Sup. Court",
  LND: "Land",
  LAB: "Labor",
  HAL: "House At-Large",
  COC: "Corp. Comm.",
  COU: "County",
  DEL: "Delegate",
  PUC: "Pub. Utilities",
  SCC: "Sup. Court"
};

export function officeName(code: string): string {
  return OFFICE_NAMES[code] || code;
}

const OFFICE_RANK_ORDER: readonly string[] = [
  "", // Presidential
  "USS", // US Senate
  "GOV", // Governor
  "HAL", // House At-Large
  "LTG", // Lt. Governor
  "ATG", // Atty General
  "SOS", // Sec. of State
  "TRE", // Treasurer
  "AUD", // Auditor
  "INS", // Insurance
  "AGR", // Agriculture
  "LND", // Land
  "LAB", // Labor
  "SPI", // Superintendent
  "PSC", // Public Service
  "PUC", // Pub. Utilities
  "COC", // Corp. Comm.
  "SAC", // Sup. Court
  "SSC", // Sup. Court
  "SCC", // Sup. Court
  "COU", // County
  "DEL" // Delegate
];

export function officeRank(code: string): number {
  const idx = OFFICE_RANK_ORDER.indexOf(code);
  return idx === -1 ? OFFICE_RANK_ORDER.length : idx;
}

export function extractOffice(voting: DemographicCounts, office: string): DemographicCounts {
  if (!office) {
    return pickBy(voting, (val, key) => !key.includes("_"));
  }
  const prefix = office + "_";
  return mapKeys(
    pickBy(voting, (val, key) => key.startsWith(prefix)),
    (val, key) => key.slice(prefix.length)
  );
}

// Parse a voting ID into its office code, party, and year suffix
export function parseVotingId(id: string): {
  readonly office: string;
  readonly party: string;
  readonly year: string;
} {
  const underscoreIdx = id.indexOf("_");
  let office: string;
  let rest: string;
  if (underscoreIdx !== -1) {
    office = id.slice(0, underscoreIdx);
    rest = id.slice(underscoreIdx + 1);
  } else {
    office = "";
    rest = id;
  }
  const yearMatch = rest.match(/(\d{2})$/);
  const year = yearMatch ? yearMatch[1] : "";
  const party = yearMatch ? rest.slice(0, -2) : rest;
  return { office, party, year };
}

// Discover unique office+year combos from voting metadata IDs
export function getOfficeYearCombos(
  votingIds: readonly string[]
): readonly { readonly office: string; readonly year: string }[] {
  const seen = new Set<string>();
  const combos: { office: string; year: string }[] = [];
  for (const id of votingIds) {
    const { office, year } = parseVotingId(id);
    const key = `${office}|${year}`;
    if (!seen.has(key)) {
      seen.add(key);
      combos.push({ office, year });
    }
  }
  // Sort by office rank (presidential, senate, governor, ...), then year
  combos.sort((a, b) => {
    const rankCompare = officeRank(a.office) - officeRank(b.office);
    if (rankCompare !== 0) return rankCompare;
    const nameCompare = officeName(a.office).localeCompare(officeName(b.office));
    if (nameCompare !== 0) return nameCompare;
    return a.year.localeCompare(b.year);
  });
  return combos;
}

/*
 * Assign nested geounit to district.
 *
 * This can require the creation of intermediate levels using the current
 * district id as we recurse more deeply.
 */
function assignNestedGeounit(
  currentDistrictsDefinition: MutableGeoUnitCollection,
  currentGeounitData: readonly number[],
  currentGeoUnitHierarchy: GeoUnitHierarchy,
  districtId: number
): MutableGeoUnitCollection {
  const [currentLevelGeounitId, ...remainingLevelsGeounitIds] = currentGeounitData;
  // Update districts definition using existing values or explode out district id using hierarchy

  let newDefinition: MutableGeoUnitCollection =
    typeof currentDistrictsDefinition === "number"
      ? // Auto-fill district ids using current value based on number of geounits at this level
        new Array(currentGeoUnitHierarchy.length).fill(currentDistrictsDefinition)
      : // Copy existing district ids at this level
        currentDistrictsDefinition;

  if (remainingLevelsGeounitIds.length) {
    // We need to go deeper...
    newDefinition[currentLevelGeounitId] = assignNestedGeounit(
      newDefinition[currentLevelGeounitId] as MutableGeoUnitCollection,
      currentGeounitData.slice(1),
      currentGeoUnitHierarchy[currentLevelGeounitId] as readonly number[],
      districtId
    );
  } else {
    // End of the line. Update value with new district id
    newDefinition[currentLevelGeounitId] = districtId;
    if (newDefinition.every(value => value === districtId)) {
      // Update district definition for this level to be just the district id
      // eg. instead of [3, 3, 3, 3, ...] for every geounit at this level, just 3
      newDefinition = districtId;
    }
  }

  return newDefinition;
}

/*
 * Return new districts definition after assigning the selected geounits to the current district
 */
export function assignGeounitsToDistrict(
  districtsDefinition: DistrictsDefinition,
  geoUnitHierarchy: GeoUnitHierarchy,
  geounitIndices: readonly GeoUnitIndices[],
  districtId: number
): DistrictsDefinition {
  const districtsDefinitionCopy = cloneDeep(districtsDefinition);
  return geounitIndices.reduce((newDistrictsDefinition, geounitData) => {
    const initialGeounitId = geounitData[0];

    newDistrictsDefinition[initialGeounitId] =
      geounitData.length === 1
        ? // Assign entire county
          districtId
        : // Need to assign nested geounit
          assignNestedGeounit(
            newDistrictsDefinition[initialGeounitId],
            geounitData.slice(1),
            geoUnitHierarchy[initialGeounitId] as NestedArray<number>,
            districtId
          );
    return newDistrictsDefinition;
  }, districtsDefinitionCopy);
}

export function getPopulationPerRepresentative(
  geojson: DistrictsGeoJSON,
  numberOfMembers: readonly number[],
  populationKey: GroupTotal = "population"
) {
  const totalPopulation = geojson.features.reduce(
    (total, feature) =>
      total +
      (feature.properties.demographics[populationKey] ??
        feature.properties.demographics.population),
    0
  );
  const totalReps = numberOfMembers.reduce((total, numberOfReps) => total + numberOfReps, 0);
  return totalPopulation / totalReps;
}

/*
 * Helper function to get exhaustiveness checking.
 *
 * See: https://www.typescriptlang.org/docs/handbook/advanced-types.html#exhaustiveness-checking
 */
export function assertNever(x: never): never {
  throw new Error(`Unexpected: ${x}`);
}

export const geoLevelLabel = (id: string): string => {
  switch (id) {
    case "county":
      return "Counties";
    default:
      return id[0].toUpperCase() + id.slice(1) + "s";
  }
};

export const geoLevelLabelSingular = (id: string): string => {
  switch (id) {
    case "county":
      return "County";
    default:
      return id[0].toUpperCase() + id.slice(1);
  }
};

export function getSelectedGeoLevel(geoLevelHierarchy: GeoLevelHierarchy, geoLevelIndex: number) {
  return geoLevelHierarchy[geoLevelHierarchy.length - 1 - geoLevelIndex];
}

export function destructureResource<T extends object, K extends keyof T>(
  resourceT: Resource<T>,
  key: K
): T[K] | undefined {
  return "resource" in resourceT ? resourceT.resource[key] : undefined;
}

export function mergeGeoUnits(a: GeoUnits, b: GeoUnits): GeoUnits {
  const geoLevels = [...new Set([...Object.keys(a), ...Object.keys(b)])];
  return Object.fromEntries(
    geoLevels.map(geoLevelId => {
      return [geoLevelId, new Map([...(a[geoLevelId] || []), ...(b[geoLevelId] || [])])];
    })
  );
}

export const showActionFailedToast = () => toast.error("Something went wrong, please try again.");
export const showResourceFailedToast = () =>
  toast.error("Something went wrong, please refresh the page.");
export const showMapActionToast = (mapAction: string) => toast.info(mapAction);

export const formatDate = (date: Date): string => {
  const d = new Date(date);
  return date
    ? isToday(d)
      ? format(d, "h:mm a")
      : isThisYear(d)
        ? format(d, "MMM d")
        : format(d, "MMM d yyyy")
    : "—";
};

type ParseResults = {
  readonly data: readonly any[];
  readonly errors: readonly unknown[];
};

export const convertCsvToGeojson = (csv: ParseResults): ReferenceLayerGeojson => {
  const geojson: FeatureCollection<Point, ReferenceLayerProperties> = {
    type: "FeatureCollection",
    features: []
  };
  for (const record of csv.data) {
    const recTransformed: Feature<Point, ReferenceLayerProperties> = {
      type: "Feature",
      properties: {},
      geometry: {
        type: "Point",
        coordinates: []
      }
    };

    recTransformed.properties = record;
    if ("lat" in record && "lon" in record) {
      recTransformed.geometry.coordinates = [Number(record.lon), Number(record.lat)];
    } else if ("latitude" in record && "longitude" in record) {
      recTransformed.geometry.coordinates = [Number(record.longitude), Number(record.latitude)];
    } else if ("x" in record && "y" in record) {
      recTransformed.geometry.coordinates = [Number(record.x), Number(record.y)];
    }

    geojson.features.push(recTransformed);
  }
  return geojson;
};

// Extends/shrinks the number of members array to match the provided number of districts
export function updateNumberOfMembers(
  numberOfDistricts: number | null,
  numberOfMembers: readonly number[] | null
): readonly number[] | null {
  return numberOfDistricts === null
    ? null
    : numberOfMembers !== null
      ? numberOfMembers.length > numberOfDistricts
        ? numberOfMembers.slice(0, numberOfDistricts)
        : numberOfMembers.concat(new Array(numberOfDistricts - numberOfMembers.length).fill(1))
      : (new Array(numberOfDistricts).fill(1) as readonly number[]);
}

export function extractErrors<D, T>(
  resource: WriteResource<D, T>,
  field: keyof D
): readonly string[] | undefined {
  return "errors" in resource && typeof resource.errors.message === "object"
    ? resource.errors.message[field]
    : undefined;
}

export function isProjectReadOnly(state: State) {
  const project: IProject | undefined = destructureResource(state.project.projectData, "project");
  return (
    !("resource" in state.user) ||
    (project !== undefined && state.user.resource.id !== project.user.id) ||
    (project !== undefined && project.regionConfig.archived) ||
    (project !== undefined && !!project.submittedDt)
  );
}
