import React, { useState, useRef, useEffect } from "react";
import { Box, Input, type ThemeUIStyleObject } from "theme-ui";
import {
  useFloating,
  useClick,
  useDismiss,
  useInteractions,
  offset,
  flip,
  shift,
  size,
  FloatingPortal
} from "@floating-ui/react";

import { capitalizeFirstLetter, officeName, parseVotingId } from "../functions";
import { type IStaticMetadata } from "../../shared/entities";
import store from "../store";
import { setMapLabel } from "../actions/districtDrawing";
import Icon from "./Icon";

interface LabelOption {
  readonly id: string;
  readonly label: string;
  readonly group: string;
}

function buildOptions(metadata: IStaticMetadata): readonly LabelOption[] {
  const options: LabelOption[] = [];

  // Demographics
  if (metadata.demographics) {
    for (const file of metadata.demographics) {
      options.push({
        id: file.id,
        label: capitalizeFirstLetter(file.id),
        group: "Demographics"
      });
    }
  }

  // Voting — group by office+year
  if (metadata.voting) {
    const grouped: Record<string, { id: string; party: string }[]> = {};
    const groupOrder: string[] = [];

    for (const file of metadata.voting) {
      const { office, party, year } = parseVotingId(file.id);
      const yearLabel = year ? ` '${year}` : "";
      const groupKey = `${officeName(office)}${yearLabel}`;

      if (!grouped[groupKey]) {
        grouped[groupKey] = [];
        groupOrder.push(groupKey);
      }
      grouped[groupKey].push({ id: file.id, party });
    }

    // Sort: Presidential first, then alphabetically
    groupOrder.sort((a, b) => {
      const aIsPres = a.startsWith("Presidential");
      const bIsPres = b.startsWith("Presidential");
      if (aIsPres && !bIsPres) return -1;
      if (!aIsPres && bIsPres) return 1;
      return a.localeCompare(b);
    });

    const partyOrder = ["democrat", "republican", "other"];
    for (const groupKey of groupOrder) {
      const items = grouped[groupKey];
      items.sort((a, b) => partyOrder.indexOf(a.party) - partyOrder.indexOf(b.party));
      for (const item of items) {
        options.push({
          id: item.id,
          label: capitalizeFirstLetter(item.party),
          group: groupKey
        });
      }
    }
  }

  return options;
}

function getDisplayLabel(options: readonly LabelOption[], selectedId?: string): string {
  if (!selectedId) return "";
  const opt = options.find(o => o.id === selectedId);
  return opt ? `${opt.group} — ${opt.label}` : selectedId;
}

const style: Record<string, ThemeUIStyleObject> = {
  groupHeader: {
    fontSize: 0,
    fontWeight: "bold",
    color: "gray.6",
    px: 2,
    py: 1,
    textTransform: "uppercase",
    letterSpacing: "0.05em",
    borderBottom: "1px solid",
    borderColor: "gray.2",
    position: "sticky",
    top: 0,
    bg: "white",
    zIndex: 1
  },
  option: {
    px: 2,
    py: "6px",
    cursor: "pointer",
    fontSize: 1,
    "&:hover": {
      bg: "blue.0"
    }
  },
  optionSelected: {
    px: 2,
    py: "6px",
    cursor: "pointer",
    fontSize: 1,
    bg: "blue.1",
    fontWeight: "bold",
    "&:hover": {
      bg: "blue.0"
    }
  }
};

const LabelAutocomplete = ({
  metadata,
  selectedLabel
}: {
  readonly metadata?: IStaticMetadata;
  readonly selectedLabel?: string;
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const options = metadata ? buildOptions(metadata) : [];

  const { refs, floatingStyles, context } = useFloating({
    open: isOpen,
    onOpenChange: setIsOpen,
    placement: "bottom-end",
    middleware: [
      offset(4),
      flip(),
      shift({ padding: 5 }),
      size({
        apply({ availableHeight, elements }) {
          Object.assign(elements.floating.style, {
            maxHeight: `${Math.min(availableHeight - 10, 400)}px`
          });
        }
      })
    ]
  });

  const click = useClick(context);
  const dismiss = useDismiss(context);
  const { getReferenceProps, getFloatingProps } = useInteractions([click, dismiss]);

  // Reset filter when opening
  useEffect(() => {
    if (isOpen) {
      setFilter("");
      // Focus input after opening
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [isOpen]);

  const filterLower = filter.toLowerCase();
  const filteredOptions = filterLower
    ? options.filter(
        o =>
          o.label.toLowerCase().includes(filterLower) ||
          o.group.toLowerCase().includes(filterLower) ||
          o.id.toLowerCase().includes(filterLower)
      )
    : options;

  // Group filtered options for rendering
  const groups: { group: string; items: LabelOption[] }[] = [];
  let currentGroup: { group: string; items: LabelOption[] } | null = null;
  for (const opt of filteredOptions) {
    if (!currentGroup || currentGroup.group !== opt.group) {
      currentGroup = { group: opt.group, items: [] };
      groups.push(currentGroup);
    }
    currentGroup.items.push(opt);
  }

  const displayValue = isOpen ? filter : getDisplayLabel(options, selectedLabel);

  return (
    <Box sx={{ position: "relative" }}>
      <Input
        ref={e => {
          // Merge refs: floating-ui reference + our input ref
          refs.setReference(e);
          (inputRef as React.MutableRefObject<HTMLInputElement | null>).current = e;
        }}
        value={displayValue}
        placeholder="Labels ..."
        onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
          setFilter(e.target.value);
          if (!isOpen) setIsOpen(true);
        }}
        onKeyDown={(e: React.KeyboardEvent) => {
          if (e.key === "Escape") {
            setIsOpen(false);
          }
        }}
        sx={{
          width: "250px",
          fontSize: 1,
          py: 1,
          px: 2,
          border: "1px solid",
          borderColor: "gray.2",
          borderRadius: "4px",
          cursor: "pointer",
          "&:focus": {
            borderColor: "blue.3",
            outline: "none"
          }
        }}
        {...getReferenceProps()}
      />
      {selectedLabel && !isOpen && (
        <Box
          as="button"
          onClick={(e: React.MouseEvent) => {
            e.stopPropagation();
            store.dispatch(setMapLabel(undefined));
          }}
          sx={{
            position: "absolute",
            right: "6px",
            top: "50%",
            transform: "translateY(-50%)",
            background: "none",
            border: "none",
            cursor: "pointer",
            color: "gray.5",
            fontSize: 1,
            p: 0,
            lineHeight: 1,
            "&:hover": { color: "gray.8" }
          }}
        >
          <Icon name="times" />
        </Box>
      )}
      {isOpen && (
        <FloatingPortal>
          <Box
            ref={refs.setFloating}
            style={floatingStyles}
            sx={{
              bg: "white",
              border: "1px solid",
              borderColor: "gray.2",
              borderRadius: "4px",
              boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
              overflowY: "auto",
              zIndex: 9999,
              minWidth: "220px"
            }}
            {...getFloatingProps()}
          >
            {groups.length === 0 && (
              <Box sx={{ px: 2, py: 2, color: "gray.5", fontSize: 1 }}>No matches</Box>
            )}
            {groups.map(({ group, items }) => (
              <Box key={group}>
                <Box sx={style.groupHeader}>{group}</Box>
                {items.map(opt => (
                  <Box
                    key={opt.id}
                    sx={opt.id === selectedLabel ? style.optionSelected : style.option}
                    onClick={() => {
                      store.dispatch(setMapLabel(opt.id));
                      setIsOpen(false);
                    }}
                  >
                    {opt.label}
                  </Box>
                ))}
              </Box>
            ))}
          </Box>
        </FloatingPortal>
      )}
    </Box>
  );
};

export default LabelAutocomplete;
