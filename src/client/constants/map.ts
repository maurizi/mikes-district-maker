// SPDX-License-Identifier: AGPL-3.0-or-later
// Modifications © 2026 Michael Maurizi Jr.

import { Protocol } from "pmtiles";
import maplibregl from "maplibre-gl";
import { noLabels, labels } from "protomaps-themes-base";

// Register the PMTiles protocol with MapLibre
const protocol = new Protocol();
maplibregl.addProtocol("pmtiles", protocol.tile);

// Self-hosted Protomaps basemap tiles served same-origin: CloudFront in prod
// fronts the S3 object at /basemap/us.pmtiles. In dev,
// __REGION_ARTIFACTS_ORIGIN__ (injected by vite.config.ts) points the
// fetch at CloudFront directly so it bypasses the slow Node proxy.
declare const __REGION_ARTIFACTS_ORIGIN__: string;
const PMTILES_BASE = __REGION_ARTIFACTS_ORIGIN__ || window.location.origin;
const PMTILES_URL = `${PMTILES_BASE}/basemap/us.pmtiles`;

const SPRITE_BASE = "https://protomaps.github.io/basemaps-assets/sprites/v4";

// Protomaps' default label paints work on a plain basemap but struggle over
// translucent district fills — the text color is low-contrast and the halo is
// a hairline. In dark mode the labels are especially hard to read. Force a
// brighter text color and a thicker halo per mode so place names stay legible
// on any district background.
const withLabelHalos = (
  layers: maplibregl.LayerSpecification[],
  flavor: "white" | "dark"
): maplibregl.LayerSpecification[] => {
  const haloColor = flavor === "dark" ? "#15181c" : "#ffffff";
  const textColor = flavor === "dark" ? "#d0d4d8" : "#2c2c2c";
  return layers.map(layer => {
    if (layer.type !== "symbol") {
      return layer;
    }
    return {
      ...layer,
      paint: {
        ...layer.paint,
        "text-color": textColor,
        "text-halo-color": haloColor,
        "text-halo-width": 1.5,
        "text-halo-blur": 0.5
      }
    };
  });
};

const buildStyle = (flavor: "white" | "dark"): maplibregl.StyleSpecification => ({
  version: 8 as const,
  glyphs: "https://protomaps.github.io/basemaps-assets/fonts/{fontstack}/{range}.pbf",
  sprite: `${SPRITE_BASE}/${flavor}`,
  sources: {
    protomaps: {
      type: "vector" as const,
      url: `pmtiles://${PMTILES_URL}`,
      attribution:
        '<a href="https://protomaps.com">Protomaps</a> | <a href="https://openstreetmap.org">© OpenStreetMap</a>'
    }
  },
  layers: [
    ...noLabels("protomaps", flavor),
    // District layers will be inserted here at runtime via beforeId: FIRST_LABEL_LAYER_ID
    ...withLabelHalos(labels("protomaps", flavor, "en"), flavor)
  ] as maplibregl.LayerSpecification[]
});

const LIGHT_STYLE = buildStyle("white");
const DARK_STYLE = buildStyle("dark");

// The first label layer ID — district layers should be inserted before this
// so basemap labels (place names, roads) render on top of districts. Both
// flavors use the same Protomaps layer IDs so either style works here.
export const FIRST_LABEL_LAYER_ID = labels("protomaps", "white", "en")[0]?.id;

export const getMapStyle = (colorMode: string | undefined): maplibregl.StyleSpecification =>
  colorMode === "dark" ? DARK_STYLE : LIGHT_STYLE;

// Build a style that swaps ONLY the Protomaps basemap layers to the target
// flavor while preserving every user-added source and layer (districts,
// reference layers, icons) in its original position. Feeding this to
// `map.setStyle(..., { diff: true })` makes MapLibre compute a minimal update:
// basemap paint/layout/sprite changes, but districts and feature state are
// left untouched. That prevents the "districts vanish for a beat, revealing
// the bare landcover underneath" flash that a full setStyle causes.
export const mergeBasemap = (
  current: maplibregl.StyleSpecification,
  colorMode: string | undefined
): maplibregl.StyleSpecification => {
  const next = getMapStyle(colorMode);
  const nextById = new Map(next.layers.map(l => [l.id, l]));
  const mergedLayers = current.layers.map(layer =>
    nextById.has(layer.id) ? (nextById.get(layer.id) as maplibregl.LayerSpecification) : layer
  );
  return {
    ...current,
    sprite: next.sprite,
    glyphs: next.glyphs,
    layers: mergedLayers
  };
};
export const POPULATION_LABELS: { readonly [key: string]: string } = {
  population: "All people",
  adj_population: "Prison-adjusted population",
  VAP: "Voting age population (VAP)",
  CVAP: "Citizen voting age population (CVAP)"
};
