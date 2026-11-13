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

describe("face whose nodes all lie on the moment axis is skipped", () => {
  // All nodes on the x-axis -> S = 0 for Mx; the face cannot carry the moment.
  const line = nodeMap([
    { id: 1, x: 0, y: 0, z: 0 },
    { id: 2, x: 5, y: 0, z: 0 },
    { id: 3, x: 10, y: 0, z: 0 },
  ]);
  const warnings = [];
  const originalWarn = console.warn;
  let loads;
  try {
    console.warn = (message) => warnings.push(message);
    loads = momentToNodalForces(
      [100, 0, 0],
      [{ nodeIds: [1, 2, 3] }],
      line,
      "Load7",
    );
  } finally {
    console.warn = originalWarn;
  }

  test("no loads generated", () => {
    expect(loads).toHaveLength(0);
  });

  test("a warning names the group and axis", () => {
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('"Load7"');
    expect(warnings[0]).toContain("Mx");
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
