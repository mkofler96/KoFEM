// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Supports and loads on a CAD mid-surface are picked on the CAD faces
// (KOF-498). A plate's upper and lower faces resolve to the same facets, so
// the same nodes: a selection made on a CAD face is one face by its id, the
// lower face's pressure acts on the facets wound the other way, and an entry
// on the lower face follows its face onto a new mesh.

import { describe, expect, test } from "bun:test";
import { toggleFaceSelection } from "../../src/lib/facePick";
import {
  cadShellFaceKind,
  cadShellPick,
  shellFaceNodes,
  type MidSurfaceLinks,
} from "../../src/lib/cadShell";
import { rebuildSurfaceLoads } from "../../src/store/boundaryRebuild";
import { carryGroupsToMesh } from "../../src/lib/remeshGroups";
import { distributeSurfaceLoad } from "../../src/lib/solveLoads";

// Two facets of a strip: top face 7, bottom face 8; side faces 3 (y = 0) and
// 4 (x = 2).
const elements = [
  { id: 0, type: "CTRIA3" as const, nodeIds: [0, 1, 4], propertyId: 2 },
  { id: 1, type: "CTRIA3" as const, nodeIds: [1, 2, 5], propertyId: 2 },
];
const links: MidSurfaceLinks = {
  // A curved wall: the top face lies 5 % farther from the axis than the
  // mid-surface, the bottom face 5 % nearer.
  areaRatios: [
    { face: 7, ratio: 1.05 },
    { face: 8, ratio: 0.95 },
  ],
  facets: [
    { element: 0, top: 7, bottom: 8 },
    { element: 1, top: 7, bottom: 8 },
  ],
  rim: [
    { nodeIds: [0, 1], sideFace: 3 },
    { nodeIds: [1, 2], sideFace: 3 },
    { nodeIds: [2, 5], sideFace: 4 },
  ],
};

function pressureGroup(cadFaceId: number) {
  return {
    id: 1,
    name: "Pressure",
    kind: "pressure" as const,
    dof: 0,
    totalForce: 2,
    faces: [
      {
        id: 1,
        label: "Face 1",
        nodeIds: [0, 1, 2, 4, 5],
        geometry: "face" as const,
        cadFaceId,
      },
    ],
  };
}

describe("what a CAD face of a shell resolves to", () => {
  test("top and bottom faces are faces, side faces are edges", () => {
    expect(cadShellFaceKind(links, 7)).toBe("face");
    expect(cadShellFaceKind(links, 8)).toBe("face");
    expect(cadShellFaceKind(links, 3)).toBe("edge");
    expect(cadShellFaceKind(links, 99)).toBeNull();
  });

  test("a top or bottom face picks its facets' nodes, a side face its rim", () => {
    expect(cadShellPick(links, elements, 7)).toEqual({
      geometry: "face",
      nodeIds: [0, 1, 2, 4, 5],
    });
    expect(cadShellPick(links, elements, 8)).toEqual({
      geometry: "face",
      nodeIds: [0, 1, 2, 4, 5],
    });
    expect(cadShellPick(links, elements, 4)).toEqual({
      geometry: "edge",
      nodeIds: [2, 5],
    });
  });

  test("the facet nodes of every top and bottom face", () => {
    expect(shellFaceNodes(links, elements)).toEqual(
      new Map([
        [7, [0, 1, 2, 4, 5]],
        [8, [0, 1, 2, 4, 5]],
      ]),
    );
  });
});

describe("a selection on a CAD face is that face", () => {
  test("the lower face joins the upper one instead of toggling it off", () => {
    const nodeIds = [0, 1, 2, 4, 5];
    const upper = toggleFaceSelection(
      [],
      { nodeIds, axis: "Z", isMax: true, label: "", cadFaceId: 7 },
      "Face",
    );
    const both = toggleFaceSelection(
      upper,
      { nodeIds, axis: "Z", isMax: false, label: "", cadFaceId: 8 },
      "Face",
    );
    expect(both.map((f) => f.cadFaceId)).toEqual([7, 8]);
    const again = toggleFaceSelection(
      both,
      { nodeIds, axis: "Z", isMax: true, label: "", cadFaceId: 7 },
      "Face",
    );
    expect(again.map((f) => f.cadFaceId)).toEqual([8]);
  });
});

describe("a pressure on the lower face acts on the facets wound the other way", () => {
  test("upper face: the facets as wound; lower face: reversed", () => {
    const [onTop] = rebuildSurfaceLoads(
      [pressureGroup(7)],
      elements,
      [],
      links,
    );
    const [onBottom] = rebuildSurfaceLoads(
      [pressureGroup(8)],
      elements,
      [],
      links,
    );
    expect(onTop.faces).toEqual([
      [0, 1, 4],
      [1, 2, 5],
    ]);
    expect(onBottom.faces).toEqual([
      [0, 4, 1],
      [1, 5, 2],
    ]);
  });

  test("both faces in one group load both sides", () => {
    const group = pressureGroup(7);
    group.faces.push({ ...group.faces[0], id: 2, cadFaceId: 8 });
    const [load] = rebuildSurfaceLoads([group], elements, [], links);
    expect(load.faces).toHaveLength(4);
  });
});

describe("an entry on the lower face follows it onto a new mesh", () => {
  test("its nodes come from the new mesh's links", () => {
    const carried = carryGroupsToMesh(
      {
        bcGroups: [],
        loadGroups: [pressureGroup(8)],
        tieGroups: [],
        couplingGroups: [],
        contactGroups: [],
      },
      [
        [0, 1, 4],
        [1, 2, 5],
      ],
      [7, 7],
      new Set([0, 1, 2, 4, 5]),
      new Map(),
      shellFaceNodes(links, elements),
    );
    expect(carried.dropped).toEqual([]);
    expect(carried.loadGroups[0].faces[0].nodeIds).toEqual([0, 1, 2, 4, 5]);
  });
});

describe("a load on a curved CAD face carries that face's area", () => {
  test("its facets carry the face's area ratio to the mid-surface", () => {
    const [onTop] = rebuildSurfaceLoads(
      [pressureGroup(7)],
      elements,
      [],
      links,
    );
    const [onBottom] = rebuildSurfaceLoads(
      [pressureGroup(8)],
      elements,
      [],
      links,
    );
    expect(onTop.areaScales).toEqual([1.05, 1.05]);
    expect(onBottom.areaScales).toEqual([0.95, 0.95]);
  });

  test("a flat wall's faces carry their own area, so nothing is added", () => {
    const flat = {
      ...links,
      areaRatios: links.areaRatios.map((r) => ({ ...r, ratio: 1 })),
    };
    const [load] = rebuildSurfaceLoads([pressureGroup(7)], elements, [], flat);
    expect(load.areaScales).toBeUndefined();
  });

  test("a pressure on a facet pushes with the area it stands for", () => {
    const position: Record<number, [number, number, number]> = {
      0: [0, 0, 0],
      1: [1, 0, 0],
      2: [0, 1, 0],
    };
    const total = (areaScales?: number[]) => {
      const forces = new Map<number, { force: number[]; moment: number[] }>();
      distributeSurfaceLoad(
        { type: "pressure", pressure: 2, faces: [[0, 1, 2]], areaScales },
        (id) => position[id],
        (id) => {
          let entry = forces.get(id);
          if (!entry) {
            entry = { force: [0, 0, 0], moment: [0, 0, 0] };
            forces.set(id, entry);
          }
          return entry as {
            force: [number, number, number];
            moment: [number, number, number];
          };
        },
      );
      return [...forces.values()].reduce((sum, f) => sum + f.force[2], 0);
    };
    // Area 0.5, pressure 2, pushing against the +z winding.
    expect(total()).toBeCloseTo(-1, 12);
    expect(total([0.95])).toBeCloseTo(-0.95, 12);
  });
});
