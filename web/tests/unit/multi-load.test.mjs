// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Unit test for the store → engine surface-load build (rebuildSurfaceLoads,
// src/store/boundaryRebuild.ts) with MULTIPLE selections and MULTIPLE groups.
//
// THE BUG THIS GUARDS (KOF-216): the builder emitted one surface load per picked
// SELECTION, each carrying the group's full force vector. A group's vector is its
// TOTAL, so a 1000 N load picked as three faces reached the engine as three
// separate 1000 N loads and pulled 3000 N — while the panel still said 1000 N.
// One load per GROUP, over the union of its selections, is what makes the engine
// spread the total over the whole loaded region (it divides by the area it
// matched).

import { describe, expect, test } from "bun:test";
import { rebuildSurfaceLoads } from "../../src/store/boundaryRebuild.ts";

// Four disjoint tets, so each face selection below picks out exactly one
// triangular element face.
const elements = [0, 1, 2, 3].map((index) => ({
  id: index,
  type: "CTETRA",
  nodeIds: [4 * index, 4 * index + 1, 4 * index + 2, 4 * index + 3],
  propertyId: 1,
}));
const faceOf = (tet, id) => ({
  id,
  label: `Face ${id}`,
  nodeIds: [4 * tet, 4 * tet + 1, 4 * tet + 2],
});

const forceGroup = (id, components, faces) => ({
  id,
  name: `Load${id}`,
  dof: 1,
  totalForce: components[1],
  components,
  kind: "force",
  faces,
});

// Total force the engine will be asked to apply, summed over every emitted load.
const totalForce = (loads) =>
  loads.reduce(
    (acc, load) =>
      acc.map((value, dof) => value + (load.force ? load.force[dof] : 0)),
    [0, 0, 0],
  );

describe("a group's total is shared across ALL its selections", () => {
  test("a two-face group emits ONE surface load", () => {
    const group = forceGroup(1, [0, -1000, 0], [faceOf(0, 1), faceOf(1, 2)]);
    const loads = rebuildSurfaceLoads([group], elements, []);
    expect(loads).toHaveLength(1);
  });

  test("the group's total force is NOT multiplied by its face count", () => {
    const group = forceGroup(1, [0, -1000, 0], [faceOf(0, 1), faceOf(1, 2)]);
    const loads = rebuildSurfaceLoads([group], elements, []);
    expect(totalForce(loads)[1]).toBe(-1000);
  });

  test("both selections are in the emitted load's face list", () => {
    const group = forceGroup(1, [0, -1000, 0], [faceOf(0, 1), faceOf(1, 2)]);
    const loads = rebuildSurfaceLoads([group], elements, []);
    expect(loads[0].faces).toHaveLength(2);
  });

  // The multiplication grew with the selection count, so a four-face group is
  // the case that made a load off by 4x.
  test("a four-face group still totals the group's force exactly once", () => {
    const faces = [0, 1, 2, 3].map((tet) => faceOf(tet, tet + 1));
    const loads = rebuildSurfaceLoads(
      [forceGroup(1, [0, -1000, 0], faces)],
      elements,
      [],
    );
    expect(loads).toHaveLength(1);
    expect(totalForce(loads)[1]).toBe(-1000);
  });
});

describe("selections overlapping within a group count once", () => {
  // Two selections resolving to the same element face, e.g. a re-pick of a face
  // already in the group. Counting it twice would take a double share of the
  // traction and inflate the area the total is divided by.
  test("a duplicated selection contributes its element face once", () => {
    const group = forceGroup(1, [0, -1000, 0], [faceOf(0, 1), faceOf(0, 2)]);
    const loads = rebuildSurfaceLoads([group], elements, []);
    expect(loads).toHaveLength(1);
    expect(loads[0].faces).toHaveLength(1);
  });
});

describe("several groups stay several loads", () => {
  test("two load groups emit two surface loads", () => {
    const group1 = forceGroup(1, [0, -1000, 0], [faceOf(0, 1)]);
    const group2 = forceGroup(2, [500, 0, 0], [faceOf(1, 2)]);
    const loads = rebuildSurfaceLoads([group1, group2], elements, []);
    expect(loads).toHaveLength(2);
  });

  test("each group contributes its own total", () => {
    const group1 = forceGroup(1, [0, -1000, 0], [faceOf(0, 1)]);
    const group2 = forceGroup(2, [500, 0, 0], [faceOf(1, 2)]);
    const total = totalForce(
      rebuildSurfaceLoads([group1, group2], elements, []),
    );
    expect(total[0]).toBe(500);
    expect(total[1]).toBe(-1000);
  });

  // Two groups on the SAME face is the overlap the engine now integrates for
  // both (see examples/validation/multiple-loads.test.mjs); the store must hand
  // it over as two distinct loads rather than merging them.
  test("two groups on the same face stay two loads totalling both forces", () => {
    const group1 = forceGroup(1, [0, -1000, 0], [faceOf(0, 1)]);
    const group2 = forceGroup(2, [0, -1000, 0], [faceOf(0, 2)]);
    const loads = rebuildSurfaceLoads([group1, group2], elements, []);
    expect(loads).toHaveLength(2);
    expect(totalForce(loads)[1]).toBe(-2000);
  });
});

describe("pressure is intensive: merging must not scale it", () => {
  test("a two-face pressure group emits one load at the prescribed magnitude", () => {
    const group = {
      id: 1,
      name: "Load1",
      dof: 0,
      totalForce: 10,
      kind: "pressure",
      faces: [faceOf(0, 1), faceOf(1, 2)],
    };
    const loads = rebuildSurfaceLoads([group], elements, []);
    expect(loads, JSON.stringify(loads)).toHaveLength(1);
    expect(loads[0].type).toBe("pressure");
    expect(loads[0].pressure).toBe(10);
    expect(loads[0].faces).toHaveLength(2);
  });
});

describe("moment groups still bypass the surface path", () => {
  test("a moment group emits no surface load (it becomes equivalent nodal forces)", () => {
    const group = {
      id: 1,
      name: "Load1",
      dof: 5,
      totalForce: 1000,
      components: [0, 0, 1000],
      kind: "moment",
      faces: [faceOf(0, 1), faceOf(1, 2)],
    };
    expect(rebuildSurfaceLoads([group], elements, [])).toHaveLength(0);
  });
});
