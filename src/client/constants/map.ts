import { Protocol } from "pmtiles";
import maplibregl from "maplibre-gl";
import { noLabels, labels } from "protomaps-themes-base";

// Register the PMTiles protocol with MapLibre
const protocol = new Protocol();
maplibregl.addProtocol("pmtiles", protocol.tile);

// Self-hosted Protomaps basemap tiles on S3
const PMTILES_URL =
  "https://districtbuilder-dev-238046523378.s3.amazonaws.com/basemap/us.pmtiles";

const baseLayers = noLabels("protomaps", "white");
const labelLayers = labels("protomaps", "white", "en");

// The first label layer ID — district layers should be inserted before this
// so basemap labels (place names, roads) render on top of districts
export const FIRST_LABEL_LAYER_ID = labelLayers[0]?.id;

export const MAP_STYLE: maplibregl.StyleSpecification = {
  version: 8 as const,
  glyphs: "https://protomaps.github.io/basemaps-assets/fonts/{fontstack}/{range}.pbf",
  sprite: "https://protomaps.github.io/basemaps-assets/sprites/v4/white",
  sources: {
    protomaps: {
      type: "vector" as const,
      url: `pmtiles://${PMTILES_URL}`,
      attribution:
        '<a href="https://protomaps.com">Protomaps</a> | <a href="https://openstreetmap.org">© OpenStreetMap</a>'
    }
  },
  layers: [
    ...baseLayers,
    // District layers will be inserted here at runtime via beforeId: FIRST_LABEL_LAYER_ID
    ...labelLayers
  ] as maplibregl.LayerSpecification[]
};
