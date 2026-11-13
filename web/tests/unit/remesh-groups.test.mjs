// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Unit test for carrying supports, loads and ties over to a new mesh
// (src/lib/remeshGroups.ts): an entry picked as a whole CAD face is re-resolved
// to the new mesh's nodes of that face; edge/node/flood-fill picks, faces the
// new mesh has no surface for, and couplings are dropped and named.

import { describe, expect, test } from "bun:test";
import { carryGroupsToMesh, remeshNotice } from "../../src/lib/remeshGroups.ts";

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
const named = carried.dropped.join(" | ");
const notice = remeshNotice(carried);

describe("carrying groups to a new mesh", () => {
  test("a whole-CAD-face BC is re-resolved to the new mesh's nodes of that face", () => {
    expect(carried.bcGroups[0].faces[0].nodeIds).toEqual([10, 11, 12, 13]);
  });

  test("the carried entry keeps its id, label, geometry and CAD face", () => {
    const entry = carried.bcGroups[0].faces[0];
    expect(entry.id).toBe(1);
    expect(entry.label).toBe("Face 1");
    expect(entry.cadFaceId).toBe(1);
    expect(entry.geometry).toBe("face");
  });

  test("a group keeps its face entries and loses its edge pick", () => {
    expect(carried.bcGroups[1].name).toBe("Mixed");
    expect(carried.bcGroups[1].faces).toHaveLength(1);
    expect(carried.bcGroups[1].faces[0].nodeIds).toEqual([20, 21, 22]);
  });

  test("a group of node picks only is dropped", () => {
    expect(carried.bcGroups).toHaveLength(2);
    expect(carried.bcGroups.some((group) => group.name === "Nodes only")).toBe(
      false,
    );
  });

  test("face nodes the new mesh does not have are left out", () => {
    expect(carried.loadGroups[0].faces[0].nodeIds).toEqual([30, 31]);
  });

  test("a load on a CAD face missing from the new surface is dropped", () => {
    expect(carried.loadGroups).toHaveLength(1);
    expect(carried.loadGroups[0].name).toBe("Load");
  });

  test("the load's value survives untouched", () => {
    expect(carried.loadGroups[0].totalForce).toBe(-1000);
  });

  test("a tie with both sides on CAD faces is carried", () => {
    expect(carried.tieGroups).toHaveLength(1);
    expect(carried.tieGroups[0].name).toBe("Tie1");
    expect(carried.tieGroups[0].facesB[0].nodeIds).toEqual([20, 21, 22]);
  });

  test("entries carried are counted (Pin, Mixed face, Load, Tie1 A+B, Tie2 A)", () => {
    expect(carried.kept).toBe(6);
  });
});

describe("what is dropped is named", () => {
  test("the edge pick is named", () => {
    expect(named).toContain("Mixed Edge 1 (an edge pick)");
  });

  test("the node pick and its emptied group are named", () => {
    expect(named).toContain("Nodes only Node 1 (a node pick)");
    expect(named).toContain("Nodes only — nothing left to apply it to");
  });

  test("the face missing from the new mesh is named", () => {
    expect(named).toContain("CAD face 99 is not on the new mesh's surface");
  });

  test("a flood-fill pick is named", () => {
    expect(named).toContain("Tie2 side B Face 1 (not a whole CAD face)");
  });

  test("the tie that lost a side is named", () => {
    expect(named).toContain("Tie2 — a side has nothing left to tie");
  });

  test("couplings are dropped and named", () => {
    expect(named).toContain(
      "Coupling1 (its reference point was a node of the old mesh)",
    );
  });
});

describe("the remesh notice", () => {
  test("the notice says what was kept and what to pick again", () => {
    expect(notice).toStartWith(
      "Kept 4 support/load/tie groups on their CAD faces.",
    );
    expect(notice).toContain("Cleared — pick again:");
  });

  test("a first mesh (no groups) has no notice", () => {
    const nothing = carryGroupsToMesh(
      { bcGroups: [], loadGroups: [], tieGroups: [], couplingGroups: [] },
      surfaceTriangles,
      surfaceFaceIds,
      nodeIds,
    );
    expect(remeshNotice(nothing)).toBeNull();
  });
});

describe("a new mesh without CAD face ids", () => {
  test("without CAD face ids on the new mesh nothing is carried", () => {
    const noSurface = carryGroupsToMesh(groups, null, null, nodeIds);
    expect(noSurface.kept).toBe(0);
    expect(noSurface.bcGroups).toHaveLength(0);
    expect(noSurface.loadGroups).toHaveLength(0);
  });
});

// A shell rim: an Edge entry picked on the rim a shell collapsed CAD face 4 to
// follows that face's rim on the new mesh. An Edge entry is resolved from the
// rim only — CAD face 2 is on the new mesh's surface but has no rim, so the
// entry naming it is dropped and named.
const rimGroups = {
  bcGroups: [
    {
      id: 1,
      name: "Rim",
      dofs: [0],
      value: 0,
      faces: [face(1, "Edge 1", 4, [0, 1], "edge")],
    },
  ],
  loadGroups: [
    {
      id: 1,
      name: "Pull",
      dof: 0,
      totalForce: 1,
      components: [1, 0, 0],
      kind: "force",
      faces: [face(2, "Edge 1", 2, [2, 3], "edge")],
    },
  ],
  tieGroups: [],
  couplingGroups: [],
};
describe("a shell rim", () => {
  const rim = carryGroupsToMesh(
    rimGroups,
    surfaceTriangles,
    surfaceFaceIds,
    nodeIds,
    new Map([[4, [10, 11]]]),
  );

  test("an Edge entry on a collapsed CAD face follows the face's rim", () => {
    expect(rim.bcGroups).toHaveLength(1);
    expect(rim.bcGroups[0].faces[0]).toEqual(
      face(1, "Edge 1", 4, [10, 11], "edge"),
    );
  });

  test("an Edge entry is resolved from the rim, never from a surface face", () => {
    expect(rim.loadGroups).toHaveLength(0);
    expect(rim.dropped).toContain(
      "Pull Edge 1 (CAD face 2 is not on the new mesh's shell rim)",
    );
  });
});
