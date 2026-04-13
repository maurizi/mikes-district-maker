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

// Mock worker-functions which use Web Workers not available in jsdom
vi.mock("./worker-functions", () => ({
  getTotalSelectedDemographics: vi.fn().mockResolvedValue({ demographics: [] }),
  getSavedDistrictSelectedDemographics: vi.fn().mockResolvedValue([])
}));
