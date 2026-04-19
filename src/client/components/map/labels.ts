// SPDX-License-Identifier: AGPL-3.0-or-later
// Modifications © 2026 Michael Maurizi Jr.

import { type MapGeoJSONFeature } from "maplibre-gl";
import { geoLevelLabelSingular } from "../../functions";

export function getLabel(geoLevelId?: string, feature?: MapGeoJSONFeature) {
  if (feature && feature.properties && typeof feature.properties.name === "string") {
    if (geoLevelId === "county" && !feature.properties.name.endsWith("County")) {
      return `${feature.properties.name} County`;
    }
    return feature.properties.name;
  } else if (feature && geoLevelId) {
    return `${geoLevelId} #${feature.id}`;
  } else {
    return "";
  }
}

export function getLabelLookup(geoLevelId?: string, label?: string, index?: number) {
  if (label) {
    return label;
  } else if (geoLevelId && index) {
    return `${geoLevelLabelSingular(geoLevelId)} #${index}`;
  } else {
    return "";
  }
}
