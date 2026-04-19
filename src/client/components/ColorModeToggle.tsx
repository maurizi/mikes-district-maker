// SPDX-License-Identifier: AGPL-3.0-or-later
// © 2026 Michael Maurizi Jr.

import { Button as MenuButton, Wrapper, Menu, MenuItem } from "react-aria-menubutton";
import { Box, type ThemeUIStyleObject } from "theme-ui";

import {
  type ColorModePreference,
  setColorModePreference,
  useColorModePreference
} from "../hooks/useColorModePreference";

const style: Record<string, ThemeUIStyleObject> = {
  trigger: {
    display: "flex",
    alignItems: "center",
    gap: 1,
    bg: "transparent",
    color: "heading",
    fontFamily: "heading",
    fontWeight: "light",
    fontSize: 2,
    px: 2,
    py: 1,
    borderRadius: "small",
    cursor: "pointer",
    border: "none",
    "&:hover": { bg: "gray.2" },
    "&:focus": { outline: "none", boxShadow: "focus" }
  },
  triggerInvert: {
    "&:hover": { bg: "rgba(255,255,255,0.15)" }
  },
  menu: {
    position: "absolute",
    mt: 2,
    right: 0,
    minWidth: "150px",
    bg: "muted",
    py: 1,
    px: 1,
    border: "1px solid",
    borderColor: "gray.2",
    boxShadow: "small",
    borderRadius: "small",
    zIndex: 500
  },
  menuList: { p: 0, m: 0, listStyleType: "none" },
  menuItem: {
    borderRadius: "small",
    py: 1,
    px: 2,
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 2,
    color: "heading",
    "&:hover:not([disabled])": { bg: "gray.1", cursor: "pointer" },
    "&:focus": { bg: "gray.1", outline: "none" }
  },
  check: { color: "primary", fontWeight: "bold" }
};

const LABELS: Record<ColorModePreference, string> = {
  system: "System",
  light: "Light",
  dark: "Dark"
};

const GLYPHS: Record<ColorModePreference, string> = {
  system: "◐",
  light: "☀",
  dark: "☾"
};

const ColorModeToggle = ({ invert = false }: { readonly invert?: boolean }) => {
  const preference = useColorModePreference();
  const handleSelect = (value: string) => {
    if (value === "system" || value === "light" || value === "dark") {
      setColorModePreference(value);
    }
  };
  const triggerSx = invert
    ? { ...style.trigger, color: "white", ...style.triggerInvert }
    : style.trigger;
  return (
    <Wrapper onSelection={handleSelect}>
      <MenuButton sx={triggerSx} aria-label={`Theme: ${LABELS[preference]}`}>
        <span aria-hidden="true" sx={{ fontSize: 3, lineHeight: 1 }}>
          {GLYPHS[preference]}
        </span>
      </MenuButton>
      <Menu sx={style.menu}>
        <ul sx={style.menuList}>
          {(["system", "light", "dark"] as const).map(value => (
            <li key={value}>
              <MenuItem value={value} sx={style.menuItem}>
                <Box sx={{ display: "flex", alignItems: "center", gap: 2 }}>
                  <span aria-hidden="true">{GLYPHS[value]}</span>
                  <span>{LABELS[value]}</span>
                </Box>
                {preference === value && <span sx={style.check}>✓</span>}
              </MenuItem>
            </li>
          ))}
        </ul>
      </Menu>
    </Wrapper>
  );
};

export default ColorModeToggle;
