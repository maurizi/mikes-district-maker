import { Box, type ThemeUIStyleObject } from "theme-ui";
import React from "react";

import { type ProjectNest } from "../../../shared/entities";

const style: Record<string, ThemeUIStyleObject> = {
  mapContainer: {
    display: "inline-block",
    position: "relative",
    p: "10px",
    left: 0
  }
};

const ProjectDistrictsMap = ({
  project,
  context
}: {
  readonly project: ProjectNest;
  readonly context: "home" | "communityMaps";
}) => {
  const containerSx =
    context === "communityMaps"
      ? { ...style.mapContainer, width: "100%", height: "200px" }
      : { ...style.mapContainer, width: "100%", height: "125px" };
  return (
    <Box sx={containerSx}>
      {project.thumbnailUrl && (
        <img
          src={project.thumbnailUrl}
          alt={project.name}
          style={{
            position: "absolute",
            top: "10px",
            bottom: "10px",
            left: "10px",
            right: "10px",
            width: "calc(100% - 20px)",
            height: "calc(100% - 20px)",
            objectFit: "contain"
          }}
        />
      )}
    </Box>
  );
};

export default ProjectDistrictsMap;
