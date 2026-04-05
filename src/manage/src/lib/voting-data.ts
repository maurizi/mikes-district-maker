import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  readdirSync
} from "fs";
import { join } from "path";
import * as shapefile from "shapefile";
import * as unzipper from "unzipper";
import * as proj4Module from "proj4";
const proj4 = (proj4Module as any).default || proj4Module;

export async function extractZipToDir(zipBuffer: Buffer, dir: string): Promise<void> {
  mkdirSync(dir, { recursive: true });
  const zip = await unzipper.Open.buffer(zipBuffer);
  await zip.extract({ path: dir });
}

export async function readShapefile(shpPath: string, dbfPath?: string): Promise<GeoJSON.Feature[]> {
  // Fix null-padded DBF fields: some VEST shapefiles use \0 padding instead of
  // space padding for numeric fields. The shapefile library reads \0 as null.
  // Fix by replacing \0 with space in the DBF file before reading.
  const actualDbfPath = dbfPath || shpPath.replace(/\.shp$/i, ".dbf");
  if (existsSync(actualDbfPath)) {
    const dbfBuf = Buffer.from(readFileSync(actualDbfPath));
    const headerSize = dbfBuf.readUInt16LE(8);
    let fixed = false;
    for (let i = headerSize + 1; i < dbfBuf.length; i++) {
      if (dbfBuf[i] === 0x00) {
        dbfBuf[i] = 0x20; // replace null with space
        fixed = true;
      }
    }
    if (fixed) {
      writeFileSync(actualDbfPath, dbfBuf);
    }
  }

  const features: GeoJSON.Feature[] = [];
  const source = await shapefile.open(shpPath, dbfPath || null);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const result = await source.read();
    if (result.done) break;
    features.push(result.value);
  }
  return features;
}

export function findFileInDir(dir: string, extension: string): string {
  const files = readdirSync(dir) as string[];
  const found = files.find((f: string) => f.endsWith(extension));
  if (!found) throw new Error(`No ${extension} file found in ${dir}`);
  return join(dir, found);
}

// Extract vote columns grouped by office code, also detect election year
// Column format: G20PRERTRU — {electionType}{YY}{office3}{party1}{name3}
export function extractVotingData(props: Record<string, any>): {
  byOffice: Record<string, { democrat: number; republican: number; other: number }>;
  electionYear: string;
} {
  const byOffice: Record<string, { democrat: number; republican: number; other: number }> = {};
  let electionYear = "";

  for (const [key, value] of Object.entries(props)) {
    // Match vote columns: letter + 2 digits + 3-letter office + party + name
    const match = key.match(/^[GPCRS](\d{2})([A-Z]{3})([DRLGIOCNSMPUAWBETH])/);
    if (!match) continue;

    const year = match[1];
    const office = match[2];
    const partyCode = match[3];
    const votes = typeof value === "number" ? value : parseInt(String(value)) || 0;

    if (!electionYear) electionYear = year;

    if (!byOffice[office]) {
      byOffice[office] = { democrat: 0, republican: 0, other: 0 };
    }

    if (partyCode === "D") {
      byOffice[office].democrat += votes;
    } else if (partyCode === "R") {
      byOffice[office].republican += votes;
    } else {
      byOffice[office].other += votes;
    }
  }

  return { byOffice, electionYear };
}

// Apportion an integer total into parts proportional to ratios,
// using largest-remainder method to preserve the sum
export function apportion(total: number, ratios: number[]): number[] {
  const sum = ratios.reduce((a, b) => a + b, 0);
  if (sum === 0) return ratios.map(() => 0);

  const exact = ratios.map(r => (total * r) / sum);
  const floored = exact.map(Math.floor);
  let remainder = total - floored.reduce((a, b) => a + b, 0);

  // Distribute remainder to entries with largest fractional parts
  const fractionals = exact.map((e, i) => ({ i, frac: e - floored[i] }));
  fractionals.sort((a, b) => b.frac - a.frac);
  for (let j = 0; j < remainder; j++) {
    floored[fractionals[j].i]++;
  }

  return floored;
}

// Reproject a GeoJSON feature's coordinates from source CRS to WGS84
export function reprojectFeature(feature: GeoJSON.Feature, projDef: string): GeoJSON.Feature {
  // Check if already geographic (NAD83 or WGS84)
  if (projDef.startsWith("GEOGCS") && !projDef.includes("PROJCS")) {
    return feature; // Already in geographic coordinates
  }

  const converter = proj4(projDef, "EPSG:4326");

  function reprojectCoords(coords: any): any {
    if (typeof coords[0] === "number") {
      // It's a point [x, y]
      const [lng, lat] = converter.forward(coords as [number, number]);
      return [lng, lat];
    }
    return coords.map(reprojectCoords);
  }

  return {
    ...feature,
    geometry: {
      ...feature.geometry,
      coordinates: reprojectCoords((feature.geometry as any).coordinates)
    } as any
  };
}
