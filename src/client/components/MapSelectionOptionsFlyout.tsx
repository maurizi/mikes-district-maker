import { useState } from "react";
import { Checkbox, Flex, Label, Radio, Select, Heading, ThemeUIStyleObject } from "theme-ui";
import { Button as MenuButton, Wrapper, Menu } from "react-aria-menubutton";
import { style as menuStyle } from "./MenuButton.styles";
import store from "../store";
import {
  toggleLimitDrawingToWithinCounty,
  setElectionYear,
  setSelectedOffice,
  setPopulationKey
} from "../actions/projectOptions";
import Tooltip from "./Tooltip";
import Icon from "./Icon";
import { IStaticMetadata, GroupTotal } from "../../shared/entities";
import { ElectionYear } from "../types";
import { getOfficeYearCombos, officeName } from "../functions";

const POPULATION_LABELS: { readonly [key: string]: string } = {
  population: "All people",
  VAP: "Voting age population (VAP)",
  CVAP: "Citizen voting age population (CVAP)"
};

const style: Record<string, ThemeUIStyleObject> = {
  button: {
    outline: "none",
    display: "inline-block",
    height: "22px",
    width: "22px",
    textAlign: "center",
    borderRadius: "100px",
    cursor: "pointer",
    "&:hover:not([disabled]):not(:active)": {
      bg: "rgba(89, 89, 89, 0.1)"
    },
    "&:focus": {
      boxShadow: "0 0 0 2px rgb(109 152 186 / 30%)"
    }
  },
  menuItem: {
    mb: 2
  },
  inputLabel: {
    textTransform: "none",
    color: "heading",
    lineHeight: "normal",
    fontWeight: "medium",
    "> div": {
      minWidth: "32px"
    }
  },
  electionRow: {
    alignItems: "center",
    gap: 2,
    mt: 1,
    mb: 1
  },
  yearRadio: {
    textTransform: "none",
    color: "heading",
    lineHeight: "normal",
    fontWeight: "medium",
    width: "auto",
    "> div": {
      minWidth: "24px"
    }
  },
  officeSelect: {
    flex: "1 1 auto",
    minWidth: "140px",
    py: 1
  }
};

const MapSelectionOptionsFlyout = ({
  limitSelectionToCounty,
  metadata,
  topGeoLevelName,
  electionYear,
  selectedOffice,
  populationKey
}: {
  readonly limitSelectionToCounty: boolean;
  readonly metadata?: IStaticMetadata;
  readonly topGeoLevelName?: string;
  readonly electionYear: ElectionYear;
  readonly selectedOffice: string;
  readonly populationKey: GroupTotal;
}) => {
  const votingIds = metadata?.voting?.map(file => file.id) || [];
  const officeYearCombos = getOfficeYearCombos(votingIds);
  const hasElections = officeYearCombos.length > 0;
  const availableYears = Array.from(new Set(officeYearCombos.map(c => c.year))).sort();
  const officesByYear = (year: string) =>
    officeYearCombos.filter(c => c.year === year).map(c => c.office);
  // Remember the office picked per year so switching back restores the prior choice
  const [officeByYear, setOfficeByYear] = useState<Record<string, string>>(() => ({
    [electionYear]: selectedOffice
  }));
  const officeForRow = (year: string): string => {
    const offices = officesByYear(year);
    if (year === electionYear && offices.includes(selectedOffice)) return selectedOffice;
    const remembered = officeByYear[year];
    if (remembered && offices.includes(remembered)) return remembered;
    return offices[0] || "";
  };
  const populations =
    metadata?.demographicsGroups?.flatMap(group =>
      group.total && Object.keys(POPULATION_LABELS).includes(group.total) ? [group.total] : []
    ) || [];
  const hasMultiplePopulationTotals = populations.length > 1;
  return (
    <Wrapper closeOnSelection={false}>
      <Tooltip content="Drawing options">
        <MenuButton sx={style.button}>
          <Icon name="cog" />
        </MenuButton>
      </Tooltip>
      <Menu sx={{ ...menuStyle.menu, p: 3, maxHeight: "400px", overflowY: "auto", width: "270px" }}>
        <ul sx={menuStyle.menuList}>
          <li sx={style.menuItem}>
            <Heading as="h4">Drawing</Heading>
            <Label sx={style.inputLabel}>
              <Checkbox
                onChange={() => {
                  store.dispatch(toggleLimitDrawingToWithinCounty());
                }}
                defaultChecked={limitSelectionToCounty}
              />
              Limit drawing to within {topGeoLevelName}
            </Label>
          </li>
          {hasElections && (
            <li sx={style.menuItem}>
              <Heading as="h4">Tooltip</Heading>
              <legend>Selected office</legend>
              {availableYears.map(year => {
                const isSelectedYear = electionYear === year;
                const rowOffice = officeForRow(year);
                return (
                  <Flex sx={style.electionRow} key={year}>
                    <Label sx={style.yearRadio}>
                      <Radio
                        name="map-selection-election-year"
                        value={year}
                        checked={isSelectedYear}
                        onChange={() => {
                          store.dispatch(setElectionYear(year));
                          store.dispatch(setSelectedOffice(rowOffice));
                        }}
                      />
                      {`20${year}`}
                    </Label>
                    <Select
                      value={rowOffice}
                      disabled={!isSelectedYear}
                      onChange={e => {
                        const newOffice = e.target.value;
                        setOfficeByYear(prev => ({ ...prev, [year]: newOffice }));
                        store.dispatch(setSelectedOffice(newOffice));
                      }}
                      sx={style.officeSelect}
                    >
                      {officesByYear(year).map(office => (
                        <option key={office} value={office}>
                          {officeName(office)}
                        </option>
                      ))}
                    </Select>
                  </Flex>
                );
              })}
            </li>
          )}
          {hasMultiplePopulationTotals && (
            <li>
              <Heading as="h4">Districts</Heading>
              <legend>Population</legend>
              {populations?.map(key => (
                <Label sx={style.inputLabel} key={key}>
                  <Radio
                    name="map-selection-population"
                    value={key}
                    checked={populationKey === key}
                    onChange={() => {
                      store.dispatch(setPopulationKey(key));
                    }}
                  />
                  {POPULATION_LABELS[key]}
                </Label>
              ))}
            </li>
          )}
        </ul>
      </Menu>
    </Wrapper>
  );
};

export default MapSelectionOptionsFlyout;
