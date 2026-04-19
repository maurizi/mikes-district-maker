// SPDX-License-Identifier: AGPL-3.0-or-later
// © 2026 Michael Maurizi Jr.

import { readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { type Polygon, type MultiPolygon } from "geojson";

import {
  extractZipToDir,
  readShapefile,
  findShapefile,
  extractVotingData,
  reprojectFeature,
  voteFieldName,
  type PartyVotes
} from "./voting-data";
import { GeosHelper } from "./geos-helper";

// Simple bbox from GeoJSON coordinates (no library needed)
function featureBbox(geom: Polygon | MultiPolygon): [number, number, number, number] {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  const visit = (coords: any): void => {
    if (typeof coords[0] === "number") {
      const [x, y] = coords;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    } else {
      for (const c of coords) visit(c);
    }
  };
  visit((geom as any).coordinates);
  return [minX, minY, maxX, maxY];
}

export interface VotingBlock {
  readonly featureIdx: number;
  readonly geometry: Polygon | MultiPolygon | null;
  readonly weight: number; // VAP_MOD
  readonly setProp: (field: string, value: number) => void;
}

export interface YearVotingResult {
  readonly electionYear: string;
  readonly officesFound: ReadonlySet<string>;
  readonly votingIds: readonly string[];
}

// Per-(block, precinct, office, party) contribution. These are fractional
// during matching and mutated in place by reconciliation to hit VEST precinct
// totals exactly. After reconcile, we sum contributions per block and round
// once to produce the block's final integer vote for that field.
interface Contribution {
  readonly featureIdx: number;
  readonly weight: number; // share of block assigned to this precinct (weight × areaFrac for blended)
  democrat: number;
  republican: number;
  other: number;
}

/**
 * Spatially join one VEST election year to a collection of blocks. For each
 * block we compute a per-precinct CONTRIBUTION (not a single stored value),
 * reconcile those contributions so each precinct's sum matches VEST exactly,
 * and only then roll up per block and write out integer vote columns. This
 * is the correct way to handle blocks that straddle precinct boundaries —
 * summing block totals in reconcile (as the original code did) double-counts
 * blended blocks across adjacent precincts and loses ~10% of votes at state
 * level.
 */
export async function applyVestYearVotes(
  vestZipPath: string,
  precinctField: string,
  blocks: readonly VotingBlock[],
  geosHelper: GeosHelper,
  log: (s: string) => void
): Promise<YearVotingResult> {
  // ---- Load + extract VEST ----
  log(`\nLoading VEST: ${vestZipPath}`);
  const vestBuffer = readFileSync(vestZipPath);
  const vestDir = join(tmpdir(), `vest-spatial-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await extractZipToDir(vestBuffer, vestDir);
  const { shpPath: vestShp, dbfPath: vestDbf, prjPath: vestPrj } = findShapefile(vestDir);
  let vestFeatures = await readShapefile(vestShp, vestDbf);
  log(`  ${vestFeatures.length} precincts loaded`);

  if (vestPrj) {
    const prjContent = readFileSync(vestPrj, "utf-8").trim();
    if (prjContent.startsWith("PROJCS")) {
      log(`  Reprojecting to WGS84...`);
      vestFeatures = vestFeatures.map(f => reprojectFeature(f, prjContent));
    }
  }

  const precinctData = new Map<
    number,
    {
      votes: Record<string, PartyVotes>;
      totalVotes: Record<string, number>;
    }
  >();
  const officesFound = new Set<string>();
  let electionYear = "";
  for (let i = 0; i < vestFeatures.length; i++) {
    const props = vestFeatures[i].properties as Record<string, any>;
    const { byOffice, electionYear: yr } = extractVotingData(props);
    if (yr && !electionYear) electionYear = yr;
    for (const office of Object.keys(byOffice)) officesFound.add(office);
    const totalVotes: Record<string, number> = {};
    for (const [office, v] of Object.entries(byOffice)) {
      totalVotes[office] = v.democrat + v.republican + v.other;
    }
    precinctData.set(i, { votes: byOffice, totalVotes });
  }
  log(`  Year: 20${electionYear}, offices: ${Array.from(officesFound).sort().join(", ")}`);

  if (!electionYear) {
    log(`  WARNING: no election year detected in ${vestShp}; skipping`);
    return { electionYear: "", officesFound: new Set(), votingIds: [] };
  }

  const votingIds: string[] = [];
  for (const office of Array.from(officesFound).sort()) {
    for (const party of ["democrat", "republican", "other"] as const) {
      votingIds.push(voteFieldName(office, party, electionYear));
    }
  }

  // ---- Build precinct GEOS geometries + bbox grid for spatial candidates ----
  const precinctGeoms: (number | null)[] = [];
  const preparedPrecincts: (number | null)[] = [];
  const precinctBboxes: [number, number, number, number][] = [];
  for (let i = 0; i < vestFeatures.length; i++) {
    const geom = vestFeatures[i].geometry;
    if (!geom) {
      precinctGeoms.push(null);
      preparedPrecincts.push(null);
      precinctBboxes.push([0, 0, 0, 0]);
      continue;
    }
    try {
      let g = geosHelper.fromGeoJSON(geom as Polygon | MultiPolygon);
      if (!geosHelper.isValid(g)) {
        const f = geosHelper.makeValid(g);
        geosHelper.free(g);
        g = f;
      }
      precinctGeoms.push(g);
      const buffered = geosHelper.buffer(g, 0.0001);
      preparedPrecincts.push(geosHelper.prepare(buffered));
      precinctBboxes.push(featureBbox(geom as Polygon | MultiPolygon));
    } catch {
      precinctGeoms.push(null);
      preparedPrecincts.push(null);
      precinctBboxes.push([0, 0, 0, 0]);
    }
  }

  const GRID_SIZE = 200;
  let gsMinX = Infinity,
    gsMinY = Infinity,
    gsMaxX = -Infinity,
    gsMaxY = -Infinity;
  for (const [pMinX, pMinY, pMaxX, pMaxY] of precinctBboxes) {
    if (pMinX === 0 && pMaxX === 0) continue;
    if (pMinX < gsMinX) gsMinX = pMinX;
    if (pMinY < gsMinY) gsMinY = pMinY;
    if (pMaxX > gsMaxX) gsMaxX = pMaxX;
    if (pMaxY > gsMaxY) gsMaxY = pMaxY;
  }
  const gW = (gsMaxX - gsMinX) / GRID_SIZE || 1;
  const gH = (gsMaxY - gsMinY) / GRID_SIZE || 1;
  const grid: number[][] = new Array(GRID_SIZE * GRID_SIZE);
  for (let i = 0; i < grid.length; i++) grid[i] = [];
  for (let pi = 0; pi < vestFeatures.length; pi++) {
    const [pMinX, pMinY, pMaxX, pMaxY] = precinctBboxes[pi];
    if (pMinX === 0 && pMaxX === 0) continue;
    const x0 = Math.max(0, Math.min(GRID_SIZE - 1, Math.floor((pMinX - gsMinX) / gW)));
    const y0 = Math.max(0, Math.min(GRID_SIZE - 1, Math.floor((pMinY - gsMinY) / gH)));
    const x1 = Math.max(0, Math.min(GRID_SIZE - 1, Math.floor((pMaxX - gsMinX) / gW)));
    const y1 = Math.max(0, Math.min(GRID_SIZE - 1, Math.floor((pMaxY - gsMinY) / gH)));
    for (let gy = y0; gy <= y1; gy++)
      for (let gx = x0; gx <= x1; gx++) grid[gy * GRID_SIZE + gx].push(pi);
  }

  // ---- Match + build contributions ----
  log(`  Joining ${blocks.length} blocks...`);

  // precinctAssigned: pi → office → contributions[]
  // One Contribution entry per (block, precinct, office).
  const precinctAssigned = new Map<number, Map<string, Contribution[]>>();
  const pushContrib = (
    pi: number,
    office: string,
    contrib: Contribution
  ): void => {
    let byOffice = precinctAssigned.get(pi);
    if (!byOffice) {
      byOffice = new Map();
      precinctAssigned.set(pi, byOffice);
    }
    let arr = byOffice.get(office);
    if (!arr) {
      arr = [];
      byOffice.set(office, arr);
    }
    arr.push(contrib);
  };

  let single = 0,
    blended = 0,
    noMatch = 0;

  const zeroBlock = (blk: VotingBlock): void => {
    for (const id of votingIds) blk.setProp(id, 0);
  };

  for (const blk of blocks) {
    if (!blk.geometry) {
      zeroBlock(blk);
      noMatch++;
      continue;
    }
    const [bMinX, bMinY, bMaxX, bMaxY] = featureBbox(blk.geometry);
    const bcx = (bMinX + bMaxX) / 2;
    const bcy = (bMinY + bMaxY) / 2;
    const gxi = Math.max(0, Math.min(GRID_SIZE - 1, Math.floor((bcx - gsMinX) / gW)));
    const gyi = Math.max(0, Math.min(GRID_SIZE - 1, Math.floor((bcy - gsMinY) / gH)));
    const gridCands = grid[gyi * GRID_SIZE + gxi];

    const candidates: number[] = [];
    for (const pi of gridCands) {
      const [pMinX, pMinY, pMaxX, pMaxY] = precinctBboxes[pi];
      if (bMaxX >= pMinX && bMinX <= pMaxX && bMaxY >= pMinY && bMinY <= pMaxY) {
        candidates.push(pi);
      }
    }
    if (candidates.length === 0) {
      zeroBlock(blk);
      noMatch++;
      continue;
    }

    let featGeom: any;
    try {
      featGeom = geosHelper.fromGeoJSON(blk.geometry);
      if (!geosHelper.isValid(featGeom)) {
        const fixed = geosHelper.makeValid(featGeom);
        geosHelper.free(featGeom);
        featGeom = fixed;
      }
    } catch {
      zeroBlock(blk);
      noMatch++;
      continue;
    }

    // ---- Single-containment fast path ----
    let containingPi: number | null = null;
    for (const pi of candidates) {
      const prep = preparedPrecincts[pi];
      if (!prep) continue;
      try {
        if (geosHelper.preparedContains(prep, featGeom)) {
          containingPi = pi;
          break;
        }
      } catch {
        /* skip */
      }
    }

    if (containingPi !== null) {
      single++;
      geosHelper.free(featGeom);
      const pd = precinctData.get(containingPi)!;
      for (const office of Array.from(officesFound)) {
        const v = pd.votes[office] || { democrat: 0, republican: 0, other: 0 };
        const total = pd.totalVotes[office] || 0;
        const w = blk.weight;
        const fracD = total > 0 ? (v.democrat / total) * w : 0;
        const fracR = total > 0 ? (v.republican / total) * w : 0;
        const fracO = total > 0 ? (v.other / total) * w : 0;
        pushContrib(containingPi, office, {
          featureIdx: blk.featureIdx,
          weight: w,
          democrat: fracD,
          republican: fracR,
          other: fracO
        });
      }
      continue;
    }

    // ---- Blended: area-weighted intersection ----
    blended++;
    const intersections: { pi: number; area: number }[] = [];
    for (const pi of candidates) {
      const pGeom = precinctGeoms[pi];
      if (!pGeom) continue;
      try {
        const inter = geosHelper.intersection(featGeom, pGeom);
        if (inter) {
          const a = geosHelper.area(inter);
          geosHelper.free(inter);
          if (a > 0) intersections.push({ pi, area: a });
        }
      } catch {
        /* skip */
      }
    }
    geosHelper.free(featGeom);

    if (intersections.length === 0) {
      zeroBlock(blk);
      noMatch++;
      continue;
    }

    const totalArea = intersections.reduce((s, x) => s + x.area, 0);
    for (const int of intersections) {
      const areaFrac = totalArea > 0 ? int.area / totalArea : 0;
      const w = blk.weight * areaFrac;
      const pd = precinctData.get(int.pi)!;
      for (const office of Array.from(officesFound)) {
        const v = pd.votes[office] || { democrat: 0, republican: 0, other: 0 };
        const total = pd.totalVotes[office] || 0;
        const fracD = total > 0 ? (v.democrat / total) * w : 0;
        const fracR = total > 0 ? (v.republican / total) * w : 0;
        const fracO = total > 0 ? (v.other / total) * w : 0;
        pushContrib(int.pi, office, {
          featureIdx: blk.featureIdx,
          weight: w,
          democrat: fracD,
          republican: fracR,
          other: fracO
        });
      }
    }
  }

  log(`  Join: ${single} single, ${blended} blended, ${noMatch} no match`);

  // Diagnostic: precincts that got no blocks assigned are votes we lose.
  {
    let emptyPrecincts = 0;
    let lostVotes = 0;
    for (let pi = 0; pi < vestFeatures.length; pi++) {
      if (precinctAssigned.has(pi)) continue;
      const pd = precinctData.get(pi);
      if (!pd) continue;
      const totalHere = Object.values(pd.totalVotes).reduce((s, v) => s + v, 0);
      if (totalHere > 0) {
        emptyPrecincts++;
        lostVotes += totalHere;
      }
    }
    if (emptyPrecincts > 0) {
      log(`  WARNING: ${emptyPrecincts} precincts with no block match; ~${lostVotes.toLocaleString()} votes lost`);
    }
  }

  for (const p of preparedPrecincts) if (p) geosHelper.freePrepared(p);
  for (const g of precinctGeoms) if (g) geosHelper.free(g);

  // ---- Reconcile each precinct's contributions to match VEST totals exactly ----
  // Work in floating point; round only when finalizing per-block totals.
  let reconciled = 0;
  for (const [pi, byOffice] of Array.from(precinctAssigned.entries())) {
    const pd = precinctData.get(pi)!;
    for (const [office, contribs] of Array.from(byOffice.entries())) {
      const v = pd.votes[office] || { democrat: 0, republican: 0, other: 0 };
      for (const party of ["democrat", "republican", "other"] as const) {
        const expected = v[party];
        const actual = contribs.reduce((s, c) => s + c[party], 0);
        const diff = expected - actual;
        // Apportion diff across contributions weighted by their weight field.
        // Uniform fallback for zero-weight precincts (e.g. all-prison blocks)
        // so their votes still land somewhere.
        if (Math.abs(diff) < 1e-9) continue;
        reconciled++;
        const rawWeights = contribs.map(c => c.weight);
        const positive = rawWeights.some(w => w > 0);
        const weights = positive ? rawWeights : rawWeights.map(() => 1);
        const totalW = weights.reduce((a, b) => a + b, 0);
        if (totalW === 0) continue;
        for (let i = 0; i < contribs.length; i++) {
          contribs[i][party] += diff * (weights[i] / totalW);
        }
      }
    }
  }
  log(`  Reconciled ${reconciled} precinct-party totals`);

  // ---- Round contributions to integers per-precinct via largest-remainder ----
  // Each (precinct, office, party) group should sum to the VEST integer total.
  // Fractional contributions are rounded so per-precinct sums stay exact.
  for (const [pi, byOffice] of Array.from(precinctAssigned.entries())) {
    const pd = precinctData.get(pi)!;
    for (const [office, contribs] of Array.from(byOffice.entries())) {
      const v = pd.votes[office] || { democrat: 0, republican: 0, other: 0 };
      for (const party of ["democrat", "republican", "other"] as const) {
        const expected = v[party];
        if (contribs.length === 0) continue;
        // Start from floors; distribute the integer residual to contributions
        // with the largest fractional parts.
        const floored = contribs.map(c => Math.floor(Math.max(0, c[party])));
        let residual = expected - floored.reduce((a, b) => a + b, 0);
        if (residual === 0) {
          for (let i = 0; i < contribs.length; i++) contribs[i][party] = floored[i];
          continue;
        }
        const idxs = contribs
          .map((c, i) => ({
            i,
            frac: Math.max(0, c[party]) - floored[i]
          }))
          .sort((a, b) => b.frac - a.frac);
        if (residual > 0) {
          for (let k = 0; k < residual; k++) floored[idxs[k % idxs.length].i]++;
        } else {
          // Expected < floor sum shouldn't normally happen (floored ≤ frac sum
          // after fractional reconcile), but guard it anyway.
          for (let k = 0; k < -residual; k++) {
            const target = idxs[k % idxs.length].i;
            if (floored[target] > 0) floored[target]--;
          }
        }
        for (let i = 0; i < contribs.length; i++) contribs[i][party] = floored[i];
      }
    }
  }

  // ---- Write per-block totals by summing contributions ----
  // Group contributions per block so we can sum per (block, office, party).
  const blockContribs = new Map<number, Map<string, Contribution[]>>();
  for (const byOffice of precinctAssigned.values()) {
    for (const [office, contribs] of byOffice) {
      for (const c of contribs) {
        let byOfficeBlk = blockContribs.get(c.featureIdx);
        if (!byOfficeBlk) {
          byOfficeBlk = new Map();
          blockContribs.set(c.featureIdx, byOfficeBlk);
        }
        let arr = byOfficeBlk.get(office);
        if (!arr) {
          arr = [];
          byOfficeBlk.set(office, arr);
        }
        arr.push(c);
      }
    }
  }

  for (const blk of blocks) {
    const byOffice = blockContribs.get(blk.featureIdx);
    if (!byOffice) continue; // block had no match; already zeroed above
    for (const office of Array.from(officesFound)) {
      const contribs = byOffice.get(office) || [];
      let d = 0,
        r = 0,
        o = 0;
      for (const c of contribs) {
        d += c.democrat;
        r += c.republican;
        o += c.other;
      }
      blk.setProp(voteFieldName(office, "democrat", electionYear), d);
      blk.setProp(voteFieldName(office, "republican", electionYear), r);
      blk.setProp(voteFieldName(office, "other", electionYear), o);
    }
  }

  return { electionYear, officesFound, votingIds };
}
