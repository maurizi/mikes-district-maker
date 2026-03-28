#!/usr/bin/env npx ts-node
/**
 * Visual inspection tool using Playwright.
 * Takes screenshots of the map at various zoom levels for a given state.
 *
 * Usage:
 *   npx ts-node scripts/bulk-vest/visual-inspect.ts --state DE [--year 2020] [--base-url http://localhost:3003]
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
  year?: string;
  baseUrl: string;
  email: string;
  password: string;
}

function parseArgs(): Config {
  const args = process.argv.slice(2);
  const config: Config = {
    state: "",
    baseUrl: process.env.BASE_URL || "http://localhost:3003",
    email: process.env.DB_EMAIL || "admin@districtbuilder.com",
    password: process.env.DB_PASSWORD || "password"
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--state":
        config.state = args[++i].toUpperCase();
        break;
      case "--year":
        config.year = args[++i];
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
    }
  }

  if (!config.state) {
    console.error("Usage: visual-inspect.ts --state XX [--year YYYY] [--base-url URL]");
    process.exit(1);
  }

  return config;
}

// Known river/boundary coordinates for spot-checking (state → [lng, lat, zoom])
const RIVER_SPOTS: Record<string, [number, number, number]> = {
  DE: [-75.56, 39.77, 12],    // Delaware River near Wilmington
  AL: [-87.52, 31.30, 11],    // Alabama River
  PA: [-75.13, 40.00, 12],    // Delaware River near Philadelphia
  TX: [-97.14, 28.70, 11],    // Rio Grande
  CA: [-121.50, 38.58, 11],   // Sacramento River
  NY: [-73.97, 40.78, 12],    // Manhattan/Hudson River
  FL: [-81.66, 30.33, 11],    // St. Johns River near Jacksonville
  OH: [-84.51, 39.10, 11],    // Ohio River near Cincinnati
  WA: [-122.67, 45.63, 11],   // Columbia River
  IL: [-90.18, 38.63, 11],    // Mississippi River near St. Louis
};

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
    // Strip quotes if present
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

  // Step 3: Create a temporary project
  console.log("\n3. Creating temporary project...");
  const projectResp = await fetch(`${apiBase}/api/projects`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${jwt}`
    },
    body: JSON.stringify({
      name: `Inspect ${config.state} ${config.year || ""}`.trim(),
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

  // Step 4: Navigate to the project and set auth cookie/token
  console.log("\n4. Opening map...");
  // Set the JWT in localStorage before navigating
  await page.goto(config.baseUrl);
  await page.evaluate((token: string) => {
    localStorage.setItem("jwt", token);
  }, jwt);

  const projectUrl = `${config.baseUrl}/projects/${project.id}`;
  await page.goto(projectUrl);

  // Wait for map tiles to load
  console.log("   Waiting for map to load...");
  await page.waitForTimeout(3000);

  // Wait for map canvas to appear
  try {
    await page.waitForSelector("canvas.maplibregl-canvas", { timeout: 30000 });
    console.log("   Map canvas found");
    // Extra wait for tiles to render
    await page.waitForTimeout(5000);
  } catch {
    console.warn("   Map canvas not found within 30s, taking screenshots anyway");
  }

  // Step 5: Take screenshots at various zoom levels
  console.log("\n5. Taking screenshots...");

  // Get the static metadata bbox for this region
  const s3Uri = region.s3URI;
  const metadataUrl = s3Uri
    ? s3Uri.replace("s3://", "https://").replace(
        /^https:\/\/([^/]+)/,
        "https://$1.s3.amazonaws.com"
      ) + "static-metadata.json"
    : null;

  let regionBbox: [number, number, number, number] | null = null;
  if (metadataUrl) {
    try {
      const metaResp = await fetch(metadataUrl);
      const meta = await metaResp.json() as any;
      regionBbox = meta.bbox;
      console.log(`   Region bbox: [${regionBbox}]`);
    } catch {
      console.warn("   Could not fetch region metadata for bbox");
    }
  }

  // Define zoom levels to screenshot
  const zoomLevels = [
    { name: "state_overview", zoom: 7, desc: "Full state" },
    { name: "county_level", zoom: 9, desc: "County level" },
    { name: "precinct_level", zoom: 11, desc: "Precinct level" },
    { name: "block_level", zoom: 13, desc: "Block level" },
    { name: "block_detail", zoom: 15, desc: "Block detail" }
  ];

  for (const level of zoomLevels) {
    const filename = `${config.state}${config.year ? `_${config.year}` : ""}_${level.name}.png`;
    const filepath = join(stateDir, filename);

    console.log(`   ${level.desc} (zoom ${level.zoom})...`);

    // Use maplibre API to set zoom
    await page.evaluate((zoom: number) => {
      const map = (document.querySelector(".maplibregl-canvas") as any)?.__map;
      if (map) {
        map.setZoom(zoom);
      } else {
        // Try window-level map reference
        const maps = (window as any).__maps || (window as any).map;
        if (maps) maps.setZoom(zoom);
      }
    }, level.zoom);

    await page.waitForTimeout(3000); // Wait for tiles to load
    await page.screenshot({ path: filepath, fullPage: false });
    console.log(`   → ${filename}`);
  }

  // River/boundary spot check if available
  const riverSpot = RIVER_SPOTS[config.state];
  if (riverSpot) {
    const [lng, lat, zoom] = riverSpot;
    const filename = `${config.state}${config.year ? `_${config.year}` : ""}_river.png`;
    const filepath = join(stateDir, filename);

    console.log(`   River boundary (${lng}, ${lat}, zoom ${zoom})...`);

    await page.evaluate(
      ({ lng, lat, zoom }: { lng: number; lat: number; zoom: number }) => {
        const canvas = document.querySelector(".maplibregl-canvas") as any;
        const map = canvas?.__map;
        if (map) {
          map.flyTo({ center: [lng, lat], zoom, duration: 0 });
        }
      },
      { lng, lat, zoom }
    );

    await page.waitForTimeout(4000);
    await page.screenshot({ path: filepath, fullPage: false });
    console.log(`   → ${filename}`);
  }

  // Step 6: Clean up — delete the temporary project
  console.log("\n6. Cleaning up...");
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

  console.log(`\nDone! Screenshots in: ${stateDir}/`);
  console.log("Review the screenshots and check for:");
  console.log("  - Smooth boundaries (not jagged/triangular) around rivers");
  console.log("  - County/precinct/block boundaries overlapping correctly at zoom levels");
  console.log("  - No odd holes or disconnected polygons");
  console.log("  - Blocks looking correct when zoomed in close");
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
