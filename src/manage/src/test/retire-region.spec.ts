// SPDX-License-Identifier: AGPL-3.0-or-later
// © 2026 Michael Maurizi Jr.

import { type DistrictsDefinition, type GeoUnitHierarchy } from "../../../shared/entities";
import { buildBlockAssignment } from "../../../shared/boundary";
import { migrateDefinition, type RegionArtifacts } from "../commands/retire-region";

function region(blockIds: readonly string[], hierarchy: GeoUnitHierarchy): RegionArtifacts {
  // numBlocks must equal blockIds.length; in the real loader these come from
  // counting hierarchy leaves but the test data is small enough to assert here.
  return { blockIds, hierarchy, numBlocks: blockIds.length };
}

// Resolve a definition to a flat blockId -> district map by walking both trees
// in lockstep. This is the ground truth a successful migration must preserve.
function definitionByBlockId(
  definition: DistrictsDefinition,
  r: RegionArtifacts
): Record<string, number> {
  const assignment = buildBlockAssignment(definition, r.hierarchy, r.numBlocks);
  const out: Record<string, number> = {};
  for (let i = 0; i < r.numBlocks; i++) {
    if (assignment[i] !== 0) out[r.blockIds[i]] = assignment[i];
  }
  return out;
}

describe("migrateDefinition", () => {
  it("preserves per-GEOID assignments when block indices are reordered", () => {
    // Old: blocks [A,B,C,D] grouped as [[A,B],[C,D]] — A,B in district 1; C,D in district 2.
    const oldRegion = region(
      ["A", "B", "C", "D"],
      [
        [0, 1],
        [2, 3]
      ]
    );
    const oldDefinition: DistrictsDefinition = [
      [1, 1],
      [2, 2]
    ];

    // New build keeps the same blocks but reorders them: [B,D,A,C] still grouped 2x2.
    const newRegion = region(
      ["B", "D", "A", "C"],
      [
        [0, 1],
        [2, 3]
      ]
    );

    const { newDefinition, missingGeoIds } = migrateDefinition(oldDefinition, oldRegion, newRegion);

    expect(missingGeoIds).toEqual([]);
    // Per-GEOID assignments must round-trip.
    expect(definitionByBlockId(newDefinition, newRegion)).toEqual({
      A: 1,
      B: 1,
      C: 2,
      D: 2
    });
  });

  it("preserves assignments when the parent grouping changes shape", () => {
    // Old: 4 blocks, grouped 2+2.
    const oldRegion = region(
      ["A", "B", "C", "D"],
      [
        [0, 1],
        [2, 3]
      ]
    );
    // A,C in district 1; B,D in district 2 (intentionally interleaved across parents).
    const oldDefinition: DistrictsDefinition = [
      [1, 2],
      [1, 2]
    ];

    // New build regroups the same 4 blocks under a single parent.
    const newRegion = region(["A", "B", "C", "D"], [[0, 1, 2, 3]]);

    const { newDefinition, missingGeoIds } = migrateDefinition(oldDefinition, oldRegion, newRegion);

    expect(missingGeoIds).toEqual([]);
    expect(definitionByBlockId(newDefinition, newRegion)).toEqual({
      A: 1,
      B: 2,
      C: 1,
      D: 2
    });
  });

  it("reports GEOIDs dropped by the new build and leaves them unassigned", () => {
    // Old: 3 blocks all in district 1.
    const oldRegion = region(["A", "B", "C"], [[0, 1, 2]]);
    const oldDefinition: DistrictsDefinition = [[1, 1, 1]];

    // New build dropped C entirely.
    const newRegion = region(["A", "B"], [[0, 1]]);

    const { newDefinition, missingGeoIds } = migrateDefinition(oldDefinition, oldRegion, newRegion);

    expect(missingGeoIds).toEqual(["C"]);
    expect(definitionByBlockId(newDefinition, newRegion)).toEqual({
      A: 1,
      B: 1
    });
  });

  it("leaves GEOIDs added by the new build unassigned", () => {
    const oldRegion = region(["A", "B"], [[0, 1]]);
    const oldDefinition: DistrictsDefinition = [[1, 2]];

    // New build added a brand-new block C.
    const newRegion = region(["A", "B", "C"], [[0, 1, 2]]);

    const { newDefinition, missingGeoIds } = migrateDefinition(oldDefinition, oldRegion, newRegion);

    expect(missingGeoIds).toEqual([]);
    // C is missing from the map, so it stays at district 0 (unassigned).
    expect(definitionByBlockId(newDefinition, newRegion)).toEqual({
      A: 1,
      B: 2
    });
  });

  it("expands a block that the new build split into sub-blocks", () => {
    // Old: parent block "A" assigned to district 3.
    const oldRegion = region(["A", "B"], [[0, 1]]);
    const oldDefinition: DistrictsDefinition = [[3, 0]];

    // New build split "A" into "A-1", "A-2"; B unchanged.
    const newRegion = region(["A-1", "A-2", "B"], [[0, 1, 2]]);

    const { newDefinition, missingGeoIds } = migrateDefinition(oldDefinition, oldRegion, newRegion);

    // Old "A" wasn't a direct hit but is the parent in the split map, so it's
    // not "missing".
    expect(missingGeoIds).toEqual([]);
    expect(definitionByBlockId(newDefinition, newRegion)).toEqual({
      "A-1": 3,
      "A-2": 3
    });
  });

  it("collapses old sub-blocks into a single new base when they agree", () => {
    // Old: "A-1", "A-2" both in district 3.
    const oldRegion = region(["A-1", "A-2", "B"], [[0, 1, 2]]);
    const oldDefinition: DistrictsDefinition = [[3, 3, 0]];

    // New build merged the splits — just "A" now.
    const newRegion = region(["A", "B"], [[0, 1]]);

    const { newDefinition, missingGeoIds, conflictedNewIds } = migrateDefinition(
      oldDefinition,
      oldRegion,
      newRegion
    );

    expect(missingGeoIds).toEqual([]);
    expect(conflictedNewIds).toEqual([]);
    expect(definitionByBlockId(newDefinition, newRegion)).toEqual({ A: 3 });
  });

  it("preserves block-level intent — won't roll up a sub-block boundary the user explicitly drew", () => {
    // Old: one precinct, defined block-level (the array form means the user
    // assigned at block granularity rather than collapsing to a number).
    // A-1 and A-2 are in different districts — that's an intentional
    // sub-block boundary inside a single old precinct.
    const oldRegion = region(["A-1", "A-2", "C1"], [[0, 1, 2]]);
    const oldDefinition: DistrictsDefinition = [[3, 7, 3]];

    // New build merged the splits; new precinct has merged A and C1.
    const newRegion = region(["A", "C1"], [[0, 1]]);

    const { newDefinition, missingGeoIds, conflictedNewIds } = migrateDefinition(
      oldDefinition,
      oldRegion,
      newRegion
    );

    expect(missingGeoIds).toEqual([]);
    // Even though C1 anchors the new precinct to district 3, A's two halves
    // had block-level intent — refuse to defer; A stays unassigned.
    expect(conflictedNewIds).toEqual(["A"]);
    expect(definitionByBlockId(newDefinition, newRegion)).toEqual({ C1: 3 });
  });

  it("rolls up an ambiguous merged block when its new precinct's other blocks anchor to one district", () => {
    // Old: two precincts, both collapsed to a number (precinct-level intent).
    //   Precinct A = district 3, contains A-1 (split block) and C1.
    //   Precinct B = district 7, contains A-2 (the other half of the split).
    // The split was at the old precinct boundary.
    const oldRegion = region(["A-1", "C1", "A-2"], [[0, 1], [2]]);
    const oldDefinition: DistrictsDefinition = [3, 7];

    // New build merged the splits AND drew a new precinct around new "A" + C1.
    // (A-2's old geometry is no longer in this new precinct; it lives elsewhere
    // and is dropped from this test's frame.)
    const newRegion = region(["A", "C1"], [[0, 1]]);

    const { newDefinition, missingGeoIds, conflictedNewIds } = migrateDefinition(
      oldDefinition,
      oldRegion,
      newRegion
    );

    expect(missingGeoIds).toEqual([]);
    expect(conflictedNewIds).toEqual([]);
    // C1 anchors to 3. A is ambiguous {3,7} but both sources had precinct-level
    // intent, so it defers to the precinct and inherits 3. Whole precinct = 3.
    expect(definitionByBlockId(newDefinition, newRegion)).toEqual({ A: 3, C1: 3 });
  });

  it("leaves a merged block unassigned when the new precinct's anchors themselves disagree", () => {
    // Old: two precincts, both collapsed (precinct-level intent).
    //   Precinct A = 3, contains A-1, C1.
    //   Precinct B = 7, contains A-2, D1.
    const oldRegion = region(
      ["A-1", "C1", "A-2", "D1"],
      [
        [0, 1],
        [2, 3]
      ]
    );
    const oldDefinition: DistrictsDefinition = [3, 7];

    // New build merged splits, then drew a new precinct that crosses the old
    // district line — pulls C1 (old district 3) and D1 (old district 7) under
    // one new precinct alongside the merged A.
    const newRegion = region(["A", "C1", "D1"], [[0, 1, 2]]);

    const { newDefinition, missingGeoIds, conflictedNewIds } = migrateDefinition(
      oldDefinition,
      oldRegion,
      newRegion
    );

    expect(missingGeoIds).toEqual([]);
    // C1 anchors 3, D1 anchors 7 — singletons disagree. No precinct rollup.
    // A stays unassigned (and reported); singletons keep their values.
    expect(conflictedNewIds).toEqual(["A"]);
    expect(definitionByBlockId(newDefinition, newRegion)).toEqual({ C1: 3, D1: 7 });
  });

  it("treats unassigned old sub-blocks as abstaining from the merge vote", () => {
    // Old: A-1 -> 3, A-2 unassigned. Only A-1 votes; merged base inherits 3.
    const oldRegion = region(["A-1", "A-2", "B"], [[0, 1, 2]]);
    const oldDefinition: DistrictsDefinition = [[3, 0, 0]];

    const newRegion = region(["A", "B"], [[0, 1]]);

    const { newDefinition, missingGeoIds, conflictedNewIds } = migrateDefinition(
      oldDefinition,
      oldRegion,
      newRegion
    );

    expect(missingGeoIds).toEqual([]);
    expect(conflictedNewIds).toEqual([]);
    expect(definitionByBlockId(newDefinition, newRegion)).toEqual({ A: 3 });
  });

  it("collapses uniform branches into the compact number form", () => {
    // 6 blocks across 3 parents — uniform district 1 in parent 0, uniform
    // district 2 in parent 1, mixed in parent 2.
    const oldRegion = region(
      ["A", "B", "C", "D", "E", "F"],
      [
        [0, 1],
        [2, 3],
        [4, 5]
      ]
    );
    const oldDefinition: DistrictsDefinition = [
      [1, 1],
      [2, 2],
      [1, 2]
    ];

    const newRegion = region(
      ["A", "B", "C", "D", "E", "F"],
      [
        [0, 1],
        [2, 3],
        [4, 5]
      ]
    );
    const { newDefinition } = migrateDefinition(oldDefinition, oldRegion, newRegion);

    // Uniform parents collapse to a single number; the mixed one stays
    // expanded. The bare number is the compact form — buildBlockAssignment
    // propagates it across all leaves under that branch.
    expect(newDefinition).toEqual([1, 2, [1, 2]]);
  });

  it("normalizes an entirely-uniform definition to one number per top-level branch", () => {
    // Every block in district 1. Inner branches collapse to bare `1`; the
    // root MUST stay an array because DistrictsDefinition is
    // MutableGeoUnitCollection[] and downstream callers index into it.
    const oldRegion = region(
      ["A", "B", "C", "D"],
      [
        [0, 1],
        [2, 3]
      ]
    );
    const oldDefinition: DistrictsDefinition = [
      [1, 1],
      [1, 1]
    ];
    const newRegion = region(
      ["A", "B", "C", "D"],
      [
        [0, 1],
        [2, 3]
      ]
    );
    const { newDefinition } = migrateDefinition(oldDefinition, oldRegion, newRegion);

    expect(newDefinition).toEqual([1, 1]);
    expect(definitionByBlockId(newDefinition, newRegion)).toEqual({
      A: 1,
      B: 1,
      C: 1,
      D: 1
    });
  });

  it("collapses single-child branches like [1] down to 1", () => {
    // Mirrors the real-world DE shape: a parent has one tract with a single
    // block. Without the fix, that tract would stay [1] (length === 1 guard),
    // breaking parent uniformity since 1 !== [1] by reference; the parent
    // would then stay expanded as [1, [1]] when it could be just 1.
    const oldRegion = region(
      ["A", "B"],
      [
        [0],
        [1] // second parent has a single-block child
      ]
    );
    const oldDefinition: DistrictsDefinition = [[1], [1]];

    const newRegion = region(["A", "B"], [[0], [1]]);

    const { newDefinition } = migrateDefinition(oldDefinition, oldRegion, newRegion);

    // Each parent collapses to 1 (single child uniformly assigned). Root
    // stays an array.
    expect(newDefinition).toEqual([1, 1]);
  });

  it("ignores unassigned blocks when building the GEOID map", () => {
    // Old: A in district 1, B unassigned.
    const oldRegion = region(["A", "B"], [[0, 1]]);
    const oldDefinition: DistrictsDefinition = [[1, 0]];

    // New build drops B. B was unassigned in old, so its absence shouldn't
    // surface as a missing-GEOID warning.
    const newRegion = region(["A"], [[0]]);

    const { newDefinition, missingGeoIds } = migrateDefinition(oldDefinition, oldRegion, newRegion);

    expect(missingGeoIds).toEqual([]);
    expect(definitionByBlockId(newDefinition, newRegion)).toEqual({ A: 1 });
  });
});
