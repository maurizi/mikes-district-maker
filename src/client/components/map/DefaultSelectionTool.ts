import type maplibregl from "maplibre-gl";
import store from "../../store";
import { removeSelectedGeounits, editSelectedGeounits } from "../../actions/districtDrawing";
import {
  DISTRICTS_LAYER_ID,
  isFeatureSelected,
  featureStateGeoLevel,
  levelToSelectionLayerId,
  type ISelectionTool,
  featuresToGeoUnits,
  onlyUnlockedGeoUnits,
  getChildGeoUnits,
  setFeaturesSelectedFromGeoUnits
} from "./index";
import { allGeoUnitIds } from "../../functions";
import {
  type GeoUnits,
  type GeoUnitIndices,
  type DistrictsDefinition,
  type FeatureId,
  type IStaticMetadata,
  type LockedDistricts,
  type TypedArrays
} from "../../../shared/entities";

function areAllUnlockedChildGeoUnitsSelected(
  map: maplibregl.Map,
  unlockedGeoUnits: GeoUnits,
  geoUnitForFeature: GeoUnitIndices | undefined,
  staticMetadata: IStaticMetadata,
  staticGeoLevels: TypedArrays
): boolean {
  if (!geoUnitForFeature) {
    return false;
  } else {
    const { childGeoUnits, childGeoLevel } = getChildGeoUnits(
      geoUnitForFeature,
      staticMetadata,
      staticGeoLevels
    );
    return (
      childGeoUnits &&
      allGeoUnitIds(childGeoUnits)
        .filter(featureId => unlockedGeoUnits[childGeoLevel.id].has(featureId))
        .every(featureId =>
          isFeatureSelected(map, {
            id: featureId,
            sourceLayer: childGeoLevel.id
          })
        )
    );
  }
}

/*
 * Allows users to individually select/deselect specific geounits by clicking them.
 */
const DefaultSelectionTool: ISelectionTool = {
  enable: function (
    map: maplibregl.Map,
    geoLevelId: string,
    staticMetadata: IStaticMetadata,
    districtsDefinition: DistrictsDefinition,
    lockedDistricts: LockedDistricts,
    staticGeoLevels: TypedArrays
  ) {
    this.setCursor = () => (map.getCanvas().style.cursor = "pointer");
    this.unsetCursor = () => (map.getCanvas().style.cursor = "");
    map.on("mousemove", DISTRICTS_LAYER_ID, this.setCursor);
    map.on("mouseleave", DISTRICTS_LAYER_ID, this.unsetCursor);

    // Add a click event to the top geolevel that logs demographic information.
    // Note that the feature can't be directly selected under the cursor, so
    // we need to use a small bounding box and select the first feature we find.
    const clickHandler = (e: maplibregl.MapMouseEvent) => {
      const buffer = 1;
      const southWest: maplibregl.PointLike = [e.point.x - buffer, e.point.y - buffer];
      const northEast: maplibregl.PointLike = [e.point.x + buffer, e.point.y + buffer];
      const features = map.queryRenderedFeatures([southWest, northEast], {
        layers: [levelToSelectionLayerId(geoLevelId)]
      });

      // Disabling 'functional/no-conditional-statement' without naming it.
      // See https://github.com/jonaskello/eslint-plugin-functional/issues/105

      if (features.length === 0 || typeof features[0].id !== "number") {
        return;
      }
      const feature = features[0];

      const geoUnits = featuresToGeoUnits(features, staticMetadata.geoLevelHierarchy);
      const unlockedGeoUnits = onlyUnlockedGeoUnits(
        districtsDefinition,
        lockedDistricts,
        geoUnits,
        staticMetadata,
        staticGeoLevels
      );
      const isSelected = isFeatureSelected(map, feature);
      const geoUnitForFeature = geoUnits[geoLevelId].get(feature.id as FeatureId);
      const unlockedGeoUnitForFeature = unlockedGeoUnits[geoLevelId].get(feature.id as FeatureId);
      const isPartiallyLocked = geoUnitForFeature && !unlockedGeoUnitForFeature;
      const isPartiallySelected = areAllUnlockedChildGeoUnitsSelected(
        map,
        unlockedGeoUnits,
        geoUnitForFeature,
        staticMetadata,
        staticGeoLevels
      );

      if (isSelected) {
        // Geounit is selected, so deselect it
        map.setFeatureState(featureStateGeoLevel(feature), { selected: false });
        store.dispatch(removeSelectedGeounits(unlockedGeoUnits));
      } else if (!isSelected && isPartiallyLocked && isPartiallySelected) {
        // We're in a situation where we need to deselect a partially selected feature. Partial
        // selection is where we only select the unlocked geounits within the selected feature, so
        // we want to deselect only those.
        setFeaturesSelectedFromGeoUnits(map, unlockedGeoUnits, false);
        store.dispatch(removeSelectedGeounits(unlockedGeoUnits));
      } else {
        // Geounit is not selected, so select it, making sure to remove the selection on any child
        // geounits since the parent selection supercedes any child selections
        setFeaturesSelectedFromGeoUnits(map, unlockedGeoUnits, true);
        const { childGeoUnits } = unlockedGeoUnitForFeature
          ? getChildGeoUnits(unlockedGeoUnitForFeature, staticMetadata, staticGeoLevels)
          : { childGeoUnits: {} };
        setFeaturesSelectedFromGeoUnits(map, childGeoUnits, false);
        store.dispatch(
          editSelectedGeounits({
            add: unlockedGeoUnits,
            remove: childGeoUnits
          })
        );
      }
    };
    map.on("click", clickHandler);
    // Save the click handler function so it can be removed later
    this.clickHandler = clickHandler;
  },
  disable: function (map: maplibregl.Map) {
    this.clickHandler && map.off("click", this.clickHandler);
    this.setCursor && map.off("mousemove", DISTRICTS_LAYER_ID, this.setCursor);
    this.unsetCursor && map.off("mouseleave", DISTRICTS_LAYER_ID, this.unsetCursor);
  }
};

export default DefaultSelectionTool;
