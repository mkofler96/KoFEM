// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// An element of a shelled body takes the von Mises stress of the mid-surface
// node nearest its centroid. A node no shell facet uses has no stress to give,
// and a zero would read as a real, unloaded result (KOF-463).

import { describe, expect, test } from "bun:test";
import {
  maxFacetStressPerNode,
  shellStressAtCentroid,
} from "../../src/lib/solve/shellMapping";
import type { Element, Node } from "../../src/workers/solverTypes";

const nodes: Node[] = [
  { id: 1, x: 0, y: 0, z: 0 },
  { id: 2, x: 1, y: 0, z: 0 },
  { id: 3, x: 0, y: 1, z: 0 },
  { id: 4, x: 0, y: 0, z: 1 },
];
const nodeById = new Map(nodes.map((n) => [n.id, n]));
const tet: Element = {
  id: 7,
  type: "CTETRA",
  nodeIds: [1, 2, 3, 4],
  propertyId: 1,
};

// Mid-surface nodes 0, 1, 2 form one facet with 42 MPa; node 3 is in none.
const vmByShellNode = maxFacetStressPerNode([0, 1, 2], [42]);

describe("shellStressAtCentroid", () => {
  test("takes the stress of the nearest node's facets", () => {
    expect(
      shellStressAtCentroid(tet, nodeById, () => 1, vmByShellNode, "test"),
    ).toBe(42);
  });

  test("refuses a nearest node that no shell facet uses", () => {
    expect(() =>
      shellStressAtCentroid(tet, nodeById, () => 3, vmByShellNode, "test"),
    ).toThrow(
      "test: element 7 lies nearest mid-surface node 3, which no shell facet uses",
    );
  });
});
