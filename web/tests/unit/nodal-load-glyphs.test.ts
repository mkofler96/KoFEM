// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// The per-node load glyphs (loadDisplay === "nodal") show the load each node
// carries. On a shell the usual loaded selection is an EDGE — the rim a plate's
// end face collapsed to — or a single point, neither of which spans a whole
// facet, so they must be shown as the solver applies them (KOF-357).

import { expect, test } from "bun:test";
import { nodalLoadVectors } from "../../src/lib/nodalLoadGlyphs";
import type { NamedLoadGroup } from "../../src/store/boundaryGroups";
import type { Element, Node } from "../../src/store/geometrySlice";

// A 2 x 1 shell plate in z = 0, four CTRIA3 facets wound counter-clockwise
// (winding normal +z). The x = 2 rim carries nodes 3, 6 and 9.
//
//   7 ── 8 ── 9     y = 1
//   │    │    │
//   4 ── 5 ── 6     y = 0.5
//   │    │    │
//   1 ── 2 ── 3     y = 0
const plateNodes: Node[] = [
  { id: 1, x: 0, y: 0, z: 0 },
  { id: 2, x: 1, y: 0, z: 0 },
  { id: 3, x: 2, y: 0, z: 0 },
  { id: 4, x: 0, y: 0.5, z: 0 },
  { id: 5, x: 1, y: 0.5, z: 0 },
  { id: 6, x: 2, y: 0.5, z: 0 },
  { id: 7, x: 0, y: 1, z: 0 },
  { id: 8, x: 1, y: 1, z: 0 },
  { id: 9, x: 2, y: 1, z: 0 },
];
const tri = (id: number, nodeIds: number[]): Element => ({
  id,
  type: "CTRIA3",
  nodeIds,
  propertyId: 1,
});
const plate: Element[] = [
  tri(1, [1, 2, 5]),
  tri(2, [1, 5, 4]),
  tri(3, [2, 3, 6]),
  tri(4, [2, 6, 5]),
  tri(5, [4, 5, 8]),
  tri(6, [4, 8, 7]),
  tri(7, [5, 6, 9]),
  tri(8, [5, 9, 8]),
];

function group(
  partial: Partial<NamedLoadGroup> & Pick<NamedLoadGroup, "faces">,
): NamedLoadGroup {
  return { id: 1, name: "Load1", dof: 0, totalForce: 0, ...partial };
}

function vectors(loadGroups: NamedLoadGroup[], elements = plate) {
  const out = nodalLoadVectors({
    loadGroups,
    nodes: plateNodes,
    elements,
    couplingGroups: [],
  });
  // Rounded force vectors (dir · mag), keyed by node id.
  return Object.fromEntries(
    [...out].map(([id, { dir, mag }]) => [
      id,
      dir.map((d) => Math.round(d * mag * 1e9) / 1e9 + 0),
    ]),
  );
}

test("a force on a shell edge is shown at the rim nodes as a line load", () => {
  const load = group({
    kind: "force",
    components: [100, 0, 0],
    faces: [{ id: 1, label: "Edge 1", nodeIds: [3, 6, 9], geometry: "edge" }],
  });
  // Two edges of length 0.5 share 100 N: q·L/2 per edge end.
  expect(vectors([load])).toEqual({
    3: [25, 0, 0],
    6: [50, 0, 0],
    9: [25, 0, 0],
  });
});

test("a force on a single picked point is shown at that node", () => {
  const load = group({
    kind: "force",
    components: [0, 0, -40],
    faces: [{ id: 1, label: "Point 1", nodeIds: [5], geometry: "point" }],
  });
  expect(vectors([load])).toEqual({ 5: [0, 0, -40] });
});

test("pressure on shell facets acts against the winding normal, as the shell solver applies it", () => {
  // The facet [2, 3, 6] alone (area 0.25), wound +z: -p·n̂·A/3 per node.
  const load = group({
    kind: "pressure",
    totalForce: 12,
    faces: [{ id: 1, label: "Face 1", nodeIds: [2, 3, 6] }],
  });
  expect(vectors([load])).toEqual({
    2: [0, 0, -1],
    3: [0, 0, -1],
    6: [0, 0, -1],
  });
});

test("a force on shell facets is shared by tributary area", () => {
  const load = group({
    kind: "force",
    components: [0, 0, 30],
    faces: [{ id: 1, label: "Face 1", nodeIds: [2, 3, 6] }],
  });
  expect(vectors([load])).toEqual({
    2: [0, 0, 10],
    3: [0, 0, 10],
    6: [0, 0, 10],
  });
});

test("a force on a solid's face is shared by tributary area of its boundary faces", () => {
  // One tet; the loaded face is its z = 0 base [1, 2, 4] (area 0.25).
  const tet: Element = {
    id: 1,
    type: "CTETRA",
    nodeIds: [1, 2, 4, 5],
    propertyId: 1,
  };
  const nodes: Node[] = [
    ...plateNodes.slice(0, 4),
    { id: 5, x: 0, y: 0, z: 1 },
  ];
  const out = nodalLoadVectors({
    loadGroups: [
      group({
        kind: "force",
        components: [0, -9, 0],
        faces: [{ id: 1, label: "Face 1", nodeIds: [1, 2, 4] }],
      }),
    ],
    nodes,
    elements: [tet],
    couplingGroups: [],
  });
  expect([...out.keys()].sort()).toEqual([1, 2, 4]);
  for (const { dir, mag } of out.values()) {
    expect(mag).toBeCloseTo(3, 12);
    expect(dir[1]).toBeCloseTo(-1, 12);
  }
});

test("moments have no per-node glyphs", () => {
  const load = group({
    kind: "moment",
    dof: 5,
    components: [0, 0, 10],
    faces: [{ id: 1, label: "Edge 1", nodeIds: [3, 6, 9], geometry: "edge" }],
  });
  expect(vectors([load])).toEqual({});
});

test("an interior solid face inside the selection takes no share", () => {
  // Two tets share the face [1, 2, 3]. Selecting nodes 1–4 spans the three
  // outer faces of the upper tet and that interior face, which carries no load.
  const nodes: Node[] = [
    { id: 1, x: 0, y: 0, z: 0 },
    { id: 2, x: 1, y: 0, z: 0 },
    { id: 3, x: 0, y: 1, z: 0 },
    { id: 4, x: 0, y: 0, z: 1 },
    { id: 5, x: 0, y: 0, z: -1 },
  ];
  const tet = (id: number, nodeIds: number[]): Element => ({
    id,
    type: "CTETRA",
    nodeIds,
    propertyId: 1,
  });
  const out = nodalLoadVectors({
    loadGroups: [
      group({
        kind: "force",
        components: [6, 0, 0],
        faces: [{ id: 1, label: "Face 1", nodeIds: [1, 2, 3, 4] }],
      }),
    ],
    nodes,
    elements: [tet(1, [1, 2, 3, 4]), tet(2, [1, 2, 3, 5])],
    couplingGroups: [],
  });
  // Node 4 is a corner of every loaded outer face: a third of the total.
  expect(out.get(4)?.mag).toBeCloseTo(2, 12);
});

test("a point load on a hidden body draws no glyph", () => {
  // Node 5 is in the plate's facets; with the plate hidden no element on
  // screen holds it, so its point load has nothing to be drawn on.
  const out = nodalLoadVectors({
    loadGroups: [
      group({
        kind: "force",
        components: [0, 0, -40],
        faces: [{ id: 1, label: "Point 1", nodeIds: [5], geometry: "point" }],
      }),
    ],
    nodes: plateNodes,
    elements: [],
    couplingGroups: [],
  });
  expect(out.size).toBe(0);
});

test("a point load on a coupling reference point keeps its glyph", () => {
  // Node 10 is a reference point: it belongs to no element.
  const out = nodalLoadVectors({
    loadGroups: [
      group({
        kind: "force",
        components: [7, 0, 0],
        faces: [{ id: 1, label: "RP", nodeIds: [10], geometry: "point" }],
      }),
    ],
    nodes: [...plateNodes, { id: 10, x: 3, y: 0.5, z: 0 }],
    elements: plate,
    couplingGroups: [
      {
        id: 1,
        name: "Coupling1",
        kind: "distributing",
        dofs: [],
        refNodeId: 10,
        faces: [{ id: 1, label: "Edge 1", nodeIds: [3, 6, 9] }],
        point: [3, 0.5, 0],
      },
    ],
  });
  expect(out.get(10)?.mag).toBeCloseTo(7, 12);
});
