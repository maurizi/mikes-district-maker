// SPDX-License-Identifier: AGPL-3.0-or-later
// © 2026 Michael Maurizi Jr.

import { vi } from "vitest";

// Mock URL.createObjectURL for maplibre-gl in jsdom
if (typeof URL.createObjectURL === "undefined") {
  URL.createObjectURL = () => "";
}

if (typeof URL.revokeObjectURL === "undefined") {
  URL.revokeObjectURL = () => {};
}

// Mock maplibre-gl which requires WebGL context not available in jsdom
vi.mock("maplibre-gl", () => ({
  default: {
    Map: vi.fn(),
    NavigationControl: vi.fn(),
    Popup: vi.fn(),
    Marker: vi.fn(),
    addProtocol: vi.fn(),
    removeProtocol: vi.fn()
  },
  Map: vi.fn(),
  NavigationControl: vi.fn(),
  Popup: vi.fn(),
  Marker: vi.fn(),
  addProtocol: vi.fn(),
  removeProtocol: vi.fn()
}));

// Mock worker-functions because the module spawns Web Workers (both
// our Comlink worker and, when merge runs on the UI thread, cloud-
// topo's internal worker) at import time — jsdom can't construct
// either, so any test that imports this module needs the surface
// stubbed.
vi.mock("./worker-functions", () => ({
  fetchAllStaticData: vi.fn(),
  mergeDistricts: vi.fn(),
  computeRegionOutline: vi.fn(),
  exportCsv: vi.fn(),
  importCsv: vi.fn(),
  getTotalSelectedDemographics: vi.fn().mockResolvedValue({ demographics: [] }),
  getSavedDistrictSelectedDemographics: vi.fn().mockResolvedValue([])
}));
