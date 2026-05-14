// SPDX-License-Identifier: AGPL-3.0-or-later
// Modifications © 2026 Michael Maurizi Jr.

import { Cmd, type Loop, loop } from "redux-loop";
import { getType } from "typesafe-actions";

import { type LoopAction } from "../actions";
import {
  exportCsv,
  exportCsvFailure,
  exportGeoJson,
  exportGeoJsonFailure,
  exportShp,
  exportShpFailure,
  localMergeComplete,
  localMergeFailure,
  projectDataFetch,
  projectDataFetchFailure,
  projectDataFetchSuccess,
  projectFetch,
  projectFetchFailure,
  projectFetchSuccess,
  setProjectNameEditing,
  staticDataFetchFailure,
  staticDataFetchSuccess,
  duplicateProject,
  duplicateProjectSuccess,
  duplicateProjectFailure,
  updateDistrictLocks,
  updateDistrictLocksFailure,
  updateDistrictLocksSuccess,
  updateDistrictsDefinition,
  updateDistrictsDefinitionSuccess,
  updateProjectFailed,
  updateProjectName,
  updateProjectNameSuccess,
  updateProjectVisibility,
  updateProjectVisibilitySuccess,
  updatePinnedMetrics,
  updatePinnedMetricsSuccess,
  updatedPinnedMetricsFailure,
  clearDuplicationState,
  toggleReferenceLayersModal,
  projectReferenceLayersFetch,
  projectReferenceLayersFetchSuccess,
  projectReferenceLayersFetchFailure,
  referenceLayerUpdate,
  referenceLayerUpdateSuccess,
  referenceLayerUpdateFailure,
  referenceLayerDelete,
  referenceLayerDeleteSuccess,
  referenceLayerDeleteFailure,
  setDeleteReferenceLayer,
  toggleProjectDetailsModal,
  updateProjectDetailsSuccess,
  projectSubmit,
  projectSubmitSuccess,
  setRequestedFields
} from "../actions/projectData";
import {
  clearSelectedGeounits,
  setSavingState,
  FindTool,
  SelectionTool
} from "../actions/districtDrawing";
import { updateCurrentState } from "../reducers/undoRedo";
import {
  type DistrictsDefinition,
  type IProject,
  type IReferenceLayer,
  type IStaticMetadata
} from "../../shared/entities";
import { type ProjectState, initialProjectState } from "./project";
import { resetProjectState } from "../actions/root";
import {
  type DistrictsGeoJSON,
  type DynamicProjectData,
  type SavingState,
  type StaticProjectData
} from "../types";
import { type Resource } from "../resource";

import {
  allGeoUnitIndices,
  assignGeounitsToDistrict,
  showActionFailedToast,
  showResourceFailedToast
} from "../functions";
import {
  checkPlanScoreAPI,
  convertGeoJsonToShapefile,
  fetchMemoizedStateBbox,
  fetchProjectData,
  fetchProjectReferenceLayers,
  patchReferenceLayer,
  patchProject,
  copyProject,
  deleteReferenceLayer,
  submitProject,
  uploadProjectThumbnail
} from "../api";
import {
  fetchAllStaticData,
  mergeDistricts,
  exportCsv as workerExportCsv
} from "../worker-functions";
import { fetchGeoUnitHierarchy } from "../s3";
import { getCurrentUserId } from "../jwt";
import { isBlankDistrictsDefinition } from "../../shared/functions";
import { saveAs } from "file-saver";
import { toast } from "react-toastify";
import { showSubmitMapModal } from "../actions/projectModals";

async function exportCsvViaWorker(
  staticMetadata: IStaticMetadata,
  keyPrefix: string,
  version: Date | string | number,
  districtsDefinition: DistrictsDefinition,
  projectName: string
) {
  const csvContent = await workerExportCsv(staticMetadata, keyPrefix, version, districtsDefinition);
  saveAs(new Blob([csvContent], { type: "text/csv;charset=utf-8" }), `${projectName}.csv`);
}

function runLocalMerge(
  staticMetadata: IStaticMetadata,
  keyPrefix: string,
  version: Date | string | number,
  districtsDefinition: DistrictsDefinition,
  numberOfDistricts: number,
  requestedDemographics: readonly string[],
  requestedVoting: readonly string[]
) {
  return () =>
    mergeDistricts(
      staticMetadata,
      keyPrefix,
      version,
      districtsDefinition,
      numberOfDistricts,
      requestedDemographics,
      requestedVoting
    );
}

export function getFindCoords(findTool: FindTool, geojson?: DistrictsGeoJSON) {
  const areAllUnassigned =
    geojson &&
    geojson.features.slice(1).every(district => district.geometry.coordinates.length === 0);
  return geojson && !areAllUnassigned
    ? findTool === FindTool.Unassigned
      ? geojson.features[0].geometry.coordinates
      : geojson.features
          .slice(1)
          .map(multipolygon => multipolygon.geometry.coordinates)
          .filter(coords => coords.length >= 2)
          .flat()
    : undefined;
}

export type ProjectDataState = {
  readonly projectData: Resource<DynamicProjectData>;
  readonly staticData: Resource<StaticProjectData>;
  readonly projectNameSaving: SavingState;
  readonly saving: SavingState;
  readonly referenceLayers: Resource<readonly IReferenceLayer[]>;
  readonly showReferenceLayersModal: boolean;
  readonly showProjectDetailsModal: boolean;
  readonly duplicatedProject: IProject | null;
  readonly deleteReferenceLayer?: IReferenceLayer;
  // Demographic + voting field ids that mergeDistricts and the
  // selected-aggregate worker calls should fetch + aggregate. Driven
  // by ProjectScreen's useNeededFields effect; reducer just stores +
  // re-merges when it changes.
  readonly requestedFields: {
    readonly demographics: readonly string[];
    readonly voting: readonly string[];
  };
};

export const initialProjectDataState = {
  projectData: {
    isPending: false
  },
  staticData: {
    isPending: false
  },
  referenceLayers: { isPending: false },
  projectNameSaving: "saved",
  saving: "unsaved",
  showReferenceLayersModal: false,
  showProjectDetailsModal: false,
  duplicatedProject: null,
  requestedFields: { demographics: [], voting: [] }
} as const;

const projectDataReducer = (
  state: ProjectState = initialProjectState,
  action: LoopAction
): ProjectState | Loop<ProjectState> => {
  switch (action.type) {
    case getType(resetProjectState):
      return {
        ...state,
        ...initialProjectDataState
      };
    case getType(projectFetch):
      return loop(
        {
          ...state,
          projectData: {
            ...state.projectData,
            isPending: true
          }
        },
        Cmd.run(fetchProjectData, {
          successActionCreator: projectFetchSuccess,
          failActionCreator: projectFetchFailure,
          args: [action.payload] as Parameters<typeof fetchProjectData>
        })
      );
    case getType(projectFetchSuccess):
      return loop(
        {
          ...state,
          projectData: {
            resource: {
              project: action.payload.project,
              geojson:
                "resource" in state.projectData
                  ? state.projectData.resource.geojson
                  : action.payload.geojson
            }
          },
          findIndex: undefined
        },
        Cmd.action(clearSelectedGeounits(false))
      );
    case getType(projectFetchFailure):
      return loop(
        {
          ...state,
          projectData: action.payload
        },
        Cmd.run(showActionFailedToast)
      );
    case getType(projectDataFetch):
      return loop(
        {
          ...state,
          projectData: {
            ...state.projectData,
            isPending: true
          }
        },
        Cmd.run(fetchProjectData, {
          successActionCreator: projectDataFetchSuccess,
          failActionCreator: projectDataFetchFailure,
          args: [action.payload] as Parameters<typeof fetchProjectData>
        })
      );
    case getType(projectDataFetchSuccess):
      return loop(
        updateCurrentState(
          {
            ...state,
            projectData: {
              resource: action.payload
            },
            staticData: {
              ...state.staticData,
              isPending: true
            }
          },
          {
            districtsDefinition: action.payload.project.districtsDefinition,
            lockedDistricts: action.payload.project.lockedDistricts,
            pinnedMetricFields: action.payload.project.pinnedMetricFields
          }
        ),
        Cmd.run(fetchAllStaticData, {
          successActionCreator: staticDataFetchSuccess,
          failActionCreator: staticDataFetchFailure,
          args: [
            action.payload.project.regionConfig.keyPrefix,
            action.payload.project.regionConfig.version
          ] as Parameters<typeof fetchAllStaticData>
        })
      );
    case getType(projectDataFetchFailure):
      return loop(
        {
          ...state,
          projectData: action.payload
        },
        action.payload.statusCode && action.payload.statusCode >= 500
          ? Cmd.run(showResourceFailedToast)
          : Cmd.none
      );
    case getType(projectReferenceLayersFetch):
      return loop(
        {
          ...state,
          referenceLayers: { ...state.referenceLayers, isPending: true }
        },
        Cmd.run(fetchProjectReferenceLayers, {
          successActionCreator: projectReferenceLayersFetchSuccess,
          failActionCreator: projectReferenceLayersFetchFailure,
          args: [action.payload] as Parameters<typeof fetchProjectReferenceLayers>
        })
      );
    case getType(projectReferenceLayersFetchSuccess):
      return {
        ...state,
        referenceLayers: {
          resource: action.payload
        }
      };
    case getType(projectReferenceLayersFetchFailure):
      return loop(
        {
          ...state,
          referenceLayers: action.payload
        },
        Cmd.run(showActionFailedToast)
      );
    case getType(referenceLayerUpdate):
      return loop(
        { ...state, referenceLayers: { ...state.referenceLayers, isPending: true } },
        Cmd.run(patchReferenceLayer, {
          successActionCreator: referenceLayerUpdateSuccess,
          failActionCreator: referenceLayerUpdateFailure,
          args: [action.payload.id, action.payload.layer_color] as Parameters<
            typeof patchReferenceLayer
          >
        })
      );
    case getType(referenceLayerUpdateSuccess):
      return {
        ...state,
        referenceLayers: {
          resource:
            "resource" in state.referenceLayers
              ? state.referenceLayers.resource.map(layer => {
                  if (layer.id === action.payload.id) {
                    return {
                      ...layer,
                      layer_color: action.payload.layer_color
                    };
                  } else {
                    return layer;
                  }
                })
              : []
        }
      };
    case getType(referenceLayerUpdateFailure):
      return loop(
        {
          ...state,
          referenceLayer: action.payload
        },
        Cmd.run(showActionFailedToast)
      );
    case getType(referenceLayerDelete):
      return loop(
        {
          ...state,
          referenceLayers: {
            resource:
              "resource" in state.referenceLayers ? state.referenceLayers.resource : undefined,
            isPending: true
          }
        },
        Cmd.run(deleteReferenceLayer, {
          successActionCreator: referenceLayerDeleteSuccess,
          failActionCreator: referenceLayerDeleteFailure,
          args: [action.payload] as Parameters<typeof deleteReferenceLayer>
        })
      );
    case getType(referenceLayerDeleteSuccess):
      return {
        ...state,
        deleteReferenceLayer: undefined,
        showReferenceLayers: new Set(
          [...state.showReferenceLayers].filter(id => id !== action.payload)
        ),
        referenceLayers: {
          resource:
            "resource" in state.referenceLayers
              ? state.referenceLayers.resource.filter(layer => layer.id !== action.payload)
              : []
        }
      };
    case getType(referenceLayerDeleteFailure):
      return loop(
        {
          ...state,
          referenceLayers: action.payload
        },
        Cmd.run(showActionFailedToast)
      );
    case getType(setDeleteReferenceLayer):
      return {
        ...state,
        deleteReferenceLayer: action.payload
      };
    case getType(staticDataFetchSuccess): {
      const newState = {
        ...state,
        staticData: {
          resource: action.payload
        }
      };
      // Trigger local merge now that project + static data are loaded —
      // but only once requestedFields has been populated by
      // ProjectScreen's useNeededFields effect. On a cold page load the
      // initial requestedFields is empty; the first useful merge fires
      // through the setRequestedFields handler when ProjectScreen
      // dispatches the computed set, which avoids a wasted initial merge
      // that would otherwise produce a geojson with empty per-district
      // demographics/voting only to be overwritten immediately.
      const fieldsLoaded =
        newState.requestedFields.demographics.length > 0 ||
        newState.requestedFields.voting.length > 0;
      if ("resource" in newState.projectData && fieldsLoaded) {
        const { project } = newState.projectData.resource;
        return loop(
          newState,
          Cmd.run(
            runLocalMerge(
              action.payload.staticMetadata,
              project.regionConfig.keyPrefix,
              project.regionConfig.version,
              project.districtsDefinition,
              project.numberOfDistricts,
              newState.requestedFields.demographics,
              newState.requestedFields.voting
            ),
            {
              successActionCreator: localMergeComplete,
              failActionCreator: localMergeFailure
            }
          )
        );
      }
      return newState;
    }
    case getType(toggleReferenceLayersModal):
      return {
        ...state,
        showReferenceLayersModal: !state.showReferenceLayersModal
      };
    case getType(toggleProjectDetailsModal):
      return {
        ...state,
        showProjectDetailsModal: !state.showProjectDetailsModal
      };
    case getType(staticDataFetchFailure):
      return loop(
        {
          ...state,
          staticData: {
            errorMessage: action.payload
          }
        },
        Cmd.run(showResourceFailedToast)
      );
    case getType(setProjectNameEditing):
      return { ...state, projectNameSaving: action.payload ? "unsaved" : "saved" };

    case getType(updateProjectName): {
      if ("resource" in state.projectData) {
        const projectId = state.projectData.resource.project.id;
        const { geojson } = state.projectData.resource;
        return loop(
          {
            ...state,
            projectNameSaving: "saving"
          },
          Cmd.run(
            () =>
              patchProject(projectId, { name: action.payload }).then(project => ({
                project,
                geojson
              })),
            {
              successActionCreator: updateProjectNameSuccess,
              failActionCreator: updateProjectFailed
            }
          )
        );
      } else {
        return state;
      }
    }
    case getType(updateProjectNameSuccess):
      return {
        ...state,
        projectNameSaving: "saved",
        saving: "saved",
        projectData: { resource: action.payload }
      };

    case getType(updateProjectVisibility): {
      if ("resource" in state.projectData) {
        const projectId = state.projectData.resource.project.id;
        const { geojson } = state.projectData.resource;
        return loop(
          {
            ...state,
            saving: "saving"
          },
          Cmd.run(
            () =>
              patchProject(projectId, { visibility: action.payload }).then(project => ({
                project,
                geojson
              })),
            {
              successActionCreator: updateProjectVisibilitySuccess,
              failActionCreator: updateProjectFailed
            }
          )
        );
      } else {
        return state;
      }
    }
    case getType(updateProjectVisibilitySuccess):
      return {
        ...state,
        saving: "saved",
        projectData: { resource: action.payload }
      };
    case getType(updateProjectDetailsSuccess):
      return {
        ...state,
        saving: "saved",
        showProjectDetailsModal: false,
        projectData: { resource: action.payload }
      };
    case getType(updateDistrictsDefinition): {
      if (!("resource" in state.projectData)) {
        return state;
      }
      const { project } = state.projectData.resource;
      return loop(
        {
          ...state,
          saving: "saving"
        },
        Cmd.list(
          [
            Cmd.run(
              async () => {
                // Districts definition may be optionally specified in the action payload and
                // is used if available. This is needed to go back/forward in time for a given
                // state snapshot -- as opposed to just using the current districts definition
                // -- for undo/redo to work correctly. Only the selection-save path needs the
                // geounit hierarchy, so the (memoized) fetch is awaited lazily here rather
                // than blocking the page load on it.
                const districtsDefinition =
                  action.payload ||
                  assignGeounitsToDistrict(
                    project.districtsDefinition,
                    await fetchGeoUnitHierarchy(
                      project.regionConfig.keyPrefix,
                      project.regionConfig.version
                    ),
                    allGeoUnitIndices(state.undoHistory.present.state.selectedGeounits),
                    state.selectedDistrictId
                  );
                return patchProject(project.id, { districtsDefinition });
              },
              {
                successActionCreator: updateDistrictsDefinitionSuccess,
                failActionCreator: updateProjectFailed
              }
            ),
            // When updating districts definition after a save, we want to clear the selected
            // geounits since we're "done". However, when redoing/undoing changes with a
            // specific districts definition, we want to keep those geounits selected to allow
            // the user to potentially edit their selection or continuing undoing/redoing their
            // changes.
            action.payload
              ? Cmd.action(setSavingState("saved"))
              : Cmd.action(clearSelectedGeounits(false))
          ],
          { sequence: true }
        )
      );
    }
    case getType(updateDistrictsDefinitionSuccess): {
      // Server returned updated project. Compute GeoJSON locally.
      const updatedProject = action.payload;
      if ("resource" in state.staticData) {
        return loop(
          {
            ...state,
            projectData: {
              resource: {
                project: updatedProject,
                geojson:
                  "resource" in state.projectData
                    ? state.projectData.resource.geojson
                    : { type: "FeatureCollection", features: [] }
              }
            }
          },
          Cmd.run(
            runLocalMerge(
              state.staticData.resource.staticMetadata,
              updatedProject.regionConfig.keyPrefix,
              updatedProject.regionConfig.version,
              updatedProject.districtsDefinition,
              updatedProject.numberOfDistricts,
              state.requestedFields.demographics,
              state.requestedFields.voting
            ),
            {
              successActionCreator: localMergeComplete,
              failActionCreator: localMergeFailure
            }
          )
        );
      }
      return state;
    }
    case getType(localMergeComplete): {
      if ("resource" in state.projectData) {
        const { districts, thumbnail, isComplete } = action.payload;
        const { project } = state.projectData.resource;
        // Stamp metadata onto the in-memory districts. Not persisted — only
        // exists so exported .geojson files keep the shape downstream
        // consumers rely on.
        const geojson: DistrictsGeoJSON = {
          ...districts,
          metadata: {
            completed: isComplete,
            creator: { id: project.user.id, name: project.user.name },
            regionConfig: {
              id: project.regionConfig.id,
              name: project.regionConfig.name,
              countryCode: project.regionConfig.countryCode,
              regionCode: project.regionConfig.regionCode,
              keyPrefix: project.regionConfig.keyPrefix
            },
            chamber: project.chamber
          }
        };
        const findCoords = getFindCoords(state.findTool, geojson);
        // Persist thumbnail + isComplete in three cases:
        //  1. The user just saved — state.saving === "saving".
        //  2. The project has real assignments but districtProperties hasn't
        //     been written yet — i.e. no per-project PNG has been uploaded.
        //     Happens for template-backed projects, whose first render
        //     happens here. Blank new projects are left alone so the
        //     per-region fallback URL is used until the user draws something.
        //  3. The stored isComplete is stale (e.g. an import that created the
        //     project already complete — the server defaults isComplete to
        //     false and the import flow may supply a thumbnail, so case 2
        //     wouldn't catch it and the project stays hidden from /maps until
        //     the user saves an unrelated change).
        // Each check reads the pre-merge project from state, so it only fires
        // when there's actually something new to persist.
        // Owner check: viewing someone else's map (or being logged out) still
        // runs the merge to draw the districts, but must not call the
        // ownership-gated PATCH / thumbnail-upload-url endpoints.
        const isOwner = getCurrentUserId() === project.user.id;
        const wasTriggeredBySave = isOwner && state.saving === "saving";
        const isBlank = isBlankDistrictsDefinition(project.districtsDefinition);
        const needsInitialThumbnail = isOwner && !isBlank && project.districtProperties == null;
        const needsCompletenessUpdate = isOwner && project.isComplete !== isComplete;
        const regionConfig = project.regionConfig;
        const nextState = updateCurrentState(
          {
            ...state,
            saving: "saved",
            projectData: {
              resource: { project: { ...project, isComplete }, geojson }
            },
            findIndex:
              state.findIndex !== undefined && findCoords && findCoords.length !== 0
                ? Math.min(state.findIndex, findCoords.length - 1)
                : undefined
          },
          {
            districtsDefinition: project.districtsDefinition
          }
        );
        return wasTriggeredBySave || needsInitialThumbnail || needsCompletenessUpdate
          ? loop(
              nextState,
              Cmd.run(async () => {
                const bbox = await fetchMemoizedStateBbox(regionConfig);
                const { renderThumbnailPng } = await import("../thumbnail-render");
                // Render variants serially: two concurrent MapLibre instances
                // can blow GPU memory on lower-end devices.
                const squareBlob = await renderThumbnailPng(thumbnail, bbox, "square");
                const ogBlob = await renderThumbnailPng(thumbnail, bbox, "og");
                const districtProperties = thumbnail.features.map(f => f.properties);
                // Upload is best-effort: a missing THUMBNAILS_BUCKET in dev or
                // a transient S3 failure shouldn't block the save. Next save
                // retries; the mini-map / og card stay stale until one succeeds.
                try {
                  await Promise.all([
                    uploadProjectThumbnail(project.id, squareBlob, "square"),
                    uploadProjectThumbnail(project.id, ogBlob, "og")
                  ]);
                } catch (e) {
                  // eslint-disable-next-line no-console
                  console.warn("Thumbnail upload failed:", e);
                }
                return patchProject(project.id, { districtProperties, isComplete });
              })
            )
          : nextState;
      }
      return state;
    }
    case getType(localMergeFailure):
      return loop({ ...state, saving: "failed" }, Cmd.run(showActionFailedToast));
    case getType(updateProjectFailed):
      return loop(
        {
          ...state,
          saving: "failed"
        },
        Cmd.run(showActionFailedToast)
      );

    case getType(updateDistrictLocks): {
      if ("resource" in state.projectData) {
        const { id } = state.projectData.resource.project;
        const { geojson } = state.projectData.resource;
        return loop(
          {
            ...state,
            saving: "saving"
          },
          Cmd.run(
            () =>
              patchProject(id, { lockedDistricts: action.payload }).then(project => ({
                project,
                geojson
              })),
            {
              successActionCreator: updateDistrictLocksSuccess,
              failActionCreator: updateDistrictLocksFailure
            }
          )
        );
      } else {
        return state;
      }
    }
    case getType(updateDistrictLocksSuccess):
      return updateCurrentState(
        {
          ...state,
          saving: "saved",
          projectData: {
            resource: action.payload
          }
        },
        {
          lockedDistricts: action.payload.project.lockedDistricts
        }
      );
    case getType(updateDistrictLocksFailure):
      return loop(
        {
          ...state,
          saving: "failed"
        },
        Cmd.run(showActionFailedToast)
      );
    case getType(updatePinnedMetrics): {
      if ("resource" in state.projectData) {
        const { id } = state.projectData.resource.project;
        const { geojson } = state.projectData.resource;
        const { pinnedMetricFields, isReadOnly } = action.payload;
        const updatedState = updateCurrentState(state, { pinnedMetricFields });
        return isReadOnly
          ? updatedState
          : // We update the pinned metrics right away, assuming it will succeed, to keep the UI snappy
            loop(
              {
                ...updatedState,
                saving: "saving"
              },
              Cmd.run(
                () =>
                  patchProject(id, { pinnedMetricFields }).then(project => ({
                    project,
                    geojson
                  })),
                {
                  successActionCreator: updatePinnedMetricsSuccess,
                  failActionCreator: updatedPinnedMetricsFailure
                }
              )
            );
      } else {
        return state;
      }
    }
    case getType(updatePinnedMetricsSuccess):
      // We already updated the pinned metrics, and can't rely on the order returned by the server
      // to be consistent with our save order, so we purposefully don't update the pinned metrics here
      return {
        ...state,
        saving: "saved",
        projectData: {
          resource: action.payload
        }
      };
    case getType(updatedPinnedMetricsFailure):
      return loop(
        {
          ...state,
          saving: "failed"
        },
        Cmd.run(() => toast.error("Unable to save pinned metrics."))
      );
    case getType(duplicateProject): {
      return loop(
        {
          ...state,
          saving: "saving",
          duplicatedProject: null
        },
        Cmd.run(() => copyProject(action.payload.id), {
          successActionCreator: duplicateProjectSuccess,
          failActionCreator: duplicateProjectFailure
        })
      );
    }
    case getType(duplicateProjectSuccess):
      return {
        ...state,
        saving: "saved",
        duplicatedProject: action.payload
      };
    case getType(duplicateProjectFailure):
      return loop(
        {
          ...state,
          saving: "failed",
          duplicatedProject: null
        },
        Cmd.run(showActionFailedToast)
      );
    case getType(clearDuplicationState):
      return {
        ...state,
        saving: "unsaved",
        duplicatedProject: null
      };
    case getType(exportCsv): {
      const csvStaticData = "resource" in state.staticData ? state.staticData.resource : undefined;
      if (csvStaticData) {
        const project = action.payload;
        return loop(
          state,
          Cmd.run(
            () =>
              exportCsvViaWorker(
                csvStaticData.staticMetadata,
                project.regionConfig.keyPrefix,
                project.regionConfig.version,
                project.districtsDefinition,
                project.name
              ),
            {
              failActionCreator: exportCsvFailure
            }
          )
        );
      }
      return state;
    }
    case getType(exportCsvFailure):
      return loop(state, Cmd.run(showActionFailedToast));
    case getType(exportGeoJson): {
      const geojsonData =
        "resource" in state.projectData ? state.projectData.resource.geojson : undefined;
      if (geojsonData) {
        return loop(
          state,
          Cmd.run(
            () =>
              saveAs(
                new Blob([JSON.stringify(geojsonData)], { type: "application/json" }),
                `${action.payload.name}.geojson`
              ),
            { failActionCreator: exportGeoJsonFailure }
          )
        );
      }
      return state;
    }
    case getType(exportGeoJsonFailure):
      return loop(state, Cmd.run(showActionFailedToast));
    case getType(exportShp): {
      const shpGeojson =
        "resource" in state.projectData ? state.projectData.resource.geojson : undefined;
      if (shpGeojson) {
        return loop(
          state,
          Cmd.run(() => convertGeoJsonToShapefile(shpGeojson, action.payload.name), {
            failActionCreator: exportShpFailure
          })
        );
      }
      return state;
    }
    case getType(exportShpFailure):
      return loop(state, Cmd.run(showActionFailedToast));
    case getType(projectSubmit): {
      if ("resource" in state.projectData) {
        const projectId = state.projectData.resource.project.id;
        const { geojson } = state.projectData.resource;
        return loop(
          {
            ...state,
            saving: "saving"
          },
          Cmd.run(
            () =>
              submitProject(projectId).then(project => ({
                project,
                geojson
              })),
            {
              successActionCreator: projectSubmitSuccess,
              failActionCreator: updateProjectFailed
            }
          )
        );
      } else {
        return state;
      }
    }
    case getType(projectSubmitSuccess): {
      // The server used to fire off a PlanScore upload when a contest map was
      // submitted with no existing planscoreUrl; that now lives here since
      // the browser holds the districts geojson.
      const { project: submitted, geojson: submittedGeojson } = action.payload;
      if (!submitted.planscoreUrl) {
        void checkPlanScoreAPI(submitted, submittedGeojson).catch(() => {
          /* polled result surfaces in the UI via fetchProject; swallow here */
        });
      }
      return loop(
        {
          ...state,
          saving: "saved",
          projectData: { resource: action.payload },
          selectionTool: SelectionTool.Default
        },
        "resource" in state.projectData &&
          state.projectData.resource.project.projectTemplate?.contestNextSteps
          ? Cmd.list([
              Cmd.action(clearSelectedGeounits(true)),
              Cmd.action(showSubmitMapModal(true))
            ])
          : Cmd.action(clearSelectedGeounits(true))
      );
    }
    case getType(setRequestedFields): {
      const updatedState = { ...state, requestedFields: action.payload };
      // Re-run merge with the new field set if both project + static
      // data are loaded. ProjectScreen gates dispatches behind a
      // string-keyed effect, so we trust the action only fires on real
      // changes.
      if ("resource" in updatedState.projectData && "resource" in updatedState.staticData) {
        const { project } = updatedState.projectData.resource;
        const { staticMetadata } = updatedState.staticData.resource;
        return loop(
          updatedState,
          Cmd.run(
            runLocalMerge(
              staticMetadata,
              project.regionConfig.keyPrefix,
              project.regionConfig.version,
              project.districtsDefinition,
              project.numberOfDistricts,
              action.payload.demographics,
              action.payload.voting
            ),
            {
              successActionCreator: localMergeComplete,
              failActionCreator: localMergeFailure
            }
          )
        );
      }
      return updatedState;
    }
    default:
      return state as never;
  }
};

export default projectDataReducer;
