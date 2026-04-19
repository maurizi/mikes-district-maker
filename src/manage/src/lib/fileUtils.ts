// SPDX-License-Identifier: AGPL-3.0-or-later
// Modifications © 2026 Michael Maurizi Jr.

import { basename } from "path";

export function shouldPublishFile(fileName: string) {
  const base = basename(fileName);
  // Include input.geojson (for reprocessing) and tiles.pmtiles
  // Exclude intermediate files: .geojson (except input), .mbtiles, per-layer .pmtiles, topo.json
  if (base === "input.geojson" || base === "tiles.pmtiles") return true;
  if (base === "topo.json") return false;
  if (fileName.endsWith(".geojson")) return false;
  if (fileName.endsWith(".mbtiles")) return false;
  if (fileName.endsWith(".pmtiles") && base !== "tiles.pmtiles") return false;
  return true;
}
