import { basename } from "path";

export function shouldPublishFile(fileName: string) {
  const base = basename(fileName);
  // Include input.geojson (for reprocessing) and tiles.pmtiles
  // Exclude intermediate files: .geojson (except input), .mbtiles, per-layer .pmtiles
  if (base === "input.geojson" || base === "tiles.pmtiles") return true;
  if (fileName.endsWith(".geojson")) return false;
  if (fileName.endsWith(".mbtiles")) return false;
  // Exclude per-layer pmtiles (only tiles.pmtiles should be published)
  if (fileName.endsWith(".pmtiles") && base !== "tiles.pmtiles") return false;
  return true;
}
