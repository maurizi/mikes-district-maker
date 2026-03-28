#!/usr/bin/env npx ts-node
/**
 * Detect precinct field names from VEST shapefiles for the multi-year CSV.
 * Updates states.csv precinct_field_20XX columns.
 * Run: npx ts-node scripts/bulk-vest/detect-fields.ts
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DATA_DIR = "/run/user/1000/gvfs/smb-share:server=as6704t-fe65.local,share=mike/Data";
const CSV_PATH = join(__dirname, "states.csv");
const TMP_DIR = join(__dirname, ".tmp-detect");

const PRECINCT_FIELD_PRIORITY = [
  /^PRECINCT$/i,
  /^PRECINCT\d{2}$/i,
  /^PRECINCT_I/i,
  /^PRECINCTNA/i,
  /^VTDST\d{2}$/i,
  /^VTDST20$/i,
  /^VTDST$/i,
  /^VTDID$/i,
  /^VTD$/i,
  /^GEOID\d{2}$/i,
  /^GEOID$/i,
  /^PCTKEY$/i,
  /^PCTNO$/i,
  /^SRPREC_KEY$/i,
  /^SRPREC$/i,
  /^PREC_ID$/i,
  /^PRECCODE$/i,
  /^PRECINCTNU/i,
  /^SOSPRECINC/i,
  /^PCODE$/i,
  /^WARDID$/i,
  /^LABEL$/i,
  /^DISTRICT$/i,
  /^NAME20$/i,
  /^NAME$/i,
  /PREC/i,
  /VTD/i
];

function isVoteColumn(field: string): boolean {
  return /^[GPCRS]\d{2}[A-Z]{3}/.test(field);
}

function readDbfFields(dbfPath: string): string[] {
  const buf = readFileSync(dbfPath);
  const headerSize = buf.readUInt16LE(8);
  const numFields = Math.floor((headerSize - 33) / 32);
  const fields: string[] = [];
  for (let i = 0; i < numFields; i++) {
    const offset = 32 + i * 32;
    let name = "";
    for (let j = 0; j < 11; j++) {
      const ch = buf[offset + j];
      if (ch === 0) break;
      name += String.fromCharCode(ch);
    }
    fields.push(name);
  }
  return fields;
}

function detectPrecinctField(fields: string[], year: string): string {
  const yy = year.slice(-2);
  const nonVoteFields = fields.filter(f => !isVoteColumn(f));

  for (const pattern of PRECINCT_FIELD_PRIORITY) {
    const yearPattern = new RegExp(pattern.source.replace("\\d{2}", yy), "i");
    const yearMatch = nonVoteFields.find(f => yearPattern.test(f));
    if (yearMatch) return yearMatch;

    const genericMatch = nonVoteFields.find(f => pattern.test(f));
    if (genericMatch) return genericMatch;
  }

  return "UNKNOWN";
}

function detectFieldForZip(zipFile: string, year: string): string {
  if (!zipFile) return "";

  const zipPath = join(DATA_DIR, zipFile);
  if (!existsSync(zipPath)) {
    console.warn(`  File not found: ${zipFile}`);
    return "MISSING";
  }

  const extractDir = join(TMP_DIR, zipFile.replace(".zip", ""));
  try {
    mkdirSync(extractDir, { recursive: true });
    execSync(`unzip -o -qq "${zipPath}" -d "${extractDir}" 2>/dev/null`, { timeout: 30000 });

    const files = execSync(`ls "${extractDir}"`, { encoding: "utf-8" }).trim().split("\n");
    const dbfFile = files.find(f => f.endsWith(".dbf"));
    if (!dbfFile) return "NO_DBF";

    const fields = readDbfFields(join(extractDir, dbfFile));
    return detectPrecinctField(fields, year);
  } catch (err: any) {
    console.warn(`  Error: ${err.message}`);
    return "ERROR";
  } finally {
    rmSync(extractDir, { recursive: true, force: true });
  }
}

function main() {
  const csvContent = readFileSync(CSV_PATH, "utf-8");
  const lines = csvContent.trim().split("\n");
  const header = lines[0];
  const headerFields = header.split(",");

  // Simple CSV parse
  const rows = lines.slice(1).map(line => {
    const values: string[] = [];
    let current = "";
    let inQuotes = false;
    for (const ch of line) {
      if (ch === '"') {
        inQuotes = !inQuotes;
      } else if (ch === "," && !inQuotes) {
        values.push(current);
        current = "";
      } else {
        current += ch;
      }
    }
    values.push(current);
    return values;
  });

  mkdirSync(TMP_DIR, { recursive: true });

  const vestCols = [
    { vestIdx: headerFields.indexOf("vest_2020"), fieldIdx: headerFields.indexOf("precinct_field_2020"), year: "2020" },
    { vestIdx: headerFields.indexOf("vest_2018"), fieldIdx: headerFields.indexOf("precinct_field_2018"), year: "2018" },
    { vestIdx: headerFields.indexOf("vest_2016"), fieldIdx: headerFields.indexOf("precinct_field_2016"), year: "2016" }
  ];

  for (const row of rows) {
    const state = row[0];
    for (const { vestIdx, fieldIdx, year } of vestCols) {
      const zipFile = row[vestIdx];
      if (!zipFile || row[fieldIdx]) continue; // skip if no zip or already detected

      const field = detectFieldForZip(zipFile, year);
      row[fieldIdx] = field;
      console.log(`${state} ${year}: ${field} (${zipFile})`);
    }
  }

  rmSync(TMP_DIR, { recursive: true, force: true });

  const outputLines = rows.map(row =>
    row.map(v => v.includes(",") ? `"${v}"` : v).join(",")
  );
  writeFileSync(CSV_PATH, [header, ...outputLines].join("\n") + "\n");
  console.log("\nDone.");
}

main();
