// SPDX-License-Identifier: AGPL-3.0-or-later
// Modifications © 2026 Michael Maurizi Jr.

import { Box, Flex, Heading, Text, type ThemeUIStyleObject } from "theme-ui";
import { Link } from "react-router-dom";

import { type ProjectNest } from "../../shared/entities";
import ProjectDistrictsMap from "./map/ProjectDistrictsMap";

const style: Record<string, ThemeUIStyleObject> = {
  featuredProject: {
    flexDirection: "column",
    bg: "muted",
    borderRadius: "2px",
    boxShadow: "small",
    textDecoration: "none",
    color: "inherit"
  },
  mapLabel: {
    p: "15px",
    borderColor: "gray.2",
    borderTopWidth: "1px",
    borderTopStyle: "solid"
  }
};

const FeaturedProjectCard = ({ project }: { readonly project: ProjectNest }) => {
  return (
    <Flex as={Link} {...({ to: `/projects/${project.id}` } as any)} sx={style.featuredProject}>
      <ProjectDistrictsMap project={project} context={"communityMaps"} />
      <Box sx={style.mapLabel}>
        <Heading
          as="h3"
          sx={{
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
            fontSize: "2",
            mb: "1"
          }}
        >
          {project.name}
        </Heading>
        <Text
          sx={{
            fontSize: "1"
          }}
        >
          by {project.user?.name}
        </Text>
      </Box>
    </Flex>
  );
};

export default FeaturedProjectCard;
