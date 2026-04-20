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
