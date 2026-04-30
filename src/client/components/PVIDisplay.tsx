// SPDX-License-Identifier: AGPL-3.0-or-later
// Modifications © 2026 Michael Maurizi Jr.

import { Box, useColorMode } from "theme-ui";
import { type DistrictProperties } from "../../shared/entities";
import { type ElectionYear } from "../types";
import { getPartyTextColor, calculatePVI } from "../functions";
import Tooltip from "./Tooltip";
import VotingSidebarTooltip from "./VotingSidebarTooltip";

const BLANK_VALUE = "–";

export function getPvi(properties: DistrictProperties, year?: ElectionYear) {
  const voting = Object.keys(properties.voting || {}).length > 0 ? properties.voting : undefined;

  return year !== "combined"
    ? voting && calculatePVI(voting, year)
    : voting && calculatePVI(voting);
}

const PVIDisplay = ({
  properties,
  year,
  isLoadingMore
}: {
  readonly properties: DistrictProperties;
  readonly year?: ElectionYear;
  readonly isLoadingMore?: boolean;
}) => {
  // The voting object can be present but have no data, we treat this case as if it isn't there

  const voting = Object.keys(properties.voting || {}).length > 0 ? properties.voting : undefined;
  const pvi = getPvi(properties, year);
  const [colorMode] = useColorMode();

  const color = getPartyTextColor(
    pvi && pvi > 0 ? "democrat" : "republican",
    colorMode === "dark" ? "dark" : "light"
  );
  const partyLabel = pvi && pvi > 0 ? "D" : "R";
  const votingDisplay =
    pvi !== undefined ? (
      <Box sx={{ color }}>{`${partyLabel}+${Math.abs(pvi).toLocaleString(undefined, {
        maximumFractionDigits: 0
      })}`}</Box>
    ) : (
      <span sx={{ color: "gray.4" }}>{BLANK_VALUE}</span>
    );
  return voting ? (
    <Tooltip
      placement="top-start"
      content={
        pvi !== undefined ? (
          <VotingSidebarTooltip
            voting={voting}
            excludeOther={true}
            isLoadingMore={isLoadingMore}
          />
        ) : (
          <em>
            <strong>Empty district.</strong> Add people to this district to view the vote totals
          </em>
        )
      }
    >
      <span>{votingDisplay}</span>
    </Tooltip>
  ) : (
    <span>N/A</span>
  );
};

export default PVIDisplay;
