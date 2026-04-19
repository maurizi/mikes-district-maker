// SPDX-License-Identifier: AGPL-3.0-or-later
// © 2026 Michael Maurizi Jr.

import { useSyncExternalStore } from "react";

const STORAGE_KEY = "mdm-color-mode-preference";

export type ColorModePreference = "system" | "light" | "dark";

const listeners = new Set<() => void>();

const getSnapshot = (): ColorModePreference => {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
};

export const setColorModePreference = (pref: ColorModePreference) => {
  try {
    if (pref === "system") {
      localStorage.removeItem(STORAGE_KEY);
    } else {
      localStorage.setItem(STORAGE_KEY, pref);
    }
  } catch {
    // localStorage unavailable — still notify so in-session state updates
  }
  listeners.forEach(l => l());
};

const subscribe = (cb: () => void) => {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
};

const getServerSnapshot = (): ColorModePreference => "system";

export const useColorModePreference = (): ColorModePreference =>
  useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
