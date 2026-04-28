// SPDX-License-Identifier: AGPL-3.0-or-later
// © 2026 Michael Maurizi Jr.

import maplibregl from "maplibre-gl";

import { type ThumbnailGeoJSON } from "../shared/entities";
import { getDistrictColor } from "./constants/colors";

// Two variants: a square PNG that the in-app mini-maps display without
// letterboxing, and a 1.91:1 PNG sized for og:image / twitter:card
// `summary_large_image`. Bluesky/Facebook/LinkedIn/Discord all crop the
// preview to ~1.91:1, so a square og:image gets its top and bottom
// clipped — the square form is fine for square-ish states (FL, IA) but
// loses the panhandle / Keys after the platform crop.
export type ThumbnailVariant = "square" | "og";

const DIMENSIONS: Record<ThumbnailVariant, { readonly width: number; readonly height: number }> = {
  square: { width: 1200, height: 1200 },
  og: { width: 1200, height: 630 }
};
const THUMBNAIL_PADDING = 15;

export async function renderThumbnailPng(
  districts: ThumbnailGeoJSON,
  bounds: readonly [number, number, number, number],
  variant: ThumbnailVariant = "square"
): Promise<Blob> {
  const { width, height } = DIMENSIONS[variant];
  const container = document.createElement("div");
  container.style.position = "absolute";
  container.style.left = "-99999px";
  container.style.top = "0";
  container.style.width = `${width}px`;
  container.style.height = `${height}px`;
  document.body.appendChild(container);

  // Bake color into feature properties up front so the fill layer can read it
  // via identity. Mirrors ProjectDistrictsMap's runtime-color override so the
  // PNG matches the live mini-map.
  const coloredDistricts: ThumbnailGeoJSON = {
    ...districts,
    features: districts.features.map((f, id) => ({
      ...f,
      properties: {
        ...f.properties,
        color: id === 0 ? "#EDEDED" : getDistrictColor(id)
      }
    }))
  };

  try {
    const map = new maplibregl.Map({
      container,
      style: { version: 8, sources: {}, layers: [] },
      bounds: [...bounds],
      fitBoundsOptions: { padding: THUMBNAIL_PADDING },
      interactive: false,
      attributionControl: false,
      // preserveDrawingBuffer keeps the canvas contents readable after the
      // frame ends, which toBlob/toDataURL require. MapLibre 5.x moved WebGL
      // context flags into canvasContextAttributes.
      canvasContextAttributes: { preserveDrawingBuffer: true }
    });

    await new Promise<void>(resolve => {
      map.on("load", () => {
        map.addSource("districts", { type: "geojson", data: coloredDistricts });
        map.addLayer({
          id: "districts",
          type: "fill",
          source: "districts",
          layout: {},
          paint: { "fill-color": { type: "identity", property: "color" } }
        });
        map.once("idle", () => resolve());
      });
    });

    const blob = await new Promise<Blob | null>(resolve => {
      map.getCanvas().toBlob(b => resolve(b), "image/png");
    });
    map.remove();
    if (!blob) {
      throw new Error("Failed to render thumbnail PNG");
    }
    return blob;
  } finally {
    document.body.removeChild(container);
  }
}
