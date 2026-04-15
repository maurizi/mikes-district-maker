import simplify from "simplify-geojson";
import bbox from "@turf/bbox";

import { type DistrictsGeoJSON, type ThumbnailGeoJSON } from "./entities";

// Thumbnail serialized JSON size cap. The /api/projects PATCH carries
// districtsDefinition + thumbnail + metadata; Nest's default body limit is
// ~5MB, leave headroom for the rest of the payload.
const THUMBNAIL_MAX_BYTES = 3 * 1024 * 1024;
const THUMBNAIL_MAX_ITERATIONS = 6;

export function simplifyForThumbnail(districts: DistrictsGeoJSON): ThumbnailGeoJSON {
  // Small states (DC, RI, etc.) have tiny bbox area and need a finer tolerance
  // than continent-sized states, else the whole state collapses to a point.
  const box = bbox(districts);
  const boxArea = (box[2] - box[0]) * (box[3] - box[1]);
  let tolerance = boxArea > 1 ? 0.005 : 0.001;

  const simplifyOnce = (t: number): ThumbnailGeoJSON => ({
    type: "FeatureCollection",
    features: districts.features.map(feature => {
      try {
        return simplify(feature, t);
      } catch {
        return feature;
      }
    })
  });

  let thumbnail = simplifyOnce(tolerance);
  for (let i = 0; i < THUMBNAIL_MAX_ITERATIONS; i++) {
    if (JSON.stringify(thumbnail).length <= THUMBNAIL_MAX_BYTES) {
      break;
    }
    tolerance *= 2;
    thumbnail = simplifyOnce(tolerance);
  }
  return thumbnail;
}
