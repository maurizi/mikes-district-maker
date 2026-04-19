// SPDX-License-Identifier: AGPL-3.0-or-later
// Modifications © 2026 Michael Maurizi Jr.

import {
  Box,
  Button,
  Flex,
  IconButton,
  type ThemeUIStyleObject,
  Heading,
  Text,
  Select
} from "theme-ui";
import { type IProject, type IStaticMetadata } from "../../../shared/entities";
import Icon from "../Icon";
import {
  type DistrictsGeoJSON,
  type ElectionYear,
  type EvaluateMetricWithValue,
  type PviBucket
} from "../../types";
import store from "../../store";
import { selectEvaluationMetric } from "../../actions/districtDrawing";
import { getAvailablePresidentialYears } from "../../functions";
import ContiguityMetricDetail from "./detail/Contiguity";
import CompactnessMetricDetail from "./detail/Compactness";
import CountySplitMetricDetail from "./detail/CountySplit";
import EqualPopulationMetricDetail from "./detail/EqualPopulation";
import CompetitivenessMetricDetail from "./detail/Competitiveness";
import MajorityRaceMetricDetail from "./detail/MajorityRace";

const style: Record<string, ThemeUIStyleObject> = {
  header: {
    variant: "styles.header.app",
    flexDirection: "column",
    justifyContent: "center",
    bg: "muted",
    py: 0,
    px: 3
  },
  metricText: {
    fontSize: 2,
    color: "gray.6",
    mt: 1
  }
};

const ProjectEvaluateMetricDetail = ({
  geojson,
  metric,
  project,
  geoLevel,
  electionYear,
  pviBuckets,
  setElectionYear,
  staticMetadata,
  onClose
}: {
  readonly geojson?: DistrictsGeoJSON;
  readonly metric: EvaluateMetricWithValue;
  readonly project?: IProject;
  readonly geoLevel: string;
  readonly electionYear: ElectionYear | undefined;
  readonly pviBuckets: readonly (PviBucket | undefined)[] | undefined;
  readonly setElectionYear: (year: ElectionYear) => void;
  readonly staticMetadata?: IStaticMetadata;
  readonly onClose?: () => void;
}) => {
  return (
    <Flex sx={{ variant: "styles.sidebar.white" }}>
      <Flex
        sx={{ ...style.header, flexDirection: "row", justifyContent: "space-between" }}
        className="evaluate-metric-header"
      >
        <Box sx={{ display: "block", my: "auto" }}>
          <Button
            variant="linkStyle"
            onClick={() => store.dispatch(selectEvaluationMetric(undefined))}
          >
            <Icon name="long-arrow-left" /> Back to summary
          </Button>
        </Box>
        {onClose && (
          <IconButton variant="icon" onClick={onClose} aria-label="Close" sx={{ my: "auto" }}>
            <Icon name="times" />
          </IconButton>
        )}
      </Flex>
      <Flex
        sx={{
          display: "block",
          bg: "muted",
          pt: 2,
          pb: 3,
          px: 3,
          borderBottom: "1px solid",
          borderColor: "gray.2"
        }}
      >
        <Flex sx={{ alignItems: "center", mb: 2 }}>
          {"status" in metric ? (
            metric.status ? (
              <Box sx={{ lineHeight: "heading", mr: 2 }}>
                <Icon name={"check-circle-solid"} color="success.3" />
              </Box>
            ) : (
              <Box sx={{ lineHeight: "heading", mr: 2 }}>
                <Icon name={"times-circle-solid"} color="error" />
              </Box>
            )
          ) : (
            <Box></Box>
          )}
          <Heading as="h1" sx={{ variant: "text.h4", m: 0, textTransform: "capitalize" }}>
            {metric.name}
          </Heading>
          {"hasMultipleElections" in metric &&
            metric.hasMultipleElections &&
            (() => {
              const presYears = getAvailablePresidentialYears(staticMetadata);
              // Adjacent pairs, latest first: [[20,24],[16,20]] for years [16,20,24].
              const combinedPairs: readonly (readonly [string, string])[] = presYears
                .slice(0, -1)
                .map((y, i) => [y, presYears[i + 1]] as const)
                .slice()
                .reverse();
              const combinedValues = combinedPairs.map(([a, b]) => `combined:${a}-${b}`);
              const validValues = new Set<string>([...combinedValues, ...presYears]);
              return (
                <Box>
                  <Select
                    id="election-dropdown"
                    value={electionYear || undefined}
                    onChange={(e: React.ChangeEvent<HTMLSelectElement>) => {
                      const year = e.currentTarget.value;
                      if (validValues.has(year)) setElectionYear(year);
                    }}
                    sx={{ width: "250px", ml: "20px" }}
                  >
                    {combinedPairs.map(([a, b]) => (
                      <option
                        key={`combined:${a}-${b}`}
                        value={`combined:${a}-${b}`}
                      >{`Combined 20${a} / 20${b} PVI`}</option>
                    ))}
                    {presYears.map(y => (
                      <option key={y} value={y}>{`20${y} PVI`}</option>
                    ))}
                  </Select>
                </Box>
              );
            })()}
        </Flex>
        <Text sx={style.metricText}>{metric.longText || "Lorem ipsum lorem ipsum"}</Text>
      </Flex>
      <Box sx={{ px: 3, overflowY: "auto" }}>
        {project ? (
          metric && "type" in metric && metric.key === "countySplits" ? (
            <CountySplitMetricDetail
              project={project}
              metric={metric}
              geoLevel={geoLevel}
              staticMetadata={staticMetadata}
            />
          ) : metric && "type" in metric && metric.key === "compactness" ? (
            <CompactnessMetricDetail metric={metric} geojson={geojson} />
          ) : metric && "type" in metric && metric.key === "contiguity" ? (
            <ContiguityMetricDetail metric={metric} geojson={geojson} />
          ) : metric && "type" in metric && metric.key === "equalPopulation" ? (
            <EqualPopulationMetricDetail metric={metric} geojson={geojson} />
          ) : metric && "type" in metric && metric.key === "competitiveness" ? (
            <CompetitivenessMetricDetail
              metric={metric}
              geojson={geojson}
              project={project}
              pviBuckets={pviBuckets}
            />
          ) : metric && "type" in metric && metric.key === "majorityMinority" ? (
            <MajorityRaceMetricDetail metric={metric} geojson={geojson} metadata={staticMetadata} />
          ) : null
        ) : null}
      </Box>
    </Flex>
  );
};

export default ProjectEvaluateMetricDetail;
