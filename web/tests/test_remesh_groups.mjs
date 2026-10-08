#!/usr/bin/env bun
// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Unit test for carrying supports, loads and ties over to a new mesh
// (src/lib/remeshGroups.ts): an entry picked as a whole CAD face is re-resolved
// to the new mesh's nodes of that face; edge/node/flood-fill picks, faces the
// new mesh has no surface for, and couplings are dropped and named.
//
// Run: bun tests/test_remesh_groups.mjs   (from the web/ directory)

import { carryGroupsToMesh, remeshNotice } from "../src/lib/remeshGroups.ts";

let failed = 0;
function check(label, ok, detail = "") {
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`,
  );
  if (!ok) failed++;
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// New mesh: CAD face 1 = nodes 10..13 (two triangles), face 2 = nodes 20..22,
// face 3 = node 30..32 but node 32 is not a node of the new mesh.
const surfaceTriangles = [
  [10, 11, 12],
  [10, 12, 13],
  [20, 21, 22],
  [30, 31, 32],
];
const surfaceFaceIds = [1, 1, 2, 3];
const nodeIds = new Set([10, 11, 12, 13, 20, 21, 22, 30, 31]);

const face = (
  id,
  label,
  cadFaceId,
  nodeIds = [0, 1, 2],
  geometry = "face",
) => ({
  id,
  label,
  nodeIds,
  geometry,
  ...(cadFaceId !== undefined ? { cadFaceId } : {}),
});

const groups = {
  bcGroups: [
    {
      id: 1,
      name: "Pin",
      dofs: [0, 1, 2],
      value: 0,
      faces: [face(1, "Face 1", 1)],
    },
    {
      id: 2,
      name: "Mixed",
      dofs: [1],
      value: 0,
      faces: [
        face(2, "Face 1", 2),
        face(3, "Edge 1", undefined, [5, 6], "edge"),
      ],
    },
    {
      id: 3,
      name: "Nodes only",
      dofs: [0],
      value: 0,
      faces: [face(4, "Node 1", undefined, [7], "point")],
    },
  ],
  loadGroups: [
    {
      id: 1,
      name: "Load",
      dof: 1,
      totalForce: -1000,
      kind: "force",
      faces: [face(5, "Face 1", 3)],
    },
    {
      id: 2,
      name: "Gone",
      dof: 1,
      totalForce: -1,
      kind: "force",
      faces: [face(6, "Face 1", 99)],
    },
  ],
  tieGroups: [
    {
      id: 1,
      name: "Tie1",
      facesA: [face(7, "Face 1", 1)],
      facesB: [face(8, "Face 1", 2)],
      extent: "full",
      searchDistance: 0,
    },
    {
      id: 2,
      name: "Tie2",
      facesA: [face(9, "Face 1", 1)],
      facesB: [face(10, "Face 1")],
      extent: "full",
      searchDistance: 0,
    },
  ],
  couplingGroups: [
    { id: 1, name: "Coupling1", faces: [], point: [0, 0, 0], refNodeId: 500 },
  ],
};

const carried = carryGroupsToMesh(
  groups,
  surfaceTriangles,
  surfaceFaceIds,
  nodeIds,
);

check(
  "a whole-CAD-face BC is re-resolved to the new mesh's nodes of that face",
  same(carried.bcGroups[0].faces[0].nodeIds, [10, 11, 12, 13]),
  JSON.stringify(carried.bcGroups[0].faces[0].nodeIds),
);
check(
  "the carried entry keeps its id, label, geometry and CAD face",
  carried.bcGroups[0].faces[0].id === 1 &&
    carried.bcGroups[0].faces[0].label === "Face 1" &&
    carried.bcGroups[0].faces[0].cadFaceId === 1 &&
    carried.bcGroups[0].faces[0].geometry === "face",
);
check(
  "a group keeps its face entries and loses its edge pick",
  carried.bcGroups[1].name === "Mixed" &&
    carried.bcGroups[1].faces.length === 1 &&
    same(carried.bcGroups[1].faces[0].nodeIds, [20, 21, 22]),
);
check(
  "a group of node picks only is dropped",
  carried.bcGroups.length === 2 &&
    !carried.bcGroups.some((g) => g.name === "Nodes only"),
);
check(
  "face nodes the new mesh does not have are left out",
  same(carried.loadGroups[0].faces[0].nodeIds, [30, 31]),
  JSON.stringify(carried.loadGroups[0].faces[0].nodeIds),
);
check(
  "a load on a CAD face missing from the new surface is dropped",
  carried.loadGroups.length === 1 && carried.loadGroups[0].name === "Load",
);
check(
  "the load's value survives untouched",
  carried.loadGroups[0].totalForce === -1000,
);
check(
  "a tie with both sides on CAD faces is carried",
  carried.tieGroups.length === 1 &&
    carried.tieGroups[0].name === "Tie1" &&
    same(carried.tieGroups[0].facesB[0].nodeIds, [20, 21, 22]),
);
check(
  "entries carried are counted (Pin, Mixed face, Load, Tie1 A+B, Tie2 A)",
  carried.kept === 6,
  String(carried.kept),
);

const named = carried.dropped.join(" | ");
check(
  "the edge pick is named",
  named.includes("Mixed Edge 1 (an edge pick)"),
  named,
);
check(
  "the node pick and its emptied group are named",
  named.includes("Nodes only Node 1 (a node pick)") &&
    named.includes("Nodes only — nothing left to apply it to"),
);
check(
  "the face missing from the new mesh is named",
  named.includes("CAD face 99 is not on the new mesh's surface"),
);
check(
  "a flood-fill pick is named",
  named.includes("Tie2 side B Face 1 (not a whole CAD face)"),
);
check(
  "the tie that lost a side is named",
  named.includes("Tie2 — a side has nothing left to tie"),
);
check(
  "couplings are dropped and named",
  named.includes("Coupling1 (its reference point was a node of the old mesh)"),
);

const notice = remeshNotice(carried);
check(
  "the notice says what was kept and what to pick again",
  notice.startsWith("Kept 4 support/load/tie groups on their CAD faces.") &&
    notice.includes("Cleared — pick again:"),
  notice,
);

const nothing = carryGroupsToMesh(
  { bcGroups: [], loadGroups: [], tieGroups: [], couplingGroups: [] },
  surfaceTriangles,
  surfaceFaceIds,
  nodeIds,
);
check("a first mesh (no groups) has no notice", remeshNotice(nothing) === null);

const noSurface = carryGroupsToMesh(groups, null, null, nodeIds);
check(
  "without CAD face ids on the new mesh nothing is carried",
  noSurface.kept === 0 &&
    noSurface.bcGroups.length === 0 &&
    noSurface.loadGroups.length === 0,
);

if (failed > 0) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nAll remesh-group checks passed");
