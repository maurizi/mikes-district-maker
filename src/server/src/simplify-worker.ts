import { expose } from "threads/worker";
import simplify from "simplify-geojson";
import bbox from "@turf/bbox";
import { BBox } from "@turf/helpers";

import { DistrictsGeoJSON } from "./projects/entities/project.entity";

function simplifyDistricts(districts: DistrictsGeoJSON): DistrictsGeoJSON {
  const box: BBox = bbox(districts);
  const boxArea = (box[2] - box[0]) * (box[3] - box[1]);
  const tolerance = boxArea > 1 ? 0.005 : 0.001;
  return {
    ...districts,
    features: districts.features.map(feature => {
      try {
        return simplify(feature, tolerance);
      } catch {
        return feature;
      }
    })
  };
}

const functions = {
  simplifyDistricts
};

export type SimplifyFunctions = typeof functions;

expose(functions);
