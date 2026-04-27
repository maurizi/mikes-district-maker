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
  // Legacy per-property typed-array sidecars and the streamed block-id
  // list are subsumed by region.ctopo — drop them if a stale output
  // directory still has them lying around.
  if (fileName.endsWith(".bin")) return false;
  if (fileName.endsWith(".buf")) return false;
  if (base === "block-ids.json") return false;
  if (base === "geo-properties.json") return false;
  if (base === "transform.json") return false;
  return true;
}
