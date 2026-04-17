import type maplibregl from "maplibre-gl";
import React, { useEffect, useRef, useState } from "react";
import { useBeforeunload } from "react-beforeunload";
import { connect } from "react-redux";
import { Navigate, useParams } from "react-router-dom";
import { toast } from "react-toastify";
import { Box, Button, Flex, Spinner, type ThemeUIStyleObject } from "theme-ui";

import {
  type GeoUnitHierarchy,
  type IProject,
  type IReferenceLayer,
  type IStaticMetadata,
  type IUser,
  type TypedArrays
} from "../../shared/entities";

import {
  clearDuplicationState,
  projectDataFetch,
  projectReferenceLayersFetch
} from "../actions/projectData";
import { resetProjectState } from "../actions/root";
import { setPopulationKey } from "../actions/projectOptions";
import { userFetch } from "../actions/user";
import "../App.css";
import AddReferenceLayerModal from "../components/AddReferenceLayerModal";
import CenteredContent from "../components/CenteredContent";
import CopyMapModal from "../components/CopyMapModal";
import DeleteReferenceLayerModal from "../components/DeleteReferenceLayerModal";
import ProjectEvaluateSidebar from "../components/evaluate/ProjectEvaluateSidebar";
import Icon from "../components/Icon";
import AdvancedEditingModal from "../components/map/AdvancedEditingModal";

import KeyboardShortcutsModal from "../components/map/KeyboardShortcutsModal";
import Map from "../components/map/Map";
import MapHeader from "../components/MapHeader";
import ProjectDetailsModal from "../components/ProjectDetailsModal";
import ProjectHeader from "../components/ProjectHeader";
import ProjectSidebar from "../components/ProjectSidebar";
import SiteHeader from "../components/SiteHeader";
import SubmitMapModal from "../components/SubmitMapModal";
import Tour from "../components/Tour";
import { areAnyGeoUnitsSelected, destructureResource, isProjectReadOnly } from "../functions";
import { isUserLoggedIn } from "../jwt";
import { type State } from "../reducers";
import { type DistrictDrawingState } from "../reducers/districtDrawing";
import { type ProjectOptionsState } from "../reducers/projectOptions";
import { type Resource } from "../resource";
import store from "../store";
import { type DistrictsGeoJSON, type EvaluateMetricWithValue } from "../types";

import { useIsNarrowViewport } from "../hooks/useIsMobile";
import PageNotFoundScreen from "./PageNotFoundScreen";

interface StateProps {
  readonly project?: IProject;
  readonly geojson?: DistrictsGeoJSON;
  readonly staticMetadata?: IStaticMetadata;
  readonly staticGeoLevels?: TypedArrays;
  readonly projectNotFound?: boolean;
  readonly findMenuOpen: boolean;
  readonly evaluateMode: boolean;
  readonly evaluateMetric: EvaluateMetricWithValue | undefined;
  readonly geoUnitHierarchy?: GeoUnitHierarchy;
  readonly expandedProjectMetrics?: boolean;
  readonly districtDrawing: DistrictDrawingState;
  readonly isLoading: boolean;
  readonly isReadOnly: boolean;
  readonly isArchived: boolean;
  readonly referenceLayers: Resource<readonly IReferenceLayer[]>;
  readonly mapLabel: string | undefined;
  readonly user: Resource<IUser>;
  readonly limitSelectionToCounty: boolean;
  readonly projectOptions: ProjectOptionsState;
}

const style: Record<string, ThemeUIStyleObject> = {
  tourStart: {
    width: "300px",
    height: "10px",
    background: "transparent",
    bottom: "0",
    right: "10px",
    pointerEvents: "none",
    position: "absolute"
  }
};

const wasSubmitted = (project?: IProject) => (project ? !!project.submittedDt : undefined);

const ProjectScreen = ({
  project,
  geojson,
  staticMetadata,
  staticGeoLevels,
  evaluateMode,
  evaluateMetric,
  projectNotFound,
  findMenuOpen,
  geoUnitHierarchy,
  districtDrawing,
  mapLabel,
  isLoading,
  referenceLayers,
  isReadOnly,
  isArchived,
  user,
  limitSelectionToCounty,
  projectOptions
}: StateProps) => {
  const { projectId } = useParams();
  const [map, setMap] = useState<maplibregl.Map | undefined>(undefined);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const isNarrow = useIsNarrowViewport();
  const effectiveReadOnly = isReadOnly || isNarrow;
  const isLoggedIn = isUserLoggedIn();
  const isFirstLoadPending =
    project === undefined ||
    staticMetadata === undefined ||
    (geojson !== undefined && geojson.features.length === 0);
  const presentDrawingState = districtDrawing.undoHistory.present.state;

  const wasSubmittedRef = useRef<boolean | undefined>();

  useEffect(() => {
    if (
      wasSubmittedRef.current === false &&
      wasSubmitted(project) &&
      project?.projectTemplate?.contestNextSteps === ""
    ) {
      toast.success(
        <span>
          <Icon name="check" /> Your map was submitted!
        </span>
      );
    }
    if (project) {
      wasSubmittedRef.current = wasSubmitted(project);
    }
  }, [project]);

  // Warn the user when attempting to leave the page with selected geounits
  useBeforeunload(event => {
    // Disabling 'functional/no-conditional-statement' without naming it.

    if (areAnyGeoUnitsSelected(presentDrawingState.selectedGeounits)) {
      // Old style, used by e.g. Chrome
      // Disabling 'functional/immutable-data' without naming it.

      event.returnValue = true;
      // New style, used by e.g. Firefox
      event.preventDefault();
      // The message isn't actually displayed on most browsers
      return "You have unsaved changes. Accept or reject changes to save your map.";
    }
  });

  // Reset component redux state on unmount
  useEffect(
    () => () => {
      store.dispatch(resetProjectState());
    },
    []
  );

  // Clear duplication state when mounting, in case the user navigated to project page from a post-duplication redirect
  useEffect(() => {
    store.dispatch(clearDuplicationState());
  }, []);

  // Initialize populationKey from chamber default when project loads
  useEffect(() => {
    if (project?.chamber?.defaultPopulationField && staticMetadata) {
      const groups = staticMetadata.demographicsGroups || [];
      const hasGroup = groups.some(g => g.total === project.chamber!.defaultPopulationField);
      if (hasGroup) {
        store.dispatch(setPopulationKey(project.chamber.defaultPopulationField));
      }
    }
  }, [project?.id, staticMetadata]);

  useEffect(() => {
    isLoggedIn && store.dispatch(userFetch());
    projectId && store.dispatch(projectReferenceLayersFetch(projectId));
    projectId && store.dispatch(projectDataFetch(projectId));
  }, [projectId, isLoggedIn]);

  useEffect(() => {
    document.title = "Mike's District Maker " + (project ? `| ${project.name}` : "");
  });

  return isFirstLoadPending ? (
    <CenteredContent>
      <Flex sx={{ justifyContent: "center" }}>
        <Spinner variant="styles.spinner.large" />
      </Flex>
    </CenteredContent>
  ) : "errorMessage" in user ? (
    <Navigate to={"/login"} replace />
  ) : projectNotFound ? (
    <Flex sx={{ height: "100%", flexDirection: "column" }}>
      <SiteHeader user={user} />
      <PageNotFoundScreen model={"project"} />
    </Flex>
  ) : (
    <Flex sx={{ height: "100%", flexDirection: "column" }}>
      <ProjectHeader
        map={map}
        project={project}
        isArchived={isArchived}
        isReadOnly={isReadOnly}
        isMobile={isNarrow}
      />
      {isNarrow && !isReadOnly && (
        <Flex
          sx={{
            bg: "blue.1",
            color: "blue.8",
            px: 3,
            py: 2,
            fontSize: 1,
            justifyContent: "center",
            alignItems: "center",
            textAlign: "center"
          }}
        >
          Use a desktop browser to edit this map
        </Flex>
      )}
      <Flex sx={{ flex: 1, overflowY: "auto", position: "relative" }}>
        {isNarrow ? (
          <React.Fragment>
            {!mobileSidebarOpen && (
              <Button
                sx={{
                  position: "absolute",
                  bottom: 3,
                  left: 3,
                  zIndex: 250,
                  variant: "buttons.primary",
                  boxShadow: "medium",
                  fontSize: 1,
                  px: 3,
                  py: 2,
                  cursor: "pointer"
                }}
                onClick={() => setMobileSidebarOpen(true)}
              >
                <Icon name="bars" /> {evaluateMode ? "Evaluate" : "Districts"}
              </Button>
            )}
            {mobileSidebarOpen && (
              <Flex
                sx={{
                  position: "absolute",
                  bottom: 0,
                  left: 0,
                  right: 0,
                  height: "55vh",
                  zIndex: 300,
                  flexDirection: "column",
                  bg: "muted",
                  boxShadow: "0 -2px 8px rgba(0,0,0,0.15)",
                  borderTopLeftRadius: "8px",
                  borderTopRightRadius: "8px"
                }}
              >
                <Box
                  sx={{
                    flex: 1,
                    overflowY: "auto",
                    overflowX: "auto",
                    ".map-sidebar": { minWidth: "unset !important", height: "auto !important" },
                    ".evaluate-sidebar, .evaluate-sidebar > *": {
                      minWidth: "unset !important",
                      maxWidth: "unset !important"
                    }
                  }}
                >
                  {!evaluateMode ? (
                    <ProjectSidebar
                      project={project}
                      geojson={geojson}
                      isLoading={isLoading}
                      staticMetadata={staticMetadata}
                      selectedDistrictId={districtDrawing.selectedDistrictId}
                      selectedGeounits={presentDrawingState.selectedGeounits}
                      highlightedGeounits={districtDrawing.highlightedGeounits}
                      expandedProjectMetrics={districtDrawing.expandedProjectMetrics}
                      geoUnitHierarchy={geoUnitHierarchy}
                      referenceLayers={referenceLayers}
                      showReferenceLayers={districtDrawing.showReferenceLayers}
                      lockedDistricts={presentDrawingState.lockedDistricts}
                      hoveredDistrictId={districtDrawing.hoveredDistrictId}
                      saving={districtDrawing.saving}
                      populationKey={projectOptions.populationKey}
                      isReadOnly={effectiveReadOnly}
                      pinnedMetrics={districtDrawing.undoHistory.present.state.pinnedMetricFields}
                      onClose={() => setMobileSidebarOpen(false)}
                    />
                  ) : (
                    <ProjectEvaluateSidebar
                      geojson={geojson}
                      metric={evaluateMetric}
                      project={project}
                      staticMetadata={staticMetadata}
                      isArchived={isArchived}
                      populationKey={projectOptions.populationKey}
                      onClose={() => setMobileSidebarOpen(false)}
                    />
                  )}
                </Box>
              </Flex>
            )}
          </React.Fragment>
        ) : !evaluateMode ? (
          <ProjectSidebar
            project={project}
            geojson={geojson}
            isLoading={isLoading}
            staticMetadata={staticMetadata}
            selectedDistrictId={districtDrawing.selectedDistrictId}
            selectedGeounits={presentDrawingState.selectedGeounits}
            highlightedGeounits={districtDrawing.highlightedGeounits}
            expandedProjectMetrics={districtDrawing.expandedProjectMetrics}
            geoUnitHierarchy={geoUnitHierarchy}
            referenceLayers={referenceLayers}
            showReferenceLayers={districtDrawing.showReferenceLayers}
            lockedDistricts={presentDrawingState.lockedDistricts}
            hoveredDistrictId={districtDrawing.hoveredDistrictId}
            saving={districtDrawing.saving}
            populationKey={projectOptions.populationKey}
            isReadOnly={effectiveReadOnly}
            pinnedMetrics={districtDrawing.undoHistory.present.state.pinnedMetricFields}
          />
        ) : (
          <ProjectEvaluateSidebar
            geojson={geojson}
            metric={evaluateMetric}
            project={project}
            staticMetadata={staticMetadata}
            isArchived={isArchived}
          />
        )}
        {
          <Flex
            sx={{
              flexDirection: "column",
              flex: 1,
              background: "#fff",
              display: !evaluateMode && districtDrawing.expandedProjectMetrics ? "none" : "flex"
            }}
          >
            {!evaluateMode ? (
              <MapHeader
                label={mapLabel}
                metadata={staticMetadata}
                selectionTool={districtDrawing.selectionTool}
                findMenuOpen={findMenuOpen}
                paintBrushSize={districtDrawing.paintBrushSize}
                geoLevelIndex={presentDrawingState.geoLevelIndex}
                selectedGeounits={presentDrawingState.selectedGeounits}
                limitSelectionToCounty={limitSelectionToCounty}
                advancedEditingEnabled={project?.advancedEditingEnabled}
                isReadOnly={effectiveReadOnly}
                electionYear={projectOptions.electionYear}
                selectedOffice={projectOptions.selectedOffice}
                populationKey={projectOptions.populationKey}
              />
            ) : (
              <Flex></Flex>
            )}

            {project && staticMetadata && staticGeoLevels && geojson ? (
              <React.Fragment>
                {!effectiveReadOnly && "resource" in user && (
                  <Tour
                    geojson={geojson}
                    project={project}
                    staticMetadata={staticMetadata}
                    user={user.resource}
                  />
                )}
                <Map
                  project={project}
                  geojson={geojson}
                  staticMetadata={staticMetadata}
                  staticGeoLevels={staticGeoLevels}
                  selectedGeounits={presentDrawingState.selectedGeounits}
                  selectedDistrictId={districtDrawing.selectedDistrictId}
                  hoveredDistrictId={districtDrawing.hoveredDistrictId}
                  zoomToDistrictId={districtDrawing.zoomToDistrictId}
                  selectionTool={districtDrawing.selectionTool}
                  paintBrushSize={districtDrawing.paintBrushSize}
                  geoLevelIndex={presentDrawingState.geoLevelIndex}
                  expandedProjectMetrics={districtDrawing.expandedProjectMetrics}
                  lockedDistricts={presentDrawingState.lockedDistricts}
                  evaluateMode={evaluateMode}
                  evaluateMetric={evaluateMetric}
                  isReadOnly={effectiveReadOnly}
                  isArchived={isArchived}
                  limitSelectionToCounty={limitSelectionToCounty}
                  label={mapLabel}
                  map={map}
                  setMap={setMap}
                />
                {!effectiveReadOnly && (
                  <AdvancedEditingModal
                    id={project.id}
                    geoLevels={staticMetadata.geoLevelHierarchy}
                  />
                )}
                <CopyMapModal project={project} />
                <KeyboardShortcutsModal
                  isReadOnly={effectiveReadOnly}
                  evaluateMode={evaluateMode}
                  staticMetadata={staticMetadata}
                />
                <AddReferenceLayerModal project={project} />
                <ProjectDetailsModal project={project} geojson={geojson} />
                <SubmitMapModal project={project} />
                <DeleteReferenceLayerModal />
                <Flex id="tour-start" sx={style.tourStart}></Flex>
              </React.Fragment>
            ) : null}
          </Flex>
        }
      </Flex>
    </Flex>
  );
};

function mapStateToProps(state: State): StateProps {
  const project: IProject | undefined = destructureResource(state.project.projectData, "project");
  return {
    project,
    geojson: destructureResource(state.project.projectData, "geojson"),
    staticMetadata: destructureResource(state.project.staticData, "staticMetadata"),
    staticGeoLevels: destructureResource(state.project.staticData, "staticGeoLevels"),
    geoUnitHierarchy: destructureResource(state.project.staticData, "geoUnitHierarchy"),
    evaluateMode: state.project.evaluateMode,
    evaluateMetric: state.project.evaluateMetric,
    findMenuOpen: state.project.findMenuOpen,
    mapLabel: state.project.mapLabel,
    projectOptions: state.projectOptions,
    limitSelectionToCounty: state.projectOptions.limitSelectionToCounty,
    districtDrawing: state.project,
    referenceLayers: state.project.referenceLayers,
    isLoading:
      ("isPending" in state.project.projectData && state.project.projectData.isPending) ||
      ("isPending" in state.project.staticData && state.project.staticData.isPending),
    projectNotFound:
      "statusCode" in state.project.projectData && state.project.projectData.statusCode === 404,
    isArchived: project !== undefined && project.regionConfig.archived,
    isReadOnly: isProjectReadOnly(state),
    user: state.user
  };
}

export default connect(mapStateToProps)(ProjectScreen);
