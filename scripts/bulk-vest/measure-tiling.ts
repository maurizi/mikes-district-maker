#!/usr/bin/env npx ts-node
/**
 * Measure block tiling quality metrics for a state's prepare-dev-data output.
 * Used to verify fixes to the block splitting pipeline.
 *
 * Usage: npx tsx scripts/bulk-vest/measure-tiling.ts <path-to-staging-geojson> <path-to-census-shp>
 */
import { readFileSync } from "fs";
import { createRequire } from "module";
const require2 = createRequire("/home/mike/src/districtbuilder/src/manage/");

const shapefile = require2("shapefile");
const { topology } = require2("topojson-server");
const { feature: topo2feature, mergeArcs } = require2("topojson-client");

async function main() {
  const [stagingPath, censusShpPath] = process.argv.slice(2);
  if (!stagingPath) { console.error("Usage: measure-tiling.ts <staging.geojson> [census.shp]"); process.exit(1); }

  console.log("Loading staging GeoJSON...");
  const data = JSON.parse(readFileSync(stagingPath, "utf8"));
  const features = data.features;
  console.log(`  ${features.length} features\n`);

  // Load Census blocks for coordinate comparison
  let censusCoords: Map<string, number[][]> | null = null;
  if (censusShpPath) {
    console.log("Loading Census shapefile...");
    censusCoords = new Map();
    const source = await shapefile.open(censusShpPath);
    while (true) {
      const r = await source.read();
      if (r.done) break;
      const ring = r.value.geometry.type === "Polygon" ? r.value.geometry.coordinates[0] : r.value.geometry.coordinates[0][0];
      censusCoords.set(r.value.properties.GEOID20, ring);
    }
    console.log(`  ${censusCoords.size} Census blocks\n`);
  }

  // A: Invalid geometry count (using basic checks — no GEOS needed)
  // We check for self-intersection via duplicate consecutive points and ring closure
  let invalidCount = 0;
  for (const f of features) {
    const g = f.geometry;
    const rings = g.type === "Polygon" ? g.coordinates : g.coordinates.flatMap((p: any) => p);
    for (const ring of rings) {
      if (ring.length < 4) { invalidCount++; break; }
      // Check closure
      if (ring[0][0] !== ring[ring.length - 1][0] || ring[0][1] !== ring[ring.length - 1][1]) {
        invalidCount++; break;
      }
    }
  }
  console.log(`A: Invalid geometries (basic check): ${invalidCount}`);

  // B: MultiPolygon count
  let multiCount = 0;
  for (const f of features) if (f.geometry.type === "MultiPolygon") multiCount++;
  console.log(`B: MultiPolygons: ${multiCount}`);

  // C: Overlapping sub-block pairs
  let overlapCount = 0;
  const splitGroups = new Map<string, any[]>();
  for (const f of features) {
    const m = f.properties.block.match(/^(.+)-\d+$/);
    if (!m) continue;
    if (!splitGroups.has(m[1])) splitGroups.set(m[1], []);
    splitGroups.get(m[1])!.push(f);
  }
  for (const [base, subs] of splitGroups) {
    // Check area sum vs original
    let totalArea = 0;
    for (const s of subs) {
      const ring = s.geometry.type === "Polygon" ? s.geometry.coordinates[0] : s.geometry.coordinates[0][0];
      let a = 0;
      for (let i = 0; i < ring.length - 1; i++) a += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
      totalArea += Math.abs(a / 2);
    }
    // If census available, compare to original
    if (censusCoords && censusCoords.has(base)) {
      const origRing = censusCoords.get(base)!;
      let origArea = 0;
      for (let i = 0; i < origRing.length - 1; i++) origArea += origRing[i][0] * origRing[i + 1][1] - origRing[i + 1][0] * origRing[i][1];
      origArea = Math.abs(origArea / 2);
      if (totalArea > origArea * 1.01) overlapCount++;
    }
  }
  console.log(`C: Overlapping sub-block groups: ${overlapCount}`);

  // D: County holes from topojson
  const topo = topology({ block: data });
  const byCounty: Record<string, any[]> = {};
  for (const b of (topo.objects.block as any).geometries) {
    const c = b.properties.county;
    if (!byCounty[c]) byCounty[c] = [];
    byCounty[c].push(b);
  }
  let totalHoles = 0;
  for (const [c, geoms] of Object.entries(byCounty)) {
    const m = topo2feature(topo, mergeArcs(topo, geoms));
    let h = 0;
    if (m.geometry.type === "MultiPolygon") for (const p of m.geometry.coordinates) h += p.length - 1;
    else h += m.geometry.coordinates.length - 1;
    totalHoles += h;
  }
  console.log(`D: County holes (topojson): ${totalHoles}`);

  // E: Coordinate drift count
  let driftCount = 0;
  if (censusCoords) {
    for (const f of features) {
      const m = f.properties.block.match(/^(.+)-\d+$/);
      if (!m) continue;
      const origRing = censusCoords.get(m[1]);
      if (!origRing) continue;
      const origSet = new Set(origRing.map((c: number[]) => c[0] + "|" + c[1]));

      const rings = f.geometry.type === "Polygon" ? f.geometry.coordinates : f.geometry.coordinates.flatMap((p: any) => p);
      for (const ring of rings) {
        for (const coord of ring) {
          // Check if close to an original but not exact
          const exact = origSet.has(coord[0] + "|" + coord[1]);
          if (exact) continue;
          // Check if within 1e-8 of any original coord
          for (const orig of origRing) {
            if (Math.abs(coord[0] - orig[0]) < 1e-8 && Math.abs(coord[1] - orig[1]) < 1e-8) {
              driftCount++;
              break;
            }
          }
        }
      }
    }
  }
  console.log(`E: Coordinate drift (within 1e-8 but not exact): ${driftCount}`);

  console.log("\n--- Summary ---");
  console.log(`A: ${invalidCount} | B: ${multiCount} | C: ${overlapCount} | D: ${totalHoles} | E: ${driftCount}`);
}

main().catch(err => { console.error(err); process.exit(1); });
