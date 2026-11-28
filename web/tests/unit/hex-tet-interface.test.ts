// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// A hex face that meets two tet triangles is inside the body (KOF-433): the
// solve joins the two sides through a transition element, so neither the
// quad nor its triangles can take a load. A pick on that face spans no
// loadable face, and the solve refuses the load by name.

import { expect, test } from "bun:test";
import type { Element } from "../../src/workers/solverTypes";
import {
  faceKey,
  loadableFaceKeys,
  rebuildSurfaceLoads,
} from "../../src/store/boundaryRebuild";
import type { NamedLoadGroup } from "../../src/store/boundaryGroups";

// A unit hex, node ids 1–8 in CHEXA order, and a roof of two tets on its top
// face 5–6–7–8, split along 5–7, meeting at node 9 above it.
const hex: Element = {
  id: 1,
  type: "CHEXA",
  nodeIds: [1, 2, 3, 4, 5, 6, 7, 8],
  propertyId: 1,
};
const roof: Element[] = [
  { id: 2, type: "CTETRA", nodeIds: [5, 6, 7, 9], propertyId: 1 },
  { id: 3, type: "CTETRA", nodeIds: [5, 7, 8, 9], propertyId: 1 },
];
const elements = [hex, ...roof];

test("a hex face against two tet triangles is not loadable, nor are the triangles", () => {
  const loadable = loadableFaceKeys(elements);
  expect(loadable.has(faceKey([5, 6, 7, 8]))).toBe(false);
  expect(loadable.has(faceKey([5, 6, 7]))).toBe(false);
  expect(loadable.has(faceKey([5, 7, 8]))).toBe(false);
  // The rest of the surface: five hex faces and the roof's four slopes.
  expect(loadable.size).toBe(9);
  expect(loadable.has(faceKey([1, 2, 3, 4]))).toBe(true);
  expect(loadable.has(faceKey([5, 6, 9]))).toBe(true);
});

test("a load picked on the hex/tet interface spans no face and is kept for the solve to refuse", () => {
  const group: NamedLoadGroup = {
    id: 1,
    name: "Interface",
    dof: 2,
    totalForce: -100,
    components: [0, 0, -100],
    kind: "force",
    faces: [{ id: 1, label: "Face 1", nodeIds: [5, 6, 7, 8] }],
  };
  const [load] = rebuildSurfaceLoads([group], elements);
  expect(load.faces).toEqual([]);
  expect(load.unmatchedSelections).toBe(1);
});
