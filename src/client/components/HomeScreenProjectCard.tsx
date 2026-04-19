// SPDX-License-Identifier: AGPL-3.0-or-later
// Modifications © 2026 Michael Maurizi Jr.

import { Box, Flex, Heading, Text, type ThemeUIStyleObject } from "theme-ui";
import { Link } from "react-router-dom";

import { type IProject } from "../../shared/entities";
import ProjectListFlyout from "./ProjectListFlyout";
import TimeAgo from "timeago-react";
import ProjectDistrictsMap from "./map/ProjectDistrictsMap";
import React from "react";
import Icon from "./Icon";

const style: Record<string, ThemeUIStyleObject> = {
  featuredProject: {
    width: "100%",
    bg: "transparent",
    position: "relative",
    borderBottom: "1px solid",
    borderColor: "gray.2",
    alignItems: "center"
  },
  mapLabel: {
    p: "15px"
  },
  projectTitle: {
    textDecoration: "none",
    color: "inherit",
    "&:hover": {
      cursor: "pointer"
    },
    "&::after": {
      position: "absolute",
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      content: '""'
    }
  },
  projectRow: {
    textDecoration: "none",
    display: "flex",
    alignItems: "baseline",
    borderRadius: "med",
    marginRight: "auto",
    px: 1,
    "&:hover:not([disabled])": {
      bg: "rgba(256,256,256,0.2)",
      h2: {
        color: "primary",
        textDecoration: "underline"
      },
      p: {
        color: "blue.6"
      }
    },
    "&:focus": {
      outline: "none",
      boxShadow: "focus"
    }
  },
  flyoutButton: {
    position: "absolute",
    top: "5px",
    right: "10px"
  }
};

const HomeScreenProjectCard = ({
  project,
  isOrganizationAdmin
}: {
  readonly project: IProject;
  readonly isOrganizationAdmin: boolean;
}) => {
  return (
    <Flex sx={style.featuredProject}>
      <Box sx={{ height: "125px", width: "125px", position: "relative", mx: 3 }}>
        <ProjectDistrictsMap project={project} context={"home"} />
      </Box>
      <Box sx={style.mapLabel}>
        <Link to={`/projects/${project.id}`} sx={style.projectTitle}>
          <Heading
            as="h2"
            sx={{
              fontFamily: "heading",
              variant: "text.h5",
              mr: 3,
              mb: 1
            }}
          >
            {project.name}
          </Heading>
          <Text sx={{ fontSize: 2, color: "gray.7" }}>
            {project.regionConfig.name} · {project.numberOfDistricts} districts ·
            {project.chamber ? ` ${project.chamber.name} ` : " Custom "}
          </Text>
        </Link>
        <Text
          sx={{
            color: "gray.5",
            fontSize: 1
          }}
        >
          {project.submittedDt ? (
            <React.Fragment>
              <Icon name="check" /> Submitted <TimeAgo datetime={project.submittedDt} />
            </React.Fragment>
          ) : (
            <React.Fragment>
              Last updated <TimeAgo datetime={project.updatedDt} />
            </React.Fragment>
          )}
        </Text>
      </Box>
      <span sx={style.flyoutButton}>
        <ProjectListFlyout project={project} isOrganizationAdmin={isOrganizationAdmin} />
      </span>
    </Flex>
  );
};

export default HomeScreenProjectCard;
