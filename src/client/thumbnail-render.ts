import maplibregl from "maplibre-gl";

import { type ThumbnailGeoJSON } from "../shared/entities";
import { getDistrictColor } from "./constants/colors";

// OpenGraph / Twitter-card spec asks for 1200x630 (1.91:1). The same PNG is
// reused as the home-page mini-map, which scales it down.
const THUMBNAIL_WIDTH = 1200;
const THUMBNAIL_HEIGHT = 630;
const THUMBNAIL_PADDING = 40;

export async function renderThumbnailPng(
  districts: ThumbnailGeoJSON,
  bounds: readonly [number, number, number, number]
): Promise<Blob> {
  const container = document.createElement("div");
  container.style.position = "absolute";
  container.style.left = "-99999px";
  container.style.top = "0";
  container.style.width = `${THUMBNAIL_WIDTH}px`;
  container.style.height = `${THUMBNAIL_HEIGHT}px`;
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
