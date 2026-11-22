// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Unit test for the pure moment → equivalent-nodal-forces conversion
// (src/store/momentLoad.ts, extracted in issue #202).
//
// The conversion applies tangential forces F_i = M/S·(n̂×r_i) with
// S = Σ|r_i⊥|², which must reproduce the applied moment exactly
// (Σ r_i × F_i = M) with zero net force.

import { describe, expect, test } from "bun:test";
import { momentToNodalForces } from "../../src/store/momentLoad.ts";

const TOLERANCE = 1e-9;

// Sum the nodal loads into net force [Fx,Fy,Fz] and net moment [Mx,My,Mz]
// about the centroid of the given nodes.
function resultants(loads, nodeById) {
  let count = 0;
  const centroid = [0, 0, 0];
  for (const node of nodeById.values()) {
    centroid[0] += node.x;
    centroid[1] += node.y;
    centroid[2] += node.z;
    count++;
  }
  centroid[0] /= count;
  centroid[1] /= count;
  centroid[2] /= count;

  const force = [0, 0, 0];
  const moment = [0, 0, 0];
  for (const load of loads) {
    const node = nodeById.get(load.nodeId);
    const nodalForce = [0, 0, 0];
    nodalForce[load.dof] = load.value;
    const arm = [
      node.x - centroid[0],
      node.y - centroid[1],
      node.z - centroid[2],
    ];
    force[0] += nodalForce[0];
    force[1] += nodalForce[1];
    force[2] += nodalForce[2];
    moment[0] += arm[1] * nodalForce[2] - arm[2] * nodalForce[1];
    moment[1] += arm[2] * nodalForce[0] - arm[0] * nodalForce[2];
    moment[2] += arm[0] * nodalForce[1] - arm[1] * nodalForce[0];
  }
  return { force, moment };
}

function nodeMap(nodes) {
  return new Map(nodes.map((node) => [node.id, node]));
}

const square = nodeMap([
  { id: 1, x: 0, y: 0, z: 0 },
  { id: 2, x: 10, y: 0, z: 0 },
  { id: 3, x: 10, y: 10, z: 0 },
  { id: 4, x: 0, y: 10, z: 0 },
]);
const squareFace = [{ nodeIds: [1, 2, 3, 4] }];

describe("Mz over a square face reproduces the moment exactly", () => {
  const appliedMoment = 500;
  const loads = momentToNodalForces(
    [0, 0, appliedMoment],
    squareFace,
    square,
    "Load1",
  );
  const { force, moment } = resultants(loads, square);

  test("produces nodal loads", () => {
    expect(loads.length).toBeGreaterThan(0);
  });

  test("zero net force", () => {
    expect(Math.abs(force[0])).toBeLessThan(TOLERANCE);
    expect(Math.abs(force[1])).toBeLessThan(TOLERANCE);
    expect(Math.abs(force[2])).toBeLessThan(TOLERANCE);
  });

  test("net moment equals applied Mz", () => {
    expect(Math.abs(moment[0])).toBeLessThan(TOLERANCE);
    expect(Math.abs(moment[1])).toBeLessThan(TOLERANCE);
    expect(Math.abs(moment[2] - appliedMoment)).toBeLessThan(TOLERANCE);
  });

  test("forces are tangential (no z components)", () => {
    for (const load of loads) expect([0, 1]).toContain(load.dof);
  });
});

describe("componentwise [Mx,0,Mz] superposes the per-axis loads", () => {
  const combined = momentToNodalForces(
    [300, 0, -200],
    squareFace,
    square,
    "Load1",
  );
  const { force, moment } = resultants(combined, square);

  test("zero net force", () => {
    expect(Math.abs(force[0])).toBeLessThan(TOLERANCE);
    expect(Math.abs(force[1])).toBeLessThan(TOLERANCE);
    expect(Math.abs(force[2])).toBeLessThan(TOLERANCE);
  });

  test("net moment equals [300, 0, -200]", () => {
    expect(Math.abs(moment[0] - 300)).toBeLessThan(TOLERANCE);
    expect(Math.abs(moment[1])).toBeLessThan(TOLERANCE);
    expect(Math.abs(moment[2] - -200)).toBeLessThan(TOLERANCE);
  });

  test("combined load count = sum of per-axis counts", () => {
    const loadsMx = momentToNodalForces(
      [300, 0, 0],
      squareFace,
      square,
      "Load1",
    );
    const loadsMz = momentToNodalForces(
      [0, 0, -200],
      squareFace,
      square,
      "Load1",
    );
    expect(combined).toHaveLength(loadsMx.length + loadsMz.length);
  });
});

describe("zero moment vector produces no loads", () => {
  test("no loads generated", () => {
    expect(
      momentToNodalForces([0, 0, 0], squareFace, square, "Load1"),
    ).toHaveLength(0);
  });
});

describe("a face along the moment axis takes the moment at its nodes", () => {
  // All nodes on the x-axis: the face is a line along Mx, a shell edge, with
  // no lever arm for a ring of forces. It takes the moment on the rotational
  // DOF about x, spread by each node's share of the line's length (KOF-446,
  // NAFEMS LE2's edge moment). On a solid node the solve refuses it.
  const line = nodeMap([
    { id: 1, x: 0, y: 0, z: 0 },
    { id: 3, x: 10, y: 0, z: 0 },
    { id: 2, x: 4, y: 0, z: 0 },
  ]);
  const loads = momentToNodalForces(
    [100, 0, 0],
    [{ nodeIds: [1, 3, 2] }],
    line,
    "Load7",
  );

  test("each node takes M · its tributary length / the line's length", () => {
    const byNode = Object.fromEntries(loads.map((l) => [l.nodeId, l]));
    expect(loads).toHaveLength(3);
    for (const l of loads) expect(l.dof).toBe(3);
    // Node 1 owns 0–2, node 2 owns 2–7, node 3 owns 7–10.
    expect(byNode[1].value).toBeCloseTo(20, 12);
    expect(byNode[2].value).toBeCloseTo(50, 12);
    expect(byNode[3].value).toBeCloseTo(30, 12);
  });

  test("a line off the axis by a hair is still a line", () => {
    // A shell edge along z, its mid-surface nodes off the straight line by
    // hundredths of a millimetre: a ring of forces would need lever arms that
    // small and blow up the forces.
    const edge = nodeMap([
      { id: 1, x: 866.0161, y: 500.0165, z: 0 },
      { id: 2, x: 866.0127, y: 500.0226, z: 250 },
      { id: 3, x: 866.0087, y: 500.0295, z: 500 },
    ]);
    const loads = momentToNodalForces(
      [0, 0, 5e5],
      [{ nodeIds: [1, 2, 3] }],
      edge,
      "Edge moment",
    );
    expect(loads.map((l) => l.dof)).toEqual([5, 5, 5]);
    expect(loads.reduce((sum, l) => sum + l.value, 0)).toBeCloseTo(5e5, 6);
  });

  test("a face of one node takes the whole moment", () => {
    const point = nodeMap([{ id: 9, x: 1, y: 2, z: 3 }]);
    expect(
      momentToNodalForces([0, 0, 7], [{ nodeIds: [9] }], point, "Load8"),
    ).toEqual([{ nodeId: 9, dof: 5, value: 7 }]);
  });
});

describe("each face carries the full applied moment", () => {
  // Two parallel square faces stacked in z; the conversion is per-face, so the
  // total transferred moment is M per face (matching rebuildLoads semantics,
  // where a group's faces each receive the group moment).
  const nodes = nodeMap([
    { id: 1, x: 0, y: 0, z: 0 },
    { id: 2, x: 10, y: 0, z: 0 },
    { id: 3, x: 10, y: 10, z: 0 },
    { id: 4, x: 0, y: 10, z: 0 },
    { id: 5, x: 0, y: 0, z: 10 },
    { id: 6, x: 10, y: 0, z: 10 },
    { id: 7, x: 10, y: 10, z: 10 },
    { id: 8, x: 0, y: 10, z: 10 },
  ]);
  const faces = [{ nodeIds: [1, 2, 3, 4] }, { nodeIds: [5, 6, 7, 8] }];
  const appliedMoment = 240;
  const loads = momentToNodalForces(
    [0, 0, appliedMoment],
    faces,
    nodes,
    "Load1",
  );
  const { force, moment } = resultants(loads, nodes);

  test("zero net force", () => {
    expect(Math.abs(force[0])).toBeLessThan(TOLERANCE);
    expect(Math.abs(force[1])).toBeLessThan(TOLERANCE);
    expect(Math.abs(force[2])).toBeLessThan(TOLERANCE);
  });

  test("net moment is M per face (2*M total)", () => {
    expect(Math.abs(moment[2] - 2 * appliedMoment)).toBeLessThan(TOLERANCE);
  });
});
