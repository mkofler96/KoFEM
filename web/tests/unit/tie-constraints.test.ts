// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Which nodes a constraint tie finds (lib/tieConstraints.ts), on models small
// enough to state the answer by hand.

import { describe, expect, test } from "bun:test";
import { tieConstraints } from "../../src/lib/tieConstraints.ts";

describe("a constraint tie between surfaces that share a vertex", () => {
  // Two tetrahedra meeting in the plane z = 0 at vertex 0 only: body A above
  // (face 0-1-2), body B below with a smaller face (0-4-5) inside A's. The
  // shared vertex is already joined; B's other face nodes, 4 and 5, lie on A's
  // face and must follow it — the faces around the shared vertex still count.
  const nodes = [
    { id: 0, x: 0, y: 0, z: 0 },
    { id: 1, x: 2, y: 0, z: 0 },
    { id: 2, x: 0, y: 2, z: 0 },
    { id: 3, x: 0, y: 0, z: 1 },
    { id: 4, x: 1, y: 0, z: 0 },
    { id: 5, x: 0, y: 1, z: 0 },
    { id: 6, x: 0, y: 0, z: -1 },
  ];
  const elements = [
    { id: 1, type: "CTETRA", nodeIds: [0, 1, 2, 3], propertyId: 1 },
    { id: 2, type: "CTETRA", nodeIds: [0, 4, 5, 6], propertyId: 2 },
  ];
  const tie = {
    name: "Tie1",
    facesA: [{ nodeIds: [0, 1, 2] }],
    facesB: [{ nodeIds: [0, 4, 5] }],
    extent: "full" as const,
    searchDistance: 0,
    method: "mpc" as const,
  };

  test("ties the exclusive nodes of the finer face, not the shared one", () => {
    const { constraints, reports } = tieConstraints(nodes, elements, [tie], {
      kind: "projection",
    });
    expect(reports[0].nShared).toBe(1);
    expect(constraints.map((constraint) => constraint.slaveId).sort()).toEqual([
      4, 5,
    ]);
    for (const constraint of constraints) {
      expect(constraint.distance).toBeLessThan(1e-12);
      expect(constraint.masterIds).not.toContain(constraint.slaveId);
    }
  });

  test("counts the nodes the mortar weights leave untied", () => {
    // The master face covers too little of node 5's multiplier support, so
    // the mortar weights give it no row: it is reported, not dropped silently.
    const { constraints, reports } = tieConstraints(nodes, elements, [tie], {
      kind: "mortar",
      weights: () =>
        new Map([
          [4, { masterIds: [0, 1, 2], weights: [0.5, 0.5, 0], coverage: 1 }],
        ]),
    });
    expect(constraints.map((constraint) => constraint.slaveId)).toEqual([4]);
    expect(reports[0].nPaired).toBe(1);
    expect(reports[0].nUncovered).toBe(1);
  });

  test("leaves nothing uncovered when every node is tied", () => {
    const { reports } = tieConstraints(nodes, elements, [tie], {
      kind: "projection",
    });
    expect(reports[0].nUncovered).toBe(0);
  });
});
