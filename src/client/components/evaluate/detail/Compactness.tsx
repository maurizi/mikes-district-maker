// SPDX-License-Identifier: AGPL-3.0-or-later
// Modifications © 2026 Michael Maurizi Jr.

import { Box, Flex, type ThemeUIStyleObject, Heading } from "theme-ui";
import { getCompactnessStops } from "../../map/index";
import { type EvaluateMetricWithValue, type DistrictsGeoJSON } from "../../../types";
import { getCompactnessDisplay } from "../../ProjectSidebar";
import { computeRowFill } from "../../../functions";

const style: Record<string, ThemeUIStyleObject> = {
  table: {
    mx: 0,
    mb: 2,
    width: "100%"
  },
  th: {
    fontWeight: "bold",
    color: "gray.7",
    bg: "muted",
    fontSize: 1,
    textAlign: "left",
    pt: 2,
    px: 2,
    height: "32px",
    position: "sticky",
    top: "0",
    zIndex: 2,
    userSelect: "none",
    "&::after": {
      height: "1px",
      content: "''",
      display: "block",
      width: "100%",
      bg: "gray.2",
      bottom: "-1px",
      position: "absolute",
      left: 0,
      right: 0
    }
  },
  td: {
    fontWeight: "body",
    color: "gray.8",
    fontSize: 1,
    p: 2,
    textAlign: "left",
    verticalAlign: "bottom",
    position: "relative"
  },
  colFirst: {
    pl: 0
  },
  colLast: {
    pr: 0
  },
  blankValue: {
    color: "gray.4"
  }
};

const CompactnessMetricDetail = ({
  metric,
  geojson
}: {
  readonly metric: EvaluateMetricWithValue;
  readonly geojson?: DistrictsGeoJSON;
}) => {
  const choroplethStops = getCompactnessStops();
  return (
    <Box>
      <Heading as="h2" sx={{ variant: "text.h5", mt: 4 }}>
        Average compactness of
        {metric.value ? ` ${Math.floor(metric.value * 100)}%` : " "}
      </Heading>
      <table sx={style.table}>
        <thead>
          <tr>
            <th sx={{ ...style.th, ...style.colFirst }}>Number</th>
            <th sx={{ ...style.th, ...style.colLast }}>Compactness</th>
          </tr>
        </thead>
        <tbody>
          {geojson?.features.map(
            (feature, id) =>
              id > 0 && (
                <tr key={id}>
                  <td sx={{ ...style.td, ...style.colFirst }}>{id}</td>
                  <td sx={{ ...style.td, ...style.colLast }}>
                    {feature.properties.compactness ? (
                      <Flex sx={{ alignItems: "center" }}>
                        <div
                          sx={{
                            mr: 2,
                            width: "15px",
                            height: "15px",
                            borderRadius: "small",
                            bg: computeRowFill(choroplethStops, feature.properties.compactness)
                          }}
                        ></div>
                        <Box>{getCompactnessDisplay(feature.properties)}</Box>
                      </Flex>
                    ) : (
                      <Box sx={style.blankValue}>-</Box>
                    )}
                  </td>
                </tr>
              )
          )}
        </tbody>
      </table>
    </Box>
  );
};

export default CompactnessMetricDetail;
