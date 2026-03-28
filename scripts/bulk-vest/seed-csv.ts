#!/usr/bin/env npx ts-node
/**
 * Seed the states.csv tracking spreadsheet — one row per state with multi-year columns.
 * Run: npx ts-node scripts/bulk-vest/seed-csv.ts
 */
import { readdirSync, statSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DATA_DIR = "/run/user/1000/gvfs/smb-share:server=as6704t-fe65.local,share=mike/Data";
const OUTPUT = join(__dirname, "states.csv");

const REGION_TO_FIPS: Record<string, string> = {
  AL: "01", AK: "02", AZ: "04", AR: "05", CA: "06", CO: "08", CT: "09",
  DE: "10", DC: "11", FL: "12", GA: "13", HI: "15", ID: "16", IL: "17",
  IN: "18", IA: "19", KS: "20", KY: "21", LA: "22", ME: "23", MD: "24",
  MA: "25", MI: "26", MN: "27", MS: "28", MO: "29", MT: "30", NE: "31",
  NV: "32", NH: "33", NJ: "34", NM: "35", NY: "36", NC: "37", ND: "38",
  OH: "39", OK: "40", OR: "41", PA: "42", RI: "44", SC: "45", SD: "46",
  TN: "47", TX: "48", UT: "49", VT: "50", VA: "51", WA: "53", WV: "54",
  WI: "55", WY: "56"
};

const STATE_NAMES: Record<string, string> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California",
  CO: "Colorado", CT: "Connecticut", DE: "Delaware", DC: "District of Columbia",
  FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois",
  IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky", LA: "Louisiana",
  ME: "Maine", MD: "Maryland", MA: "Massachusetts", MI: "Michigan",
  MN: "Minnesota", MS: "Mississippi", MO: "Missouri", MT: "Montana",
  NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey",
  NM: "New Mexico", NY: "New York", NC: "North Carolina", ND: "North Dakota",
  OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania",
  RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota",
  TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont", VA: "Virginia",
  WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming"
};

const SMALL_STATES = new Set(["DC", "DE", "RI", "VT", "NH", "CT", "WY", "SD", "ND", "MT"]);
const LARGE_STATES = new Set(["TX", "CA", "AK", "NY", "FL", "PA", "IL", "OH", "GA", "NC", "MI", "WA", "TN"]);
const BIG_FLAG_THRESHOLD = 20 * 1024 * 1024;

// Standard election years — these get dedicated columns
const STANDARD_YEARS = ["2020", "2018", "2016"];

// Special election suffixes to exclude from standard processing
const SPECIAL_PATTERNS = [
  "demcaucus", "pres_primary", "statehouse", "statesenate",
  "ushouse", "vtd_estimates", "sg", "sp",
  "statehouse_special", "statesenate_special"
];

function parseFilename(filename: string): { state: string; year: string; suffix: string } | null {
  const match = filename.match(/^([a-z]{2})_(\d{4})(?:_(.+))?\.zip$/);
  if (!match) return null;
  return { state: match[1].toUpperCase(), year: match[2], suffix: match[3] || "" };
}

function isSpecial(suffix: string): boolean {
  return suffix !== "" && SPECIAL_PATTERNS.some(p => suffix.includes(p));
}

function getSimplification(stateAbbr: string): string {
  if (SMALL_STATES.has(stateAbbr)) return "0.0000000025";
  if (LARGE_STATES.has(stateAbbr)) return "0.00000001";
  return "0.000000005";
}

function getQuantization(stateAbbr: string): string {
  if (LARGE_STATES.has(stateAbbr)) return "1e6";
  return "1e5";
}

interface StateRow {
  state_abbr: string;
  state_fips: string;
  state_name: string;
  vest_2020: string;
  precinct_field_2020: string;
  vest_2018: string;
  precinct_field_2018: string;
  vest_2016: string;
  precinct_field_2016: string;
  simplification: string;
  quantization: string;
  min_zoom: string;
  max_zoom: string;
  max_tile_bytes: string;
  big_flag: string;
  status: string;
  notes: string;
}

function main() {
  const files = readdirSync(DATA_DIR).filter(f => f.endsWith(".zip") && !f.startsWith("._")).sort();

  // Group files by state
  const stateFiles = new Map<string, Map<string, { file: string; suffix: string }>>();

  for (const file of files) {
    const parsed = parseFilename(file);
    if (!parsed) continue;
    if (!REGION_TO_FIPS[parsed.state]) continue;
    if (isSpecial(parsed.suffix)) continue;

    if (!stateFiles.has(parsed.state)) {
      stateFiles.set(parsed.state, new Map());
    }
    stateFiles.get(parsed.state)!.set(parsed.year, { file, suffix: parsed.suffix });
  }

  const rows: StateRow[] = [];

  for (const [state, yearMap] of Array.from(stateFiles.entries()).sort()) {
    const fips = REGION_TO_FIPS[state];
    const isBig = Array.from(yearMap.values()).some(({ file }) => {
      try {
        return statSync(join(DATA_DIR, file)).size > BIG_FLAG_THRESHOLD;
      } catch {
        return false;
      }
    });

    // Collect non-standard years for notes
    const nonStandard = Array.from(yearMap.keys()).filter(y => !STANDARD_YEARS.includes(y));
    const notes = nonStandard.length > 0
      ? `extra years: ${nonStandard.map(y => `${y}=${yearMap.get(y)!.file}`).join("; ")}`
      : "";

    rows.push({
      state_abbr: state,
      state_fips: fips,
      state_name: STATE_NAMES[state] || state,
      vest_2020: yearMap.get("2020")?.file || "",
      precinct_field_2020: "", // filled by detect-fields
      vest_2018: yearMap.get("2018")?.file || "",
      precinct_field_2018: "", // filled by detect-fields
      vest_2016: yearMap.get("2016")?.file || "",
      precinct_field_2016: "", // filled by detect-fields
      simplification: getSimplification(state),
      quantization: getQuantization(state),
      min_zoom: "10,4,0",
      max_zoom: "14,12,8",
      max_tile_bytes: "750000",
      big_flag: isBig ? "true" : "false",
      status: "pending",
      notes
    });
  }

  const header = Object.keys(rows[0]).join(",");
  const csvLines = rows.map(r =>
    Object.values(r).map(v => v.includes(",") ? `"${v}"` : v).join(",")
  );

  writeFileSync(OUTPUT, [header, ...csvLines].join("\n") + "\n");
  console.log(`Wrote ${rows.length} state rows to ${OUTPUT}`);

  // Stats
  const with2020 = rows.filter(r => r.vest_2020).length;
  const with2018 = rows.filter(r => r.vest_2018).length;
  const with2016 = rows.filter(r => r.vest_2016).length;
  const withNotes = rows.filter(r => r.notes).length;
  console.log(`  With 2020 data: ${with2020}`);
  console.log(`  With 2018 data: ${with2018}`);
  console.log(`  With 2016 data: ${with2016}`);
  console.log(`  With extra years: ${withNotes}`);
}

main();
