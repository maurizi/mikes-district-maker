import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Flex, Box, Button, Slider, Text, type ThemeUIStyleObject } from "theme-ui";
import {
  type GeoLevelInfo,
  type GeoLevelHierarchy,
  type GeoUnits,
  type IStaticMetadata,
  type GroupTotal
} from "../../shared/entities";
import { type ElectionYear } from "../types";
import { toggleFind } from "../actions/districtDrawing";
import { geoLevelLabel, canSwitchGeoLevels } from "../functions";
import MapSelectionOptionsFlyout from "./MapSelectionOptionsFlyout";
import LabelAutocomplete from "./LabelAutocomplete";

import Icon from "./Icon";
import Tooltip from "./Tooltip";
import {
  setGeoLevelIndex,
  setSelectionTool,
  SelectionTool,
  type PaintBrushSize,
  setPaintBrushSize
} from "../actions/districtDrawing";
import store from "../store";
import type icons from "../icons";

const style: Record<string, ThemeUIStyleObject> = {
  buttonGroup: {
    button: {
      margin: "0 !important"
    },
    "& button > svg": {
      marginRight: "0"
    },
    "&:not(:last-of-type):not(:first-of-type) > span > button, & > button:not(:last-of-type):not(:first-of-type)":
      {
        borderRadius: 0,
        borderLeftWidth: 0
      },
    "&:first-of-type > span > button, & > button:first-of-type": {
      borderTopRightRadius: 0,
      borderBottomRightRadius: 0
    },
    "&:last-of-type > span > button, & > button:last-of-type": {
      borderTopLeftRadius: 0,
      borderBottomLeftRadius: 0,
      borderLeftWidth: 0
    },
    "&:not(:last-of-type):not(:first-of-type) > span > button[disabled], & > button:not(:last-of-type):not(:first-of-type)[disabled]":
      {
        borderRightColor: "blue.7"
      }
  },
  header: {
    variant: "styles.header.app",
    height: "auto",
    minHeight: "48px",
    backgroundColor: "white",
    alignItems: "center",
    justifyContent: "space-between",
    flexWrap: "wrap",
    gap: 1,
    px: 2,
    py: 1,
    borderBottom: "1px solid",
    borderColor: "gray.2",
    boxShadow: "small"
  },
  selectionButton: {
    variant: "buttons.outlined",
    fontSize: 1,
    py: 1,
    height: "32px",
    "&.selected": {
      bg: "blue.0",
      borderColor: "blue.2",
      borderBottom: "2px solid",
      borderBottomColor: "blue.5",
      color: "blue.8"
    }
  },
  sliderContainer: {
    position: "absolute",
    display: "flex",
    backgroundColor: "#fff",
    borderRadius: "3px",
    border: "1px solid",
    borderColor: "gray.2",
    py: 1,
    px: 2,
    top: "102px",
    zIndex: 1
  }
};

const buttonClassName = (isSelected: boolean) => `${isSelected ? "selected" : ""}`;

const GeoLevelTooltip = ({ label }: { readonly label: string }) => {
  return (
    <span>
      <strong>Disabled: </strong>
      Resolve changes to edit {label.toLowerCase()}
    </span>
  );
};

const GeoLevelButton = ({
  index,
  value,
  geoLevelIndex,
  geoLevelHierarchy,
  selectedGeounits,
  isReadOnly
}: {
  readonly index: number;
  readonly value: GeoLevelInfo;
  readonly geoLevelIndex: number;
  readonly geoLevelHierarchy: GeoLevelHierarchy;
  readonly selectedGeounits: GeoUnits;
  readonly isReadOnly: boolean;
}) => {
  const label = geoLevelLabel(value.id);
  const canSwitch = canSwitchGeoLevels(geoLevelIndex, index, geoLevelHierarchy, selectedGeounits);
  // Always show the currently selected geolevel, even if it would otherwise be disabled
  const isCurrentLevelSelected = index === geoLevelIndex;
  const isButtonDisabled = !isCurrentLevelSelected && !canSwitch;

  return (
    <Box sx={{ ...style.buttonGroup, ...{ display: "inline-block", position: "relative" } }}>
      <Tooltip
        key={index}
        content={
          isButtonDisabled ? <GeoLevelTooltip label={label} /> : `Select ${label.toLowerCase()}`
        }
      >
        <span>
          <Button
            key={index}
            sx={{ ...style.selectionButton, ...{ mr: "1px" } }}
            className={buttonClassName(geoLevelIndex === index)}
            onClick={() => store.dispatch(setGeoLevelIndex({ index, isReadOnly }))}
            disabled={isButtonDisabled}
          >
            {label}
          </Button>
        </span>
      </Tooltip>
    </Box>
  );
};

const MapHeader = ({
  label,
  metadata,
  selectionTool,
  paintBrushSize,
  geoLevelIndex,
  findMenuOpen,
  selectedGeounits,
  isReadOnly,
  limitSelectionToCounty,
  electionYear,
  selectedOffice,
  populationKey
}: {
  readonly label?: string;
  readonly metadata?: IStaticMetadata;
  readonly selectionTool: SelectionTool;
  readonly paintBrushSize: PaintBrushSize;
  readonly geoLevelIndex: number;
  readonly selectedGeounits: GeoUnits;
  readonly advancedEditingEnabled?: boolean;
  readonly isReadOnly: boolean;
  readonly findMenuOpen: boolean;
  readonly limitSelectionToCounty: boolean;
  readonly electionYear: ElectionYear;
  readonly selectedOffice: string;
  readonly populationKey: GroupTotal;
}) => {
  const [isPaintBrushSizeSliderVisible, setPaintBrushSizeSliderVisibility] = useState(false);
  const headerRef = useRef<HTMLDivElement>(null);
  const labelsGroupRef = useRef<HTMLDivElement>(null);
  const [labelsWrapped, setLabelsWrapped] = useState(false);

  const checkWrapped = useCallback(() => {
    const header = headerRef.current;
    const labelsGroup = labelsGroupRef.current;
    if (!header || !labelsGroup) return;
    // Labels group is wrapped if its top is below the header's top + some threshold
    const headerRect = header.getBoundingClientRect();
    const labelsRect = labelsGroup.getBoundingClientRect();
    setLabelsWrapped(labelsRect.top > headerRect.top + 10);
  }, []);

  useLayoutEffect(checkWrapped);

  useEffect(() => {
    const header = headerRef.current;
    if (!header) return;
    const observer = new ResizeObserver(checkWrapped);
    observer.observe(header);
    return () => observer.disconnect();
  }, [checkWrapped]);

  const topGeoLevelName = metadata
    ? metadata.geoLevelHierarchy[metadata.geoLevelHierarchy.length - 1].id
    : undefined;
  // Close paintbrush slider if the user switches to another tool, open it if toggled from another tool
  useEffect(() => {
    if (selectionTool !== SelectionTool.PaintBrush) {
      setPaintBrushSizeSliderVisibility(false);
    } else {
      setPaintBrushSizeSliderVisibility(true);
    }
  }, [selectionTool]);

  const geoLevelOptions = metadata
    ? metadata.geoLevelHierarchy
        .slice()
        .reverse()
        .map((val, index, geoLevelHierarchy) => (
          <GeoLevelButton
            key={index}
            index={index}
            value={val}
            geoLevelIndex={geoLevelIndex}
            geoLevelHierarchy={geoLevelHierarchy}
            selectedGeounits={selectedGeounits}
            isReadOnly={isReadOnly}
          />
        ))
    : [];
  const selectionToolIcons: ReadonlyArray<{
    readonly tooltipContent: string;
    readonly tool: SelectionTool;
    readonly iconName: keyof typeof icons;
  }> = [
    {
      tooltipContent: "Point-and-click selection",
      tool: SelectionTool.Default,
      iconName: "hand-pointer"
    },
    {
      tooltipContent: "Rectangle selection",
      tool: SelectionTool.Rectangle,
      iconName: "draw-square"
    },
    {
      tooltipContent: "Paint brush selection",
      tool: SelectionTool.PaintBrush,
      iconName: "paint-brush"
    }
  ];
  return (
    <Flex ref={headerRef} sx={style.header}>
      {!isReadOnly && (
        <Flex sx={{ alignItems: "center" }}>
          <Flex sx={{ ...style.buttonGroup, mr: 2 }}>
            {selectionToolIcons.map(({ tooltipContent, tool, iconName }) => (
              <Tooltip key={iconName} content={tooltipContent}>
                <Button
                  sx={{ ...style.selectionButton }}
                  className={buttonClassName(selectionTool === tool)}
                  onClick={() => {
                    // Open slider on click if not already open
                    setPaintBrushSizeSliderVisibility(tool === SelectionTool.PaintBrush);
                    store.dispatch(setSelectionTool(tool));
                  }}
                >
                  <Icon name={iconName} />
                </Button>
              </Tooltip>
            ))}
          </Flex>
          {isPaintBrushSizeSliderVisible ? (
            <Box sx={style.sliderContainer}>
              <Text sx={{ fontSize: 1, flexShrink: 0 }}>Brush size</Text>
              <Slider
                min={1}
                max={5}
                step={1}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                  store.dispatch(setPaintBrushSize(parseInt(e.target.value, 10) as PaintBrushSize));
                }}
                sx={{ width: "110px", position: "relative", top: "2px", mx: 2 }}
                value={paintBrushSize}
              />
              <Text sx={{ fontSize: 1, flexShrink: 0 }}>{paintBrushSize}</Text>
            </Box>
          ) : null}

          <Box sx={{ position: "relative", mr: 3, pt: "6px" }}>
            <MapSelectionOptionsFlyout
              limitSelectionToCounty={limitSelectionToCounty}
              topGeoLevelName={topGeoLevelName}
              metadata={metadata}
              electionYear={electionYear}
              selectedOffice={selectedOffice}
              populationKey={populationKey}
            />
          </Box>
        </Flex>
      )}
      <Flex className="geolevel-button-group" sx={{ flexShrink: 0 }}>
        {geoLevelOptions}
      </Flex>
      <Flex
        ref={labelsGroupRef}
        sx={{
          flex: 1,
          minWidth: "150px",
          ml: "auto",
          alignItems: "center",
          justifyContent: "flex-end"
        }}
      >
        <Box
          sx={{
            lineHeight: "1",
            flex: 1,
            maxWidth: labelsWrapped ? "none" : "250px",
            ml: labelsWrapped ? 0 : 3
          }}
        >
          <LabelAutocomplete metadata={metadata} selectedLabel={label} />
        </Box>
        <Box
          sx={{
            position: "relative",
            ml: 3,
            pl: 2,
            color: "gray.7",
            borderLeft: "1px solid",
            borderLeftColor: "gray.2"
          }}
        >
          <Tooltip content="Find">
            <Button
              sx={{
                variant: "buttons.icon",
                fontSize: 1,
                py: 1,
                color: "gray.7",
                border: "1px solid transparent",
                "&:hover:not([disabled]):not(:active).selected, &.selected": {
                  bg: "blue.1",
                  color: "gray.7",
                  opacity: 1,
                  borderColor: "gray.2"
                }
              }}
              onClick={() => {
                store.dispatch(toggleFind(!findMenuOpen));
              }}
              className={findMenuOpen ? "selected" : ""}
            >
              <Icon name="search" />
            </Button>
          </Tooltip>
        </Box>
      </Flex>
    </Flex>
  );
};

export default MapHeader;
