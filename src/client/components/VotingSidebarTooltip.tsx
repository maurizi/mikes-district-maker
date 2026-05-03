// SPDX-License-Identifier: AGPL-3.0-or-later
// Modifications © 2026 Michael Maurizi Jr.

import { mapValues, sum } from "lodash";
import { Box, Divider, Flex, Spinner, type ThemeUIStyleObject, Heading } from "theme-ui";

import {
  getPartyColor,
  capitalizeFirstLetter,
  extractYear,
  extractOffice,
  officeName,
  parseVotingId
} from "../functions";
import { type DemographicCounts } from "../../shared/entities";
import { type ElectionYear } from "../types";

import React from "react";

const style: Record<string, ThemeUIStyleObject> = {
  header: {
    textAlign: "left",
    color: "muted",
    py: 1,
    mb: 0
  },
  label: {
    textAlign: "left",
    py: 0,
    px: 2,
    textTransform: "capitalize"
  },
  number: {
    flex: "auto",
    textAlign: "right",
    fontVariant: "tabular-nums",
    py: 0,
    px: 1,
    fontWeight: "light"
  }
};

const Row = ({
  party,
  votes,
  percent,
  color
}: {
  readonly party: string;
  readonly votes?: number;
  readonly percent?: number;
  readonly color: string;
}) => (
  <tr
    sx={{
      color: "muted",
      border: "none"
    }}
  >
    <td>
      <Box
        style={{
          backgroundColor: color
        }}
        sx={{
          height: "15px",
          width: "15px"
        }}
      />
    </td>
    <td sx={style.label}>
      <b>{capitalizeFirstLetter(party)}</b>
    </td>
    <td sx={style.number}>{votes?.toLocaleString(undefined)}</td>
    <td sx={style.number}>
      {percent ? percent.toLocaleString(undefined, { maximumFractionDigits: 0 }) : "0"}
      {"%"}
    </td>
  </tr>
);

// Full breakdown rows for a single office (presidential)
const getPresidentialRows = ({
  voting,
  year,
  excludeOther
}: {
  readonly voting: DemographicCounts;
  readonly year?: ElectionYear;
  readonly excludeOther?: boolean;
}) => {
  const votesForYear = extractOffice(extractYear(voting, year), "");
  const total = sum(Object.values(votesForYear));
  if (total === 0) return null;
  const order = ["republican", "democrat"];
  const percentages = Object.entries(
    mapValues(votesForYear, (votes: number) => (total ? votes / total : 0) * 100)
  ).sort(([a], [b]) => {
    return order.indexOf(b) - order.indexOf(a);
  });
  const rows = percentages
    .filter(([party]) => (!excludeOther ? true : party !== "other"))
    .map(([party, percent]) => (
      <Row
        key={party}
        party={party}
        votes={votesForYear[party]}
        percent={percent}
        color={getPartyColor(party)}
      />
    ));
  return rows.length > 0 ? rows : null;
};

const PARTY_ABBREV: Record<string, string> = {
  democrat: "D",
  republican: "R",
  other: "I"
};

// Margin between 1st and 2nd place candidates in a single race.
// Returns null when no votes were cast (uncontested / no data).
function computeMargin(
  voting: DemographicCounts
): { readonly label: string; readonly color: string } | null {
  const parties = [
    { key: "democrat", votes: voting.democrat || 0 },
    { key: "republican", votes: voting.republican || 0 },
    { key: "other", votes: voting.other || 0 }
  ].sort((a, b) => b.votes - a.votes);

  const first = parties[0];
  const second = parties[1];
  const topTwo = first.votes + second.votes;
  if (topTwo === 0) return null;

  const marginPct = Math.round(((first.votes - second.votes) / topTwo) * 100);
  const abbrev = PARTY_ABBREV[first.key] || first.key;
  const color = getPartyColor(first.key === "other" ? "other party" : first.key);
  const label = marginPct === 0 ? "0" : `${abbrev}+${marginPct}`;
  return { label, color };
}

// Matrix of non-presidential races: offices on rows, years on columns,
// each cell shows the winner's margin color-coded by leading party.
// Returns null when the district has no non-presidential voting data.
const OtherRacesMatrix = ({ voting }: { readonly voting: DemographicCounts }) => {
  const otherRaces = getOtherRaces(voting);
  if (otherRaces.length === 0) return null;

  const yearSet = new Set<string>();
  const officeSet = new Set<string>();
  otherRaces.forEach(({ office, year }) => {
    yearSet.add(year);
    officeSet.add(office);
  });
  const years = Array.from(yearSet).sort();
  // getOtherRaces sorts by officeName then year, so insertion order on
  // officeSet is already the office display order we want.
  const offices = Array.from(officeSet);

  const cellMap = new Map<string, Map<string, DemographicCounts>>();
  otherRaces.forEach(({ office, year }) => {
    const officeVoting = extractOffice(extractYear(voting, year), office);
    const row = cellMap.get(office) || new Map<string, DemographicCounts>();
    row.set(year, officeVoting);
    cellMap.set(office, row);
  });

  return (
    <React.Fragment>
      <Divider sx={{ my: 1, borderColor: "gray.6" }} />
      <table
        sx={{
          margin: 0,
          width: "100%",
          fontSize: 0,
          borderCollapse: "collapse",
          color: "muted"
        }}
      >
        <thead>
          <tr>
            <th sx={{ py: 0, px: 1 }} />
            {years.map(year => (
              <th
                key={year}
                sx={{
                  textAlign: "right",
                  py: 0,
                  px: 1,
                  fontWeight: "normal",
                  fontVariant: "tabular-nums"
                }}
              >
                {`'${year}`}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {offices.map(office => (
            <tr key={office}>
              <td
                sx={{ textAlign: "left", py: "1px", px: 1, fontWeight: "bold" }}
                title={officeName(office)}
              >
                {office}
              </td>
              {years.map(year => {
                const officeVoting = cellMap.get(office)?.get(year);
                const margin = officeVoting ? computeMargin(officeVoting) : null;
                return (
                  <td
                    key={year}
                    sx={{
                      textAlign: "right",
                      py: "1px",
                      px: 1,
                      fontVariant: "tabular-nums",
                      whiteSpace: "nowrap",
                      color: margin?.color
                    }}
                  >
                    {margin ? <b>{margin.label}</b> : "—"}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </React.Fragment>
  );
};

// Discover non-presidential offices and years from raw voting data keys
function getOtherRaces(
  voting: DemographicCounts
): readonly { readonly office: string; readonly year: string }[] {
  const seen = new Set<string>();
  const combos: { office: string; year: string }[] = [];
  for (const key of Object.keys(voting)) {
    const { office, year } = parseVotingId(key);
    if (office === "") continue; // Skip presidential
    const combo = `${office}|${year}`;
    if (!seen.has(combo)) {
      seen.add(combo);
      combos.push({ office, year });
    }
  }
  combos.sort((a, b) => {
    const nameCompare = officeName(a.office).localeCompare(officeName(b.office));
    if (nameCompare !== 0) return nameCompare;
    return a.year.localeCompare(b.year);
  });
  return combos;
}

// Discover presidential years from voting data keys (keys without an office prefix).
// Filters out midterm years (YY not divisible by 4): bare `democrat18`/
// `democrat22` can appear when a state has only midterm data for that year.
function getPresidentialYears(voting: DemographicCounts): readonly string[] {
  const years = new Set<string>();
  for (const key of Object.keys(voting)) {
    const { office, year } = parseVotingId(key);
    if (office === "" && year && parseInt(year, 10) % 4 === 0) {
      years.add(year);
    }
  }
  // Check for unspecified year (keys like "democrat" with no suffix)
  if (years.size === 0 && ("democrat" in voting || "republican" in voting)) {
    return [""]; // signal for unspecified year
  }
  return Array.from(years).sort();
}

const VotingSidebarTooltip = ({
  voting,
  excludeOther,
  isLoadingMore
}: {
  readonly voting: DemographicCounts;
  readonly excludeOther?: boolean;
  // True when the rendered geojson's voting object is a strict subset
  // of what the region exposes — i.e. the post-paint all-voting
  // prefetch is still in flight. The tooltip renders whatever rows it
  // already has and shows a centered spinner at the bottom so the user
  // knows more rows are coming.
  readonly isLoadingMore?: boolean;
}) => {
  const presYears = getPresidentialYears(voting);

  return (
    <Box sx={{ width: "100%", minHeight: "100%" }}>
      {presYears.map(year => {
        const rows = getPresidentialRows({
          voting,
          year: year ? year : undefined,
          excludeOther
        });
        if (!rows) return null;
        const heading = year ? `Presidential 20${year}` : "Presidential";
        return (
          <React.Fragment key={year || "unspecified"}>
            <Heading as="h5" sx={style.header}>
              {heading}
            </Heading>
            <table sx={{ margin: "0", width: "100%" }}>
              <tbody>{rows}</tbody>
            </table>
          </React.Fragment>
        );
      })}
      <OtherRacesMatrix voting={voting} />
      {isLoadingMore && (
        <Flex sx={{ justifyContent: "center", alignItems: "center", py: 2, mt: 1 }}>
          <Spinner variant="styles.spinner.small" />
        </Flex>
      )}
    </Box>
  );
};

export default VotingSidebarTooltip;
