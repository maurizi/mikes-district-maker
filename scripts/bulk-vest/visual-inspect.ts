#!/usr/bin/env npx ts-node
/**
 * Visual inspection tool using Playwright.
 * Takes screenshots of the map at various zoom levels for a given state,
 * checks layer visibility, and optionally inspects split block locations.
 *
 * Usage:
 *   npx ts-node scripts/bulk-vest/visual-inspect.ts --state DE [--base-url http://localhost:3003] [--check-splits]
 *
 * Prerequisites:
 *   - App running locally (docker compose up)
 *   - A user account exists
 *   - The region has been published
 */
import { chromium } from "playwright";
import { mkdirSync, existsSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const SCREENSHOTS_DIR = join(__dirname, "screenshots");

interface Config {
  state: string;
  baseUrl: string;
  email: string;
  password: string;
  checkSplits: boolean;
}

function parseArgs(): Config {
  const args = process.argv.slice(2);
  const config: Config = {
    state: "",
    baseUrl: process.env.BASE_URL || "http://localhost:3003",
    email: process.env.DB_EMAIL || "admin@districtbuilder.com",
    password: process.env.DB_PASSWORD || "Password123!",
    checkSplits: false
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--state":
        config.state = args[++i].toUpperCase();
        break;
      case "--base-url":
        config.baseUrl = args[++i];
        break;
      case "--email":
        config.email = args[++i];
        break;
      case "--password":
        config.password = args[++i];
        break;
      case "--check-splits":
        config.checkSplits = true;
        break;
    }
  }

  if (!config.state) {
    console.error("Usage: visual-inspect.ts --state XX [--base-url URL] [--check-splits]");
    process.exit(1);
  }

  return config;
}

// Known river/boundary coordinates for spot-checking (state -> [lng, lat, zoom])
const RIVER_SPOTS: Record<string, [number, number, number]> = {
  AK: [-149.90, 61.22, 11],   // Anchorage / Cook Inlet
  AL: [-87.52, 31.30, 11],    // Alabama River
  AR: [-92.29, 34.75, 11],    // Arkansas River near Little Rock
  AZ: [-111.91, 33.43, 11],   // Salt River / Phoenix area
  CA: [-121.50, 38.58, 11],   // Sacramento River
  CO: [-105.00, 39.75, 11],   // South Platte River near Denver
  CT: [-72.65, 41.36, 12],    // Connecticut River
  DC: [-77.04, 38.90, 13],    // Potomac/Anacostia confluence
  DE: [-75.56, 39.77, 12],    // Delaware River near Wilmington
  FL: [-81.66, 30.33, 11],    // St. Johns River near Jacksonville
  GA: [-81.09, 32.08, 11],    // Savannah River
  HI: [-157.86, 21.31, 12],   // Honolulu coastline
  IA: [-93.62, 41.59, 11],    // Des Moines River
  ID: [-116.21, 43.62, 11],   // Boise River
  IL: [-90.18, 38.63, 11],    // Mississippi River near St. Louis
  IN: [-86.77, 39.77, 11],    // White River near Indianapolis
  KS: [-94.61, 39.11, 11],    // Missouri/Kansas River confluence
  KY: [-85.76, 38.25, 11],    // Ohio River near Louisville
  LA: [-90.07, 29.95, 11],    // Mississippi River near New Orleans
  MA: [-71.06, 42.36, 12],    // Boston Harbor / Charles River
  MD: [-76.61, 39.29, 12],    // Baltimore Inner Harbor / Patapsco
  ME: [-69.78, 44.31, 11],    // Kennebec River
  MI: [-83.75, 42.33, 11],    // Detroit River
  MN: [-93.27, 44.98, 11],    // Mississippi River near Minneapolis
  MO: [-90.20, 38.63, 11],    // Mississippi River near St. Louis
  MS: [-90.18, 32.30, 11],    // Mississippi River near Vicksburg
  MT: [-111.95, 46.87, 11],   // Missouri River near Helena
  NC: [-77.95, 34.23, 11],    // Cape Fear River
  ND: [-100.78, 46.81, 11],   // Missouri River near Bismarck
  NE: [-95.93, 41.26, 11],    // Missouri River near Omaha
  NH: [-71.46, 43.21, 12],    // Merrimack River
  NJ: [-74.74, 40.22, 12],    // Delaware River near Trenton
  NM: [-106.65, 35.08, 11],   // Rio Grande near Albuquerque
  NV: [-119.81, 39.53, 11],   // Truckee River near Reno
  NY: [-73.97, 40.78, 12],    // Manhattan/Hudson River
  OH: [-84.51, 39.10, 11],    // Ohio River near Cincinnati
  OK: [-96.00, 35.47, 11],    // Arkansas River near Tulsa
  OR: [-122.67, 45.52, 11],   // Willamette River in Portland
  PA: [-75.13, 40.00, 12],    // Delaware River near Philadelphia
  RI: [-71.41, 41.82, 12],    // Narragansett Bay / Providence
  SC: [-79.94, 32.78, 11],    // Charleston Harbor / Cooper River
  SD: [-100.35, 44.37, 11],   // Missouri River near Pierre
  TN: [-90.05, 35.14, 11],    // Mississippi River near Memphis
  TX: [-97.14, 28.70, 11],    // Rio Grande
  UT: [-111.89, 40.76, 11],   // Jordan River near Salt Lake
  VA: [-77.04, 38.90, 11],    // Potomac River near DC
  VT: [-73.21, 44.48, 12],    // Lake Champlain shoreline
  WA: [-122.67, 45.63, 11],   // Columbia River
  WI: [-87.91, 43.04, 11],    // Milwaukee / Lake Michigan
  WV: [-81.63, 38.35, 11],    // Kanawha River near Charleston
  WY: [-106.32, 42.83, 11],   // North Platte River
};

// Layer visibility check: which line layers should have features at each zoom
// Returns layers expected to be visible at a given zoom, based on typical config
function getExpectedLayers(zoom: number, geoLevels: Array<{ id: string; minZoom: number; maxZoom: number }>) {
  return geoLevels
    .filter(l => zoom >= l.minZoom && zoom <= l.maxZoom)
    .map(l => `${l.id}-line`);
}

async function checkLayerVisibility(
  page: any,
  zoom: number,
  geoLevels: Array<{ id: string; minZoom: number; maxZoom: number }>
): Promise<string[]> {
  const expectedLayers = getExpectedLayers(zoom, geoLevels);
  const warnings: string[] = [];

  for (const layerId of expectedLayers) {
    const featureCount: number = await page.evaluate((lid: string) => {
      const map = (window as any).__dbMap;
      if (!map) return -1;
      try {
        const features = map.queryRenderedFeatures(undefined, { layers: [lid] });
        return features.length;
      } catch {
        return -1;
      }
    }, layerId);

    if (featureCount === 0) {
      warnings.push(`WARNING: Layer "${layerId}" expected visible at zoom ${zoom} but has 0 rendered features`);
    } else if (featureCount === -1) {
      warnings.push(`WARNING: Could not query layer "${layerId}" at zoom ${zoom}`);
    }
  }

  return warnings;
}

async function main() {
  const config = parseArgs();
  const stateDir = join(SCREENSHOTS_DIR, config.state);
  mkdirSync(stateDir, { recursive: true });

  console.log(`Visual inspection for ${config.state}`);
  console.log(`  Base URL: ${config.baseUrl}`);
  console.log(`  Screenshots: ${stateDir}`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 }
  });
  const page = await context.newPage();

  // Step 1: Login
  console.log("\n1. Logging in...");
  const apiBase = config.baseUrl.replace(":3003", ":3005");
  let jwt: string;
  try {
    const loginResp = await fetch(`${apiBase}/api/auth/email/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: config.email, password: config.password })
    });
    if (!loginResp.ok) {
      const body = await loginResp.text();
      throw new Error(`Login failed (${loginResp.status}): ${body}`);
    }
    jwt = await loginResp.text();
    jwt = jwt.replace(/^"|"$/g, "");
    console.log("   Logged in successfully");
  } catch (err: any) {
    console.error(`   Login failed: ${err.message}`);
    console.error("   Make sure the app is running and credentials are correct");
    await browser.close();
    process.exit(1);
  }

  // Step 2: Find the region config for this state
  console.log("\n2. Finding region config...");
  const regionsResp = await fetch(`${apiBase}/api/region-configs?sort=name,ASC`, {
    headers: { Authorization: `Bearer ${jwt}` }
  });
  const regions: any[] = await regionsResp.json();
  const region = regions.find(
    (r: any) => r.regionCode === config.state && !r.archived
  );
  if (!region) {
    console.error(`   No region found for ${config.state}`);
    console.error(`   Available: ${regions.map((r: any) => r.regionCode).join(", ")}`);
    await browser.close();
    process.exit(1);
  }
  console.log(`   Found: ${region.name} (${region.id})`);

  // Step 3: Fetch static metadata to get geoLevelHierarchy and bbox
  console.log("\n3. Fetching region metadata...");
  const s3Uri = region.s3URI;
  const metadataUrl = s3Uri
    ? s3Uri.replace("s3://", "https://").replace(
        /^https:\/\/([^/]+)/,
        "https://$1.s3.amazonaws.com"
      ) + "static-metadata.json"
    : null;

  let regionBbox: [number, number, number, number] | null = null;
  let geoLevels: Array<{ id: string; minZoom: number; maxZoom: number }> = [];

  if (metadataUrl) {
    try {
      const metaResp = await fetch(metadataUrl);
      const meta = await metaResp.json() as any;
      regionBbox = meta.bbox;
      geoLevels = meta.geoLevelHierarchy || [];
      console.log(`   Region bbox: [${regionBbox}]`);
      console.log(`   Geo levels: ${geoLevels.map(l => `${l.id}(z${l.minZoom}-${l.maxZoom})`).join(", ")}`);
    } catch {
      console.warn("   Could not fetch region metadata");
    }
  }

  // Fallback geo levels if metadata unavailable
  if (geoLevels.length === 0) {
    geoLevels = [
      { id: "block", minZoom: 10, maxZoom: 14 },
      { id: "precinct", minZoom: 4, maxZoom: 12 },
      { id: "county", minZoom: 0, maxZoom: 8 }
    ];
  }

  // Step 4: Create a temporary project
  console.log("\n4. Creating temporary project...");
  const projectResp = await fetch(`${apiBase}/api/projects`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${jwt}`
    },
    body: JSON.stringify({
      name: `Inspect ${config.state}`,
      numberOfDistricts: 2,
      regionConfig: { id: region.id }
    })
  });
  if (!projectResp.ok) {
    const body = await projectResp.text();
    console.error(`   Failed to create project (${projectResp.status}): ${body}`);
    await browser.close();
    process.exit(1);
  }
  const project: any = await projectResp.json();
  console.log(`   Created project: ${project.id}`);

  // Step 5: Mark tour as seen so modal doesn't block the map
  console.log("\n5. Dismissing tour...");
  try {
    await fetch(`${apiBase}/api/user`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${jwt}`
      },
      body: JSON.stringify({ hasSeenTour: true })
    });
    console.log("   Tour marked as seen");
  } catch {
    console.warn("   Could not dismiss tour via API, will try clicking dismiss");
  }

  // Step 6: Navigate to the project and set auth token
  console.log("\n6. Opening map...");
  await page.goto(config.baseUrl);
  await page.evaluate((token: string) => {
    localStorage.setItem("jwt", token);
  }, jwt);

  const projectUrl = `${config.baseUrl}/projects/${project.id}`;
  await page.goto(projectUrl);

  console.log("   Waiting for map to load...");
  await page.waitForTimeout(3000);

  try {
    await page.waitForSelector("canvas.maplibregl-canvas", { timeout: 30000 });
    console.log("   Map canvas found");
    // Wait for the map instance to be exposed on window
    await page.waitForFunction(() => (window as any).__dbMap, { timeout: 10000 });
    console.log("   Map instance ready");
    // Extra wait for tiles to render
    await page.waitForTimeout(5000);
  } catch {
    console.warn("   Map not fully ready, taking screenshots anyway");
  }

  // Dismiss tour modal if still visible (click "No, thanks")
  try {
    const noThanks = page.getByText("No, thanks");
    if (await noThanks.isVisible({ timeout: 2000 })) {
      await noThanks.click();
      console.log("   Dismissed tour modal");
      await page.waitForTimeout(1000);
    }
  } catch {
    // Tour already dismissed or not present
  }

  // Make all geolevel line layers visible for inspection
  console.log("   Enabling all line layers...");
  await page.evaluate((levels: Array<{ id: string }>) => {
    const map = (window as any).__dbMap;
    if (!map) return;
    for (const level of levels) {
      try {
        map.setLayoutProperty(`${level.id}-line`, "visibility", "visible");
      } catch {}
    }
  }, geoLevels);

  // Step 7: Take screenshots at zoom levels targeting layer transitions
  console.log("\n7. Taking screenshots...");

  // Compute region center from bbox for flyTo navigation
  const regionCenter: [number, number] = regionBbox
    ? [(regionBbox[0] + regionBbox[2]) / 2, (regionBbox[1] + regionBbox[3]) / 2]
    : [0, 0];

  // For high-zoom screenshots, use the river spot (on land) if available,
  // otherwise fall back to region center
  const riverSpot = RIVER_SPOTS[config.state];
  const landCenter: [number, number] = riverSpot
    ? [riverSpot[0], riverSpot[1]]
    : regionCenter;

  const zoomLevels = [
    { name: "z00_full_out", zoom: 0, desc: "Fully zoomed out", center: regionCenter },
    { name: "z04_precinct_start", zoom: 4, desc: "Precinct min zoom boundary", center: regionCenter },
    { name: "z07_state_overview", zoom: 7, desc: "State overview", center: regionCenter },
    { name: "z08_county_max", zoom: 8, desc: "County max zoom boundary", center: regionCenter },
    { name: "z10_block_start", zoom: 10, desc: "Block min zoom boundary", center: landCenter },
    { name: "z12_precinct_max", zoom: 12, desc: "Precinct max zoom boundary", center: landCenter },
    { name: "z14_block_max", zoom: 14, desc: "Block max zoom boundary", center: landCenter },
    { name: "z17_overzoom", zoom: 17, desc: "Deep overzoom", center: landCenter }
  ];

  const allWarnings: string[] = [];

  for (const level of zoomLevels) {
    const filename = `${config.state}_${level.name}.png`;
    const filepath = join(stateDir, filename);

    console.log(`   ${level.desc} (zoom ${level.zoom})...`);

    // Navigate to appropriate center at this zoom level
    await page.evaluate(
      ({ center, zoom }: { center: [number, number]; zoom: number }) => {
        const map = (window as any).__dbMap;
        if (map) {
          map.flyTo({ center, zoom, duration: 0 });
        }
      },
      { center: level.center, zoom: level.zoom }
    );

    await page.waitForTimeout(3000);
    await page.screenshot({ path: filepath, fullPage: false });
    console.log(`   -> ${filename}`);

    // Check layer visibility
    const warnings = await checkLayerVisibility(page, level.zoom, geoLevels);
    for (const w of warnings) {
      console.log(`   ${w}`);
      allWarnings.push(`${level.name}: ${w}`);
    }
  }

  // River/boundary spot check
  if (riverSpot) {
    const [lng, lat, zoom] = riverSpot;
    const filename = `${config.state}_river.png`;
    const filepath = join(stateDir, filename);

    console.log(`   River boundary (${lng}, ${lat}, zoom ${zoom})...`);

    await page.evaluate(
      ({ lng, lat, zoom }: { lng: number; lat: number; zoom: number }) => {
        const map = (window as any).__dbMap;
        if (map) {
          map.flyTo({ center: [lng, lat], zoom, duration: 0 });
        }
      },
      { lng, lat, zoom }
    );

    await page.waitForTimeout(4000);
    await page.screenshot({ path: filepath, fullPage: false });
    console.log(`   -> ${filename}`);
  }

  // Split block spot checks
  if (config.checkSplits) {
    const splitsFile = join(__dirname, "split-blocks", `${config.state}.json`);
    if (existsSync(splitsFile)) {
      console.log("\n   Split block spot checks...");
      const splits: Array<{ lng: number; lat: number; blockId: string }> = JSON.parse(
        readFileSync(splitsFile, "utf-8")
      );

      // Sample up to 5 split block locations
      const sample = splits.length <= 5 ? splits : [];
      if (splits.length > 5) {
        const step = Math.floor(splits.length / 5);
        for (let i = 0; i < 5; i++) {
          sample.push(splits[i * step]);
        }
      }

      for (let i = 0; i < sample.length; i++) {
        const { lng, lat, blockId } = sample[i];
        for (const zoom of [13, 15]) {
          const filename = `${config.state}_split_${i}_z${zoom}.png`;
          const filepath = join(stateDir, filename);

          console.log(`   Split block ${blockId} (zoom ${zoom})...`);

          await page.evaluate(
            ({ lng, lat, zoom }: { lng: number; lat: number; zoom: number }) => {
              const map = (window as any).__dbMap;
              if (map) {
                map.flyTo({ center: [lng, lat], zoom, duration: 0 });
              }
            },
            { lng, lat, zoom }
          );

          await page.waitForTimeout(3000);
          await page.screenshot({ path: filepath, fullPage: false });
          console.log(`   -> ${filename}`);
        }
      }
    } else {
      console.log(`\n   No split blocks file found at ${splitsFile}`);
      console.log("   Run analyze-splits.ts first to generate it");
    }
  }

  // Step 8: Clean up
  console.log("\n8. Cleaning up...");
  try {
    await fetch(`${apiBase}/api/projects/${project.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${jwt}` }
    });
    console.log("   Deleted temporary project");
  } catch {
    console.warn("   Could not delete project (may need manual cleanup)");
  }

  await browser.close();

  // Print summary
  console.log(`\nDone! Screenshots in: ${stateDir}/`);
  console.log(`Geo levels: ${geoLevels.map(l => `${l.id}(z${l.minZoom}-${l.maxZoom})`).join(", ")}`);

  if (allWarnings.length > 0) {
    console.log(`\n=== ${allWarnings.length} VISIBILITY WARNINGS ===`);
    for (const w of allWarnings) {
      console.log(`  ${w}`);
    }
  } else {
    console.log("\nNo layer visibility warnings.");
  }

  console.log("\nReview the screenshots and check for:");
  console.log("  - Counties visible at all zoom levels (0 through max)");
  console.log("  - Precincts visible at all expected zoom levels");
  console.log("  - Blocks visible after 'zoom in' message disappears");
  console.log("  - Layers still visible when zoomed in deeply (overzoom)");
  console.log("  - Smooth boundaries (not jagged/triangular) around rivers");
  console.log("  - No odd holes or disconnected polygons when zoomed out");
  console.log("  - Borders aligned between layers (county/precinct/block)");
  console.log("  - No overly simplified lines (peninsulas as islands, etc.)");
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
