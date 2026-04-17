import { type DistrictsDefinition, type GeoUnitHierarchy } from "./entities";

// Parse a simple two-column `BLOCKID,DISTRICT` CSV (header row + data rows).
// Strips surrounding double quotes from each field. Empty trailing lines are
// skipped.
export function parseBlockDistrictCsv(csvText: string): [string, string][] {
  const lines = csvText.split(/\r?\n/);
  const records: [string, string][] = [];
  // Skip the header row (line 0).
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const commaIdx = line.indexOf(",");
    if (commaIdx === -1) continue;
    records.push([unquote(line.slice(0, commaIdx)), unquote(line.slice(commaIdx + 1))]);
  }
  return records;
}

function unquote(field: string): string {
  const trimmed = field.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

// Build split-block lookup: base block → its sub-block variants
// (e.g. "42001..." → ["42001...-1", "42001...-2"]). When a CSV references
// the base block but the region data has split it during processing, we
// expand the assignment across all sub-blocks.
export function buildSplitBlockMap(blockIds: readonly string[]): Map<string, string[]> {
  const splitBlockMap = new Map<string, string[]>();
  for (const id of blockIds) {
    const dashIdx = id.indexOf("-");
    if (dashIdx === -1) continue;
    const baseId = id.substring(0, dashIdx);
    const existing = splitBlockMap.get(baseId);
    if (existing) {
      existing.push(id);
    } else {
      splitBlockMap.set(baseId, [id]);
    }
  }
  return splitBlockMap;
}

// Build block → district map from CSV records, expanding split parents to
// all their sub-blocks. Non-numeric district values are skipped. Returns the
// running max district id observed (callers use it for numberOfDistricts /
// maxDistrictId).
export function expandBlockToDistrict(
  records: readonly (readonly [string, string])[],
  allBlockIds: ReadonlySet<string>,
  splitBlockMap: ReadonlyMap<string, readonly string[]>
): { blockToDistrict: { [blockId: string]: number }; maxDistrictId: number; isComplete: boolean } {
  const blockToDistrict: { [blockId: string]: number } = {};
  let maxDistrictId = 0;
  let isComplete = true;
  for (const [block, districtStr] of records) {
    const d = Number(districtStr);
    if (isNaN(d)) continue;
    if (d > maxDistrictId) maxDistrictId = d;
    if (d === 0) isComplete = false;
    if (allBlockIds.has(block)) {
      blockToDistrict[block] = d;
    }
    const splits = splitBlockMap.get(block);
    if (splits) {
      for (const splitId of splits) {
        blockToDistrict[splitId] = d;
      }
    }
  }
  return { blockToDistrict, maxDistrictId, isComplete };
}

// Convert a flat block → district map into the compact nested
// DistrictsDefinition by walking the geounit hierarchy and collapsing
// regions where every leaf shares the same assignment.
export function importCsvToDefinition(
  blockIds: readonly string[],
  geoUnitHierarchy: GeoUnitHierarchy,
  blockToDistrict: { readonly [blockId: string]: number }
): DistrictsDefinition {
  // Build reverse lookup: blockId → index
  const idToIndex = new Map<string, number>();
  for (let i = 0; i < blockIds.length; i++) {
    idToIndex.set(blockIds[i], i);
  }

  // Build flat assignment array
  const assignment = new Uint8Array(blockIds.length);
  for (const [blockId, district] of Object.entries(blockToDistrict)) {
    const idx = idToIndex.get(blockId);
    if (idx !== undefined) {
      assignment[idx] = district;
    }
  }

  // Walk hierarchy and build definition, simplifying where possible
  function walk(hierarchy: GeoUnitHierarchy | number): DistrictsDefinition | number {
    if (typeof hierarchy === "number") {
      return assignment[hierarchy];
    }
    const results: (DistrictsDefinition | number)[] = hierarchy.map(h => walk(h));
    // Simplify: if all children are the same value, collapse
    if (results.length !== 1 && results.every(item => item === results[0])) {
      return results[0];
    }
    return results;
  }
  return walk(geoUnitHierarchy) as DistrictsDefinition;
}
