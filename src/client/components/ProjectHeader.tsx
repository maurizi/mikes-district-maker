import type maplibregl from "maplibre-gl";
import React, { useState } from "react";
import { connect } from "react-redux";
import { Link } from "react-router-dom";
import Logo from "../media/logos/mark-white.svg?react";
import { Box, Button, Flex, type ThemeUIStyleObject } from "theme-ui";
import { type IProject } from "../../shared/entities";
import { undo, redo, toggleEvaluate } from "../actions/districtDrawing";
import { heights } from "../theme";
import ColorModeToggle from "../components/ColorModeToggle";
import CopyMapButton from "../components/CopyMapButton";
import ExportMenu from "../components/ExportMenu";
import Icon from "../components/Icon";
import ProjectName from "../components/ProjectName";
import ShareMenu from "../components/ShareMenu";
import SupportMenu from "../components/SupportMenu";
import store from "../store";
import { type State } from "../reducers";
import { type UndoHistory } from "../reducers/undoRedo";

import { style as menuButtonStyle } from "./MenuButton.styles";
import SubmitMapButton from "./map/SubmitMapButton";

const style: Record<string, ThemeUIStyleObject> = {
  undoRedo: {
    variant: "buttons.icon",
    color: "white"
  },
  projectHeader: {
    variant: "styles.header.app",
    backgroundColor: "blue.8",
    borderBottom: "1px solid",
    borderColor: "blue.6"
  },
  menuButton: {
    color: "white"
  }
};

const HeaderDivider = () => {
  return (
    <Box
      sx={{
        marginLeft: 3,
        paddingLeft: 3,
        height: heights.header,
        borderLeft: "1px solid rgba(255, 255, 255, 0.25)"
      }}
    />
  );
};

interface StateProps {
  readonly evaluateMode: boolean;
  readonly undoHistory: UndoHistory;
  readonly isOwnProject: boolean;
}

const EvaluateButton = ({ evaluateMode }: { readonly evaluateMode: boolean }) => (
  <Box sx={{ position: "relative" }}>
    <Button
      sx={{
        ...{
          variant: "buttons.secondary",
          fontWeight: "light",
          maxHeight: "34px",
          borderBottom: evaluateMode ? "solid 3px" : "none",
          borderBottomColor: "blue.2"
        },
        ...menuButtonStyle.menuButton
      }}
      onClick={() => store.dispatch(toggleEvaluate(!evaluateMode))}
    >
      <span
        sx={{
          mb: evaluateMode ? "-3px" : "0"
        }}
      >
        Evaluate
      </span>
    </Button>
  </Box>
);

const MobileActionsMenu = ({ children }: { readonly children: React.ReactNode }) => {
  const [open, setOpen] = useState(false);
  return (
    <Box sx={{ position: "relative" }}>
      <Button
        sx={{
          variant: "buttons.icon",
          color: "white",
          cursor: "pointer"
        }}
        onClick={() => setOpen(!open)}
        aria-label="More actions"
      >
        <Icon name="ellipsis" />
      </Button>
      {open && (
        <Flex
          sx={{
            position: "absolute",
            top: "100%",
            right: 0,
            mt: 1,
            bg: "blue.8",
            border: "1px solid",
            borderColor: "blue.6",
            borderRadius: "small",
            boxShadow: "medium",
            flexDirection: "column",
            zIndex: 500,
            minWidth: "160px",
            py: 1
          }}
          onClick={() => setOpen(false)}
        >
          {children}
        </Flex>
      )}
    </Box>
  );
};

const ProjectHeader = ({
  evaluateMode,
  map,
  project,
  isArchived,
  isOwnProject,
  isReadOnly,
  isMobile,
  undoHistory
}: {
  readonly map?: maplibregl.Map;
  readonly project?: IProject;
  readonly isArchived: boolean;
  readonly isOwnProject: boolean;
  readonly isReadOnly: boolean;
  readonly isMobile: boolean;
} & StateProps) => {
  const mobileOwnProject = isMobile && !isReadOnly;

  return (
    <Flex sx={style.projectHeader}>
      <Flex
        sx={{
          variant: "styles.header.left",
          ...(isMobile ? { overflow: "hidden", flex: 1, minWidth: 0 } : {})
        }}
      >
        <Link
          to="/"
          sx={{
            lineHeight: "0",
            borderRadius: "small",
            flexShrink: 0,
            "&:focus": { outline: "none", boxShadow: "focus" }
          }}
        >
          <Logo sx={{ width: "1.75rem" }} />
        </Link>
        <HeaderDivider />
        <Box
          sx={
            isMobile ? { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } : {}
          }
        >
          {project ? <ProjectName project={project} isReadOnly={isReadOnly || isMobile} /> : "..."}
        </Box>
      </Flex>
      <Flex sx={{ variant: "styles.header.right", flex: isMobile ? "none" : "1" }}>
        {mobileOwnProject ? (
          <React.Fragment>
            <EvaluateButton evaluateMode={evaluateMode} />
            <MobileActionsMenu>
              <Box sx={{ px: 2, py: 1 }}>
                <ShareMenu invert={true} project={project} />
              </Box>
              <Box sx={{ px: 2, py: 1 }}>
                {project ? (
                  <ExportMenu isArchived={isArchived} invert={true} project={project} />
                ) : null}
              </Box>
            </MobileActionsMenu>
          </React.Fragment>
        ) : !isReadOnly ? (
          <React.Fragment>
            {map && (
              <React.Fragment>
                <Button
                  sx={style.undoRedo}
                  disabled={undoHistory.past.length === 0}
                  onClick={() => store.dispatch(undo())}
                >
                  <Icon name="undo" />
                </Button>
                <Button
                  sx={{ ...style.undoRedo, mr: 4 }}
                  disabled={undoHistory.future.length === 0}
                  onClick={() => store.dispatch(redo())}
                >
                  <Icon name="redo" />
                </Button>
              </React.Fragment>
            )}
            <ShareMenu invert={true} project={project} />
            <SupportMenu invert={true} project={true} />
            {project ? (
              <ExportMenu isArchived={isArchived} invert={true} project={project} />
            ) : null}
            <EvaluateButton evaluateMode={evaluateMode} />
            <ColorModeToggle invert={true} />
            <SubmitMapButton project={project} />
          </React.Fragment>
        ) : isMobile ? (
          <React.Fragment>
            <EvaluateButton evaluateMode={evaluateMode} />
            <ColorModeToggle invert={true} />
            <MobileActionsMenu>
              {!isArchived && (
                <Box sx={{ px: 2, py: 1 }}>
                  <CopyMapButton invert={true} />
                </Box>
              )}
              {project && (
                <Box sx={{ px: 2, py: 1 }}>
                  <ExportMenu isArchived={isArchived} invert={true} project={project} />
                </Box>
              )}
            </MobileActionsMenu>
          </React.Fragment>
        ) : (
          <React.Fragment>
            {!isArchived && <CopyMapButton invert={true} />}
            {project && <ExportMenu isArchived={isArchived} invert={true} project={project} />}
            <EvaluateButton evaluateMode={evaluateMode} />
            <ColorModeToggle invert={true} />
            {isOwnProject && <SubmitMapButton project={project} />}
          </React.Fragment>
        )}
      </Flex>
    </Flex>
  );
};

function mapStateToProps(state: State): StateProps {
  return {
    evaluateMode: state.project.evaluateMode,
    undoHistory: state.project.undoHistory,
    isOwnProject:
      "resource" in state.user &&
      "resource" in state.project.projectData &&
      state.user.resource.id === state.project.projectData.resource.project.user.id
  };
}

export default connect(mapStateToProps)(ProjectHeader);
