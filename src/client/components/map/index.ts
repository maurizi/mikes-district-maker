// SPDX-License-Identifier: AGPL-3.0-or-later
// Modifications © 2026 Michael Maurizi Jr.

import { type MapGeoJSONFeature } from "maplibre-gl";
import type maplibregl from "maplibre-gl";
import { convertFilter, type ExpressionSpecification } from "@maplibre/maplibre-gl-style-spec";
import { cloneDeep } from "lodash";
import {
  type GeoUnitCollection,
  type DistrictId,
  type DistrictsDefinition,
  type FeatureId,
  type GeoLevelInfo,
  type GeoUnitIndices,
  type GeoUnits,
  type MutableGeoUnits,
  type IStaticMetadata,
  type LockedDistricts,
  type TypedArrays
} from "../../../shared/entities";
import { getAllIndices } from "../../../shared/functions";
import { isBaseGeoLevelAlwaysVisible } from "../../functions";
import { mapValues } from "lodash";
import { versionParam } from "../../s3";
import { type ChoroplethSteps, type PviBucket, type DistrictsGeoJSON } from "../../types";

// Vector tiles with geolevel data for this geography
export const GEOLEVELS_SOURCE_ID = "db";
// Always-on transparent layer that keeps the GEOLEVELS_SOURCE_ID tiles from
// being evicted while every real geolevel layer is hidden (evaluate mode).
export const GEOLEVELS_KEEPWARM_LAYER_ID = "db-keepwarm";
// GeoJSON district data for district as currently drawn
export const DISTRICTS_SOURCE_ID = "districts";
// GeoJSON district label data for district as currently drawn
export const DISTRICTS_LABELS_SOURCE_ID = "districts-labels";

// Id for districts layer
export const DISTRICTS_LAYER_ID = "districts";
// Id for districts layer outline, used for Find
export const DISTRICTS_FIND_OUTLINE_LAYER_ID = "districts-outline-find";
// Id for districts layer outline, used for Evaluate mode
export const DISTRICTS_EVALUATE_OUTLINE_LAYER_ID = "districts-outline-eval";
// Id for districts layer outline, used for selection from sidebar
export const DISTRICTS_SELECTED_OUTLINE_LAYER_ID = "districts-outline-selected";
// Id for districts layer outline, used for hover from sidebar
export const DISTRICTS_HOVER_OUTLINE_LAYER_ID = "districts-outline-hover";
// Id for districts lock layer
export const DISTRICTS_LOCK_LAYER_ID = "districts-locked";
// Id for districts fill outline used in evaluate mode
export const DISTRICTS_CONTIGUITY_CHLOROPLETH_LAYER_ID = "districts-contiguity";
// Id for districts layer outline used in evaluate mode
export const DISTRICTS_COMPACTNESS_CHOROPLETH_LAYER_ID = "districts-compactness";
// Id for districts layer outline used in evaluate mode
export const DISTRICTS_COMPETITIVENESS_CHOROPLETH_LAYER_ID = "districts-competitiveness";
// Id for districts layer outline used in evaluate mode
export const DISTRICTS_EQUAL_POPULATION_CHOROPLETH_LAYER_ID = "districts-equal-population";
// Id for districts layer outline used in evaluate mode
export const DISTRICTS_MAJORITY_RACE_CHOROPLETH_LAYER_ID = "districts-majority-race";
// Id for district labels layer used in evaluate mode
export const DISTRICTS_EVALUATE_LABELS_LAYER_ID = "districts-evaluate-labels";
// Id for topmost geolevel layer in Evaluate
export const TOPMOST_GEOLEVEL_EVALUATE_SPLIT_ID = "topmost-geo-evaluate-split";
// Id for topmost geolevel layer fill in Evaluate
export const TOPMOST_GEOLEVEL_EVALUATE_FILL_SPLIT_ID = "topmost-geo-evaluate-split-fill";
import { FIRST_LABEL_LAYER_ID } from "../../constants/map";

// Delay used to throttle calls to set the current feature(s), in milliseconds
export const SET_FEATURE_DELAY = 300;
export const CONTIGUITY_FILL_COLOR = "#9400D3";
export const EVALUATE_GRAY_FILL_COLOR = "#D3D3D3";
export const COUNTY_SPLIT_FILL_COLOR = "#fed8b1";

// Layers in the Mapbox Studio project that we filter to only show the active region.
// Protomaps label layers to filter by region (show only labels for the selected state).
// These correspond to Protomaps theme layer IDs.
export const filteredLabelLayers = [
  "places_subplace",
  "places_locality",
  "places_locality_circle",
  "pois"
];

// Build a maplibre "step" expression from legacy interval stops, reading the
// district value from feature-state. The first stop's color is the base
// bucket (values below the first real threshold); each later [threshold,
// color] pair becomes a step boundary. Mirrors the old { type: "interval" }
// data-driven function. The ["number", …, 0] guard keeps districts whose
// value is unset (e.g. percentDeviation on the unassigned district) from
// throwing an expression error — step requires a numeric input.
function choroplethStep(prop: string, stops: ChoroplethSteps): ExpressionSpecification {
  const boundaries = stops.slice(1).flatMap(([threshold, color]) => [threshold, color]);
  return [
    "step",
    ["number", ["feature-state", prop], 0],
    stops[0][1],
    ...boundaries
  ] as ExpressionSpecification;
}

export function getCompactnessStops(): ChoroplethSteps {
  return [
    [0.3, "#edf8fb"],
    [0.4, "#b2e2e2"],
    [0.5, "#66c2a4"],
    [0.6, "#2ca25f"],
    [1.0, "#006d2c"]
  ];
}

export function getCompactnessLabels() {
  return ["0-30%", "30-40%", "40-50%", "50-60%", ">60%"];
}

export function getPviSteps(): ChoroplethSteps {
  return [
    [-100, "#a52a0d"],
    [-20, "#ed512c"],
    [-5, "#cdcdcd"],
    [5, "#6491b5"],
    [20, "#385d7a"]
  ];
}

export function getPviLabels() {
  return ["> +20R", "+5R to +20R", "Even", "+5D to +20D", "> +20D"];
}

export function getPviBuckets(): readonly PviBucket[] {
  return [
    {
      name: "R",
      label: "> +20R",
      color: "#a52a0d"
    },
    {
      name: "Lean R",
      label: "+5R to +20R",
      color: "#ed512c"
    },
    {
      name: "Even",
      label: "+5R to +20R",
      color: "#CDCDCD"
    },
    {
      name: "Lean D",
      label: "+5D to +20D",
      color: "#6491b5"
    },
    {
      name: "D",
      label: "> +20D",
      color: "#385d7a"
    }
  ];
}

export function getEqualPopulationStops(popThresholdNum: number): ChoroplethSteps {
  const popThreshold = popThresholdNum / 100;
  return [
    [-1.0, "#c1e5f0"],
    [-1 * (popThreshold + 0.02), "#66a9cf"],
    [-1 * (popThreshold + 0.01), "#2166ac"],
    [popThreshold === 0 ? -1 * Number.MIN_VALUE : -1 * popThreshold, "#01665e"],
    [popThreshold === 0 ? Number.MIN_VALUE : popThreshold, "#efbe60"],
    [popThreshold + 0.01, "#f5d092"],
    [popThreshold + 0.02, "#f7e1c3"]
  ];
}

export function getMajorityRaceSplitFill(majorityRace: string, majorityRaceSplit: number): string {
  const fills = getMajorityRaceFills();
  return fills[majorityRace]
    ? majorityRaceSplit > 65
      ? fills[majorityRace][0]
      : fills[majorityRace][1]
    : "#ffffff";
}

export function getMajorityRaceFills(): { readonly [id: string]: readonly [string, string] } {
  return {
    white: ["#4a9dd4", "#aac3d4"],
    black: ["#8dd3c5", "#c4e8e1"],
    asian: ["#fdb35c", "#fcead6"],
    hispanic: ["#cf6ade", "#dabdde"],
    "minority coalition": ["#898989", "#ebe8eb"]
  };
}

export function getEqualPopulationLabels(popThreshold: number) {
  return [
    [`< ${Math.ceil(-1 * (popThreshold + 2))}%`],
    [`${-1 * Math.ceil(popThreshold + 2)}% to ${-1 * Math.ceil(popThreshold + 1)}%`],
    [`${-1 * Math.ceil(popThreshold + 1)}% to ${-1 * Math.ceil(popThreshold)}%`],
    [popThreshold !== 0 ? `Target (+/- ${Math.floor(popThreshold)}%)` : `Target (0%)`],
    [`${Math.floor(popThreshold)}% to ${Math.floor(popThreshold + 1)}%`],
    [`${Math.floor(popThreshold + 1)}% to ${Math.floor(popThreshold + 2)}%`],
    [`> ${Math.floor(popThreshold + 2)}%`]
  ];
}

export function getGeolevelLinePaintStyle(geoLevel: string) {
  const largeGeolevel: maplibregl.LineLayerSpecification["paint"] = {
    "line-color": "#000",
    "line-opacity": 1,
    "line-width": ["interpolate", ["linear"], ["zoom"], 6, 2.5, 14, 6]
  };

  const mediumGeolevel: maplibregl.LineLayerSpecification["paint"] = {
    "line-color": "#000",
    "line-opacity": ["interpolate", ["linear"], ["zoom"], 6, 0.3, 14, 0.7],
    "line-width": ["interpolate", ["linear"], ["zoom"], 6, 1.5, 14, 3.5]
  };

  const smallGeolevel: maplibregl.LineLayerSpecification["paint"] = {
    "line-color": "#000",
    "line-opacity": ["interpolate", ["linear"], ["zoom"], 6, 0.15, 14, 0.4],
    "line-width": ["interpolate", ["linear"], ["zoom"], 6, 0.5, 14, 2.5]
  };

  switch (geoLevel) {
    case "county":
      return largeGeolevel;
    case "tract":
      return mediumGeolevel;
    case "blockgroup":
      return mediumGeolevel;
    case "block":
      return smallGeolevel;
    default:
      return smallGeolevel;
  }
}

export function generateMapLayers(
  path: string,
  version: Date | string | number,
  regionCode: string,
  bbox: readonly [number, number, number, number],
  geoLevels: readonly GeoLevelInfo[],
  minZoom: number,
  maxZoom: number,
  map: maplibregl.Map,
  geojson: DistrictsGeoJSON,
  populationDeviation: number
) {
  // Insert district layers below the first label layer so basemap labels stay on top
  const beforeLabelId = FIRST_LABEL_LAYER_ID;
  map.addSource(DISTRICTS_SOURCE_ID, {
    type: "geojson",
    data: geojson
  });

  // Single source for all geolevels — keeps shared arcs aligned across layers.
  // All layers exist at all zoom levels (from their minZoom up to the global max)
  // so overzoom works naturally and boundaries stay perfectly aligned.
  // ?v=<timestamp> cache-buster so a republished region invalidates CloudFront
  // entries even when path is reused — pmtiles range requests preserve the
  // query string.
  map.addSource(GEOLEVELS_SOURCE_ID, {
    type: "vector",
    url: `pmtiles://${window.location.origin}/${path}tiles.pmtiles?v=${versionParam(version)}`,
    minzoom: minZoom,
    maxzoom: maxZoom
  });

  map.addSource(DISTRICTS_LABELS_SOURCE_ID, {
    type: "geojson",
    data: {
      type: "FeatureCollection",
      features: []
    }
  });

  // Keep-warm layer: maplibre evicts a vector source's cached tiles once no
  // visible layer consumes it. Evaluate mode hides every geolevel layer, so
  // returning to edit mode would re-download all `db` tiles. This always-on,
  // fully transparent line layer keeps the source's tiles loaded without
  // rendering anything. It must never be set to visibility:none.
  map.addLayer(
    {
      id: GEOLEVELS_KEEPWARM_LAYER_ID,
      type: "line",
      source: GEOLEVELS_SOURCE_ID,
      "source-layer": geoLevels[0].id,
      paint: { "line-opacity": 0 }
    },
    beforeLabelId
  );

  map.addLayer(
    {
      id: DISTRICTS_LAYER_ID,
      type: "fill",
      source: DISTRICTS_SOURCE_ID,
      layout: {},
      paint: {
        // coalesce fallback: maplibre's worker evaluates paint expressions
        // at tile-populate time with empty feature-state, so a bare
        // ["feature-state", …] yields null and fails color parsing. The
        // real per-district color is applied at render time from the
        // feature-state the Map.tsx per-feature loop sets.
        "fill-color": ["coalesce", ["feature-state", "color"], "transparent"],
        "fill-opacity": ["interpolate", ["linear"], ["zoom"], 6, 0.66, 14, 0.45],
        "fill-antialias": false
      }
    },
    beforeLabelId
  );

  map.addLayer(
    {
      id: DISTRICTS_COMPACTNESS_CHOROPLETH_LAYER_ID,
      type: "fill",
      source: DISTRICTS_SOURCE_ID,
      layout: { visibility: "none" },
      filter: ["match", ["get", "color"], ["transparent"], false, true],
      paint: {
        "fill-color": choroplethStep("compactness", getCompactnessStops()),
        "fill-outline-color": "gray",
        "fill-opacity": 0.9
      }
    },
    beforeLabelId
  );

  map.addLayer(
    {
      id: DISTRICTS_COMPETITIVENESS_CHOROPLETH_LAYER_ID,
      type: "fill",
      source: DISTRICTS_SOURCE_ID,
      layout: { visibility: "none" },
      filter: ["match", ["get", "color"], ["transparent"], false, true],
      paint: {
        "fill-color": choroplethStep("pvi", getPviSteps()),
        "fill-outline-color": "gray",
        "fill-opacity": 0.9
      }
    },
    beforeLabelId
  );

  map.addLayer(
    {
      id: DISTRICTS_MAJORITY_RACE_CHOROPLETH_LAYER_ID,
      type: "fill",
      source: DISTRICTS_SOURCE_ID,
      layout: { visibility: "none" },
      filter: ["match", ["get", "color"], ["transparent"], false, true],
      paint: {
        // coalesce fallback — see DISTRICTS_LAYER_ID fill-color.
        "fill-color": ["coalesce", ["feature-state", "majorityRaceFill"], "transparent"],
        "fill-outline-color": "gray",
        "fill-opacity": 0.9
      }
    },
    beforeLabelId
  );

  map.addLayer(
    {
      id: DISTRICTS_EQUAL_POPULATION_CHOROPLETH_LAYER_ID,
      type: "fill",
      source: DISTRICTS_SOURCE_ID,
      layout: { visibility: "none" },
      filter: ["match", ["get", "color"], ["transparent"], false, true],
      paint: {
        "fill-color": choroplethStep(
          "percentDeviation",
          getEqualPopulationStops(populationDeviation)
        ),
        "fill-outline-color": "gray",
        "fill-opacity": 0.9
      }
    },
    beforeLabelId
  );

  map.addLayer(
    {
      id: DISTRICTS_FIND_OUTLINE_LAYER_ID,
      type: "line",
      source: DISTRICTS_SOURCE_ID,
      paint: {
        // coalesce fallback — see DISTRICTS_LAYER_ID fill-color.
        "line-color": ["coalesce", ["feature-state", "findOutlineColor"], "transparent"],
        "line-opacity": 1,
        "line-dasharray": [5, 5],
        // Width is scaled by findMenuOpen (1× when the find menu is open,
        // 2× otherwise). That factor is uniform across all districts, and
        // maplibre forbids feature-state inside a zoom curve, so Map.tsx
        // drives it with setPaintProperty instead. The baked-in values are
        // the menu-closed (2×) state.
        "line-width": ["interpolate", ["linear"], ["zoom"], 6, 4, 14, 10]
      }
    },
    beforeLabelId
  );

  map.addLayer(
    {
      id: DISTRICTS_EVALUATE_OUTLINE_LAYER_ID,
      type: "line",
      source: DISTRICTS_SOURCE_ID,
      paint: {
        "line-color": "#000",
        "line-opacity": 1,
        "line-width": ["interpolate", ["linear"], ["zoom"], 6, 2, 14, 5]
      }
    },
    beforeLabelId
  );

  map.addLayer(
    {
      id: DISTRICTS_HOVER_OUTLINE_LAYER_ID,
      type: "line",
      source: DISTRICTS_SOURCE_ID,
      paint: {
        "line-color": "transparent",
        "line-opacity": 1,
        // Width is scaled by findMenuOpen (1× when the find menu is open,
        // 2× otherwise). That factor is uniform across all districts, and
        // maplibre forbids feature-state inside a zoom curve, so Map.tsx
        // drives it with setPaintProperty instead. The baked-in values are
        // the menu-closed (2×) state.
        "line-width": ["interpolate", ["linear"], ["zoom"], 6, 4, 14, 10]
      }
    },
    DISTRICTS_FIND_OUTLINE_LAYER_ID
  );

  map.addLayer(
    {
      id: DISTRICTS_SELECTED_OUTLINE_LAYER_ID,
      type: "line",
      source: DISTRICTS_SOURCE_ID,
      paint: {
        "line-color": "transparent",
        "line-opacity": 1,
        // Width is scaled by findMenuOpen (1× when the find menu is open,
        // 2× otherwise). That factor is uniform across all districts, and
        // maplibre forbids feature-state inside a zoom curve, so Map.tsx
        // drives it with setPaintProperty instead. The baked-in values are
        // the menu-closed (2×) state.
        "line-width": ["interpolate", ["linear"], ["zoom"], 6, 4, 14, 10]
      }
    },
    DISTRICTS_HOVER_OUTLINE_LAYER_ID
  );

  // Create the locked district pattern if it doesn't exist in the sprite sheet
  if (!map.hasImage("circle-1")) {
    const size = 16;
    const data = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = (y * size + x) * 4;
        const cx = x - size / 2;
        const cy = y - size / 2;
        const inCircle = cx * cx + cy * cy < 4;
        data[i] = 0;
        data[i + 1] = 0;
        data[i + 2] = 0;
        data[i + 3] = inCircle ? 80 : 0;
      }
    }
    map.addImage("circle-1", { width: size, height: size, data });
  }

  map.addLayer(
    {
      id: DISTRICTS_LOCK_LAYER_ID,
      type: "fill",
      source: DISTRICTS_SOURCE_ID,
      layout: {},
      paint: {
        "fill-pattern": "circle-1",
        "fill-opacity": ["case", ["boolean", ["feature-state", "locked"], false], 1, 0]
      }
    },
    beforeLabelId
  );

  map.addLayer(
    {
      id: TOPMOST_GEOLEVEL_EVALUATE_SPLIT_ID,
      type: "line",
      source: GEOLEVELS_SOURCE_ID,
      "source-layer": geoLevels[geoLevels.length - 1].id,
      layout: { visibility: "none" },
      paint: {
        "line-color": "#D3D3D3",
        "line-opacity": 1,
        "line-width": ["interpolate", ["linear"], ["zoom"], 6, 2, 14, 5]
      }
    },
    beforeLabelId
  );

  map.addLayer(
    {
      id: TOPMOST_GEOLEVEL_EVALUATE_FILL_SPLIT_ID,
      source: GEOLEVELS_SOURCE_ID,
      type: "fill",
      "source-layer": geoLevels[geoLevels.length - 1].id,
      layout: { visibility: "none" },
      paint: {
        "fill-color": "#fed8b1",
        "fill-opacity": ["case", ["boolean", ["feature-state", "split"], false], 0.5, 0.0],
        "fill-antialias": false
      }
    },
    beforeLabelId
  );

  map.addLayer(
    {
      id: DISTRICTS_CONTIGUITY_CHLOROPLETH_LAYER_ID,
      type: "fill",
      source: DISTRICTS_SOURCE_ID,
      layout: { visibility: "none" },
      filter: ["match", ["get", "color"], ["transparent"], false, true],
      paint: {
        "fill-color": [
          "match",
          ["feature-state", "contiguity"],
          "contiguous",
          CONTIGUITY_FILL_COLOR,
          "non-contiguous",
          EVALUATE_GRAY_FILL_COLOR,
          "black"
        ],
        "fill-opacity": ["interpolate", ["linear"], ["zoom"], 6, 0.66, 14, 0.45],
        "fill-antialias": false
      }
    },
    beforeLabelId
  );

  map.addLayer({
    id: DISTRICTS_EVALUATE_LABELS_LAYER_ID,
    type: "symbol",
    source: DISTRICTS_LABELS_SOURCE_ID,
    layout: {
      "text-size": 12,
      "text-padding": 3,
      "text-field": ["concat", regionCode, "-", ["get", "id"]],
      "text-max-width": 10,
      "text-font": ["Noto Sans Medium"],
      visibility: "visible"
    },
    paint: {
      "text-color": "#000",
      "text-opacity": 0.9,
      "text-halo-color": "#fff",
      "text-halo-width": 1.25,
      "text-halo-blur": 0
    }
  });

  geoLevels.forEach(level => {
    map.addLayer(
      {
        id: levelToLineLayerId(level.id),
        type: "line",
        source: GEOLEVELS_SOURCE_ID,
        "source-layer": level.id,
        layout: { visibility: "none" },
        paint: getGeolevelLinePaintStyle(level.id)
      },
      DISTRICTS_SELECTED_OUTLINE_LAYER_ID
    );
  });

  geoLevels.forEach(level => {
    map.addLayer(
      {
        id: levelToSelectionLayerId(level.id),
        type: "fill",
        source: GEOLEVELS_SOURCE_ID,
        "source-layer": level.id,
        paint: {
          "fill-color": "#000",
          "fill-opacity": ["case", ["boolean", ["feature-state", "selected"], false], 0.5, 0],
          "fill-antialias": false
        }
      },
      beforeLabelId
    );
  });

  geoLevels.forEach(level => {
    map.addLayer({
      id: levelToLabelLayerId(level.id),
      type: "symbol",
      source: GEOLEVELS_SOURCE_ID,
      "source-layer": `${level.id}labels`,
      layout: {
        "text-size": 13,
        "text-padding": 2,
        "text-field": "",
        "text-max-width": 10,
        "text-font": ["Noto Sans Medium"],
        visibility: "none"
      },
      paint: {
        "text-color": "#222",
        "text-opacity": 1,
        "text-halo-color": "#fff",
        "text-halo-width": 1,
        "text-halo-blur": 0
      }
    });
  });

  // Hide the basemap label layers until the dissolved region outline is ready.
  // Otherwise labels load everywhere first and outside-state ones vanish in a
  // visible second pass; hiding upfront lets inside-state labels just pop in.
  hideFilteredLabelLayers(map);
}

// Set the filtered basemap label layers to invisible. Used on initial layer
// setup and after a basemap swap that happens before the region outline is
// ready, so labels don't appear globally before being filtered.
export function hideFilteredLabelLayers(map: maplibregl.Map) {
  filteredLabelLayers.forEach(layer => {
    if (!map.getLayer(layer)) return;
    map.setLayoutProperty(layer, "visibility", "none");
  });
}

export function bboxToPolygon(bbox: readonly [number, number, number, number]): GeoJSON.Polygon {
  const [minLng, minLat, maxLng, maxLat] = bbox;
  return {
    type: "Polygon",
    coordinates: [
      [
        [minLng, minLat],
        [maxLng, minLat],
        [maxLng, maxLat],
        [minLng, maxLat],
        [minLng, minLat]
      ]
    ]
  };
}

// Cache of each filtered layer's Protomaps-original filter, keyed by layer id.
// Populated on first apply. Subsequent calls re-wrap the original instead of
// the already-wrapped current filter, which avoids nested wrappers when the
// geometry upgrades (bbox → dissolved outline) or a basemap swap restores the
// original (keeping our cache consistent with the freshly restored filter).
const originalLabelFilters = new Map<string, maplibregl.FilterSpecification | null | undefined>();

// Wrap each basemap label layer's filter with a point-in-polygon check so only
// labels inside the active region render. Protomaps' `places` and `pois` tiles
// carry no region attribute, so we key off geometry via MapLibre's `within`
// expression. Called on initial layer setup, after a basemap swap (which
// restores Protomaps' originals), and once the dissolved region outline has
// been computed (upgrading the bbox polygon to the precise outline).
export function applyLabelRegionFilter(
  map: maplibregl.Map,
  geometry: GeoJSON.Polygon | GeoJSON.MultiPolygon
) {
  const within = ["within", geometry];
  filteredLabelLayers.forEach(layer => {
    if (!map.getLayer(layer)) return;
    if (!originalLabelFilters.has(layer)) {
      originalLabelFilters.set(
        layer,
        (map.getFilter(layer) ?? null) as maplibregl.FilterSpecification | null
      );
    }
    const original = originalLabelFilters.get(layer);
    // `within` is expression-only and Protomaps ships legacy-style filters,
    // which can't mix under a shared `all`. Normalize to expression form.
    const originalExpr = original ? convertFilter(original) : true;
    const merged = ["all", within, originalExpr] as unknown as maplibregl.FilterSpecification;
    try {
      map.setFilter(layer, merged);
    } catch {
      // Leave the original filter in place if merging produced an invalid spec.
    }
    map.setLayoutProperty(layer, "visibility", "visible");
  });
}

// Retuns a label layer id given the geolevel
export function levelToLabelLayerId(geoLevel: string) {
  return `${geoLevel}-label`;
}

// Retuns a line layer id given the geolevel
export function levelToLineLayerId(geoLevel: string) {
  return `${geoLevel}-line`;
}

// Retuns a selection layer id given the geolevel
export function levelToSelectionLayerId(geoLevel: string) {
  return `${geoLevel}-selected`;
}

type FeatureLike = Pick<maplibregl.MapGeoJSONFeature, "id" | "sourceLayer">;

/*
 * Used for getting/setting feature state for geounits in geography.
 */
export function featureStateGeoLevel(feature: FeatureLike) {
  return {
    source: GEOLEVELS_SOURCE_ID,
    id: feature.id,
    sourceLayer: feature.sourceLayer
  };
}

/*
 * Used for getting/setting feature state for districts.
 */
export function featureStateDistricts(districtId: DistrictId) {
  return {
    source: DISTRICTS_SOURCE_ID,
    id: districtId
  };
}

export function isFeatureSelected(map: maplibregl.Map, feature: FeatureLike): boolean {
  const featureState = map.getFeatureState(featureStateGeoLevel(feature));
  return featureState.selected === true;
}

export function getCurrentCountyFromGeoUnits(
  staticMetadata: IStaticMetadata,
  geoUnits: GeoUnits
): number | undefined {
  const geoLevelIds = staticMetadata.geoLevelHierarchy.map(geoLevel => geoLevel.id);

  for (let i = 0; i < geoLevelIds.length; i++) {
    const geoLevelId = geoLevelIds[i];
    const value = geoUnits[geoLevelId]?.entries().next().value;
    if (value) {
      return value[1][0];
    }
  }
}

/*
 * Returns true if this geounit or any of its children are locked.
 */
function isGeoUnitLocked(
  districtsDefinition: GeoUnitCollection,
  lockedDistricts: LockedDistricts,
  geoUnitIndices: GeoUnitIndices
): boolean {
  return geoUnitIndices.length && typeof districtsDefinition === "object"
    ? isGeoUnitLocked(
        districtsDefinition[geoUnitIndices[0]],
        lockedDistricts,
        geoUnitIndices.slice(1)
      )
    : typeof districtsDefinition === "number"
      ? // Check if this specific district is locked
        lockedDistricts[districtsDefinition - 1]
      : // Check if any district at this geolevel is locked
        districtsDefinition.some(districtId =>
          typeof districtId === "number"
            ? // Whole district is assigned so it can be looked up directly
              lockedDistricts[districtId - 1]
            : // District definition has more nesting so it must be followed further
              isGeoUnitLocked(districtId, lockedDistricts, geoUnitIndices)
        );
}

export function setFeaturesSelectedFromGeoUnits(
  map: maplibregl.Map,
  geoUnits: GeoUnits,
  selected: boolean
) {
  Object.entries(geoUnits).forEach(([geoLevelId, geoUnitsForLevel]) => {
    [...geoUnitsForLevel.keys()].forEach(featureId => {
      const currentFeature = { id: featureId, sourceLayer: geoLevelId };
      map.setFeatureState(featureStateGeoLevel(currentFeature), { selected });
    });
  });
}

/*
 * Filters geounits to only those contained within the specified top-level geounit (usually county, but potentially something else such as ward or block group)
 */
export function filterGeoUnitsByCounty(units: GeoUnits, county: number) {
  return mapValues(units, function (geoUnitsForLevel) {
    return new Map([
      ...Array.from(geoUnitsForLevel).filter(geounit => {
        return geounit[1][0] === county;
      })
    ]);
  });
}

/*
 * Filter matching geounits given an include function
 */
export function filterGeoUnits(units: GeoUnits, includeFn: (id: number) => boolean) {
  return Object.entries(units).reduce((newGeoUnits, [geoLevelId, geoUnitsForLevel]) => {
    return {
      ...newGeoUnits,
      [geoLevelId]: new Map([...geoUnitsForLevel].filter(([id]) => includeFn(id)))
    };
  }, units);
}

export function deselectChildGeounits(
  map: maplibregl.Map,
  geoUnits: GeoUnits,
  staticMetadata: IStaticMetadata,
  staticGeoLevels: TypedArrays
) {
  const isBaseLevelAlwaysVisible = isBaseGeoLevelAlwaysVisible(staticMetadata.geoLevelHierarchy);

  // Deselect any child features as appropriate (this comes into a play when, for example, a
  // blockgroup is selected and then the county _containing_ that blockgroup is selected)
  Object.values(geoUnits).forEach(geoUnitsForLevel => {
    geoUnitsForLevel.forEach(geoUnitIndices => {
      // Ignore bottom geolevel, because it can't have sub-features. And if the base geolevel
      // is not always visible, we can also ignore one additional geolevel, because these base
      // geounits can't be selected at the same time as features from one geolevel up).
      const numLevelsToIgnore = isBaseLevelAlwaysVisible ? 1 : 2;

      if (geoUnitIndices.length <= staticMetadata.geoLevelHierarchy.length - numLevelsToIgnore) {
        const { childGeoUnits } = getChildGeoUnits(geoUnitIndices, staticMetadata, staticGeoLevels);
        setFeaturesSelectedFromGeoUnits(map, childGeoUnits, false);
      }
    });
  });
}

export function getGeoLevelVisibility(
  map: maplibregl.Map,
  staticMetadata: IStaticMetadata
): readonly boolean[] {
  const mapZoom = map.getZoom();
  return staticMetadata.geoLevelHierarchy
    .slice()
    .reverse()
    .map(geoLevel => mapZoom >= geoLevel.minZoom);
}

export interface ISelectionTool {
  enable: (map: maplibregl.Map, ...args: any[]) => void;

  disable: (map: maplibregl.Map, ...args: any[]) => void;
  setCursor?: () => void;
  unsetCursor?: () => void;
  clickHandler?: (e: maplibregl.MapMouseEvent) => void;
  mouseDown?: (e: MouseEvent) => void;
}

/*
 * Return GeoUnits for given features.
 *
 * Note that this doesn't take whether a feature is locked or not into account. If the features
 * could possibly be locked then `featuresToUnlockedGeoUnits` should be used.
 */
export function featuresToGeoUnits(
  features: readonly MapGeoJSONFeature[],
  geoLevelHierarchy: readonly GeoLevelInfo[]
): GeoUnits {
  const geoLevelIds = geoLevelHierarchy.map(geoLevel => geoLevel.id);
  const geoLevelHierarchyKeys = ["idx", ...geoLevelIds.map(geoLevelId => `${geoLevelId}Idx`)];
  return geoLevelIds.reduce((geounitData: GeoUnits, geoLevelId) => {
    // Map is used here instead of Set because Sets don't work well for handling
    // objects (multiple copies of an object with the same values can exist in
    // the same set). Here the feature id is used as the key which we also want
    // to keep track of for map management. Note that if keys are duplicated the
    // value set last will be used (thus achieving the uniqueness of sets).
    return {
      ...geounitData,
      [geoLevelId]: new Map(
        features
          .filter(feature => feature.sourceLayer === geoLevelId)
          .map((feature: MapGeoJSONFeature) => [
            feature.id as FeatureId,
            geoLevelHierarchyKeys.reduce(
              (geounitData, key) => {
                const geounitId = feature.properties && feature.properties[key];
                return geounitId !== undefined && geounitId !== null
                  ? [geounitId, ...geounitData]
                  : geounitData;
              },
              [] as readonly number[]
            )
          ])
      )
    };
  }, {});
}

/*
 * Return child geounits (direct descendents-only)
 */
export function getChildGeoUnits(
  geoUnitIndices: GeoUnitIndices,
  staticMetadata: IStaticMetadata,
  staticGeoLevels: TypedArrays
) {
  const childGeoLevelIdx = staticMetadata.geoLevelHierarchy.length - geoUnitIndices.length - 1;
  const childGeoLevel = staticMetadata.geoLevelHierarchy[childGeoLevelIdx];
  if (!childGeoLevel) {
    return {
      childGeoLevel,
      childGeoUnitIds: [],
      childGeoUnits: {}
    };
  } else {
    const geoUnitIdx = geoUnitIndices[0];
    const childGeoUnitIds = getAllIndices(staticGeoLevels[childGeoLevelIdx], new Set([geoUnitIdx]));
    const childGeoUnits = {
      [childGeoLevel.id]: new Map(
        childGeoUnitIds.map((id, index) => [id, [...geoUnitIndices, index]])
      )
    };
    return { childGeoLevel, childGeoUnitIds, childGeoUnits };
  }
}

export function onlyUnlockedGeoUnits(
  districtsDefinition: DistrictsDefinition,
  lockedDistricts: LockedDistricts,
  geoUnits: GeoUnits,
  staticMetadata: IStaticMetadata,
  staticGeoLevels: TypedArrays
): GeoUnits {
  const unlockedGeoUnits = cloneDeep(geoUnits) as MutableGeoUnits;
  removeLockedGeoUnits(
    districtsDefinition,
    lockedDistricts,
    unlockedGeoUnits,
    staticMetadata,
    staticGeoLevels
  );
  return unlockedGeoUnits;
}

/*
 * Recursively remove locked geounits in-place, adding any unlocked children along the way.
 */
export function removeLockedGeoUnits(
  districtsDefinition: DistrictsDefinition,
  lockedDistricts: LockedDistricts,
  geoUnits: MutableGeoUnits,
  staticMetadata: IStaticMetadata,
  staticGeoLevels: TypedArrays
) {
  Object.entries(geoUnits).forEach(([geoLevel, geoUnitsForLevel]) => {
    geoUnitsForLevel.forEach((geoUnitIndices, featureId) => {
      if (isGeoUnitLocked(districtsDefinition, lockedDistricts, geoUnitIndices)) {
        // Remove locked geounit

        geoUnits[geoLevel].delete(featureId);

        if (geoUnitIndices.length < staticMetadata.geoLevelHierarchy.length - 1) {
          // This geounit's children are not base geounits, so they may be selected.
          // Add any unlocked sub-geounits to allow for partial selection.
          const { childGeoLevel, childGeoUnits } = getChildGeoUnits(
            geoUnitIndices,
            staticMetadata,
            staticGeoLevels
          );
          childGeoUnits[childGeoLevel.id].forEach((childGeoUnitIndices, childFeatureId) => {
            geoUnits[childGeoLevel.id].set(childFeatureId, childGeoUnitIndices);
          });
          removeLockedGeoUnits(
            districtsDefinition,
            lockedDistricts,
            geoUnits,
            staticMetadata,
            staticGeoLevels
          );
        }
      }
    });
  });
}

export function featuresToUnlockedGeoUnits(
  features: readonly MapGeoJSONFeature[],
  staticMetadata: IStaticMetadata,
  districtsDefinition: DistrictsDefinition,
  lockedDistricts: LockedDistricts,
  staticGeoLevels: TypedArrays
): GeoUnits {
  return onlyUnlockedGeoUnits(
    districtsDefinition,
    lockedDistricts,
    featuresToGeoUnits(features, staticMetadata.geoLevelHierarchy),
    staticMetadata,
    staticGeoLevels
  );
}
