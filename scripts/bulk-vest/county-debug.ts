import { chromium } from "playwright";
import { mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function inspectCounty(state: string) {
  const DIR = join(__dirname, "screenshots", `${state}-county-debug`);
  mkdirSync(DIR, { recursive: true });
  const apiBase = "http://localhost:3005";
  const baseUrl = "http://localhost:3003";

  const loginResp = await fetch(`${apiBase}/api/auth/email/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "admin@districtbuilder.com", password: "Password123!" })
  });
  const jwt = (await loginResp.text()).replace(/^"|"$/g, "");
  await fetch(`${apiBase}/api/user`, {
    method: "PATCH", headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
    body: JSON.stringify({ hasSeenTour: true })
  });

  const regionsResp = await fetch(`${apiBase}/api/region-configs?sort=name,ASC`, {
    headers: { Authorization: `Bearer ${jwt}` }
  });
  const regions: any[] = await regionsResp.json();
  const region = regions.find((r: any) => r.regionCode === state && !r.archived);
  if (!region) { console.error(`No region for ${state}`); return; }

  const s3Uri = region.s3URI;
  const metadataUrl = s3Uri?.replace("s3://", "https://").replace(/^https:\/\/([^/]+)/, "https://$1.s3.amazonaws.com") + "static-metadata.json";
  let bbox: number[] | null = null;
  try { const m = await (await fetch(metadataUrl)).json() as any; bbox = m.bbox; } catch {}
  const center: [number, number] = bbox ? [(bbox[0]+bbox[2])/2, (bbox[1]+bbox[3])/2] : [0,0];

  const projectResp = await fetch(`${apiBase}/api/projects`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
    body: JSON.stringify({ name: `County Debug ${state}`, numberOfDistricts: 2, regionConfig: { id: region.id } })
  });
  const project: any = await projectResp.json();

  const browser = await chromium.launch({ headless: true });
  const page = await (await browser.newContext({ viewport: { width: 1920, height: 1080 } })).newPage();
  await page.goto(baseUrl);
  await page.evaluate((t: string) => localStorage.setItem("jwt", t), jwt);
  await page.goto(`${baseUrl}/projects/${project.id}`);
  await page.waitForTimeout(3000);
  await page.waitForSelector("canvas.maplibregl-canvas", { timeout: 30000 });
  await page.waitForFunction(() => (window as any).__dbMap, { timeout: 10000 });
  await page.waitForTimeout(5000);
  try { const b = page.getByText("No, thanks"); if (await b.isVisible({ timeout: 2000 })) await b.click(); } catch {}
  await page.waitForTimeout(1000);

  // Hide everything except county lines
  await page.evaluate(() => {
    const map = (window as any).__dbMap;
    if (!map) return;
    map.setLayoutProperty("districts", "visibility", "none");
    try { map.setLayoutProperty("block-line", "visibility", "none"); } catch {}
    try { map.setLayoutProperty("precinct-line", "visibility", "none"); } catch {}
    map.setLayoutProperty("county-line", "visibility", "visible");
    map.setPaintProperty("county-line", "line-color", "#ff0000");
    map.setPaintProperty("county-line", "line-width", 3);
    map.setPaintProperty("county-line", "line-opacity", 1);
  });
  await page.waitForTimeout(1000);

  for (const { zoom, name } of [
    { zoom: 5, name: "z05" }, { zoom: 6, name: "z06" }, { zoom: 7, name: "z07" },
    { zoom: 8, name: "z08" }, { zoom: 9, name: "z09" }, { zoom: 10, name: "z10" }
  ]) {
    await page.evaluate(({ c, z }) => { (window as any).__dbMap?.flyTo({ center: c, zoom: z, duration: 0 }); }, { c: center, z: zoom });
    await page.waitForTimeout(3000);
    await page.screenshot({ path: join(DIR, `${name}.png`) });
    console.log(`  ${state} ${name}`);
  }

  await fetch(`${apiBase}/api/projects/${project.id}`, { method: "DELETE", headers: { Authorization: `Bearer ${jwt}` } });
  await browser.close();
}

const states = process.argv.slice(2);
(async () => { for (const s of states) await inspectCounty(s.toUpperCase()); })().catch(e => { console.error(e); process.exit(1); });
