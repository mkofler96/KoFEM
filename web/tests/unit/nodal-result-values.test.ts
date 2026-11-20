// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// The plotted field per node, shared by the result surface's colours, the
// legend's range and the section cut (KOF-390), so the three cannot disagree.

import { describe, expect, test } from "bun:test";
import {
  computeResultRange,
  nodalResultValues,
} from "../../src/lib/resultField";
import type { Element, Node } from "../../src/store/modelStore";

const nodes: Node[] = [
  { id: 10, x: 0, y: 0, z: 0 },
  { id: 11, x: 1, y: 0, z: 0 },
  { id: 12, x: 0, y: 1, z: 0 },
  { id: 13, x: 0, y: 0, z: 1 },
];
const elements: Element[] = [
  { id: 1, type: "CTETRA", nodeIds: [10, 11, 12, 13], propertyId: 1 },
];
const result = {
  displacements: Float64Array.from([0, 0, 0, 3, 4, 0, 0, -2, 0, 0, 0, 1]),
  vonMises: Float64Array.from([42]),
};

describe("nodalResultValues", () => {
  test("gives each displacement component and the magnitude per node", () => {
    expect([...nodalResultValues(result, "Ux", nodes, elements)!]).toEqual([
      0, 3, 0, 0,
    ]);
    expect([...nodalResultValues(result, "Uy", nodes, elements)!]).toEqual([
      0, 4, -2, 0,
    ]);
    expect([
      ...nodalResultValues(
        result,
        "Displacement (magnitude)",
        nodes,
        elements,
      )!,
    ]).toEqual([0, 5, 2, 1]);
  });

  test("averages von Mises to the nodes, as the legend does", () => {
    const values = nodalResultValues(
      result,
      "Von Mises stress",
      nodes,
      elements,
    )!;
    expect([...values]).toEqual([42, 42, 42, 42]);
    expect(
      computeResultRange(result, "Von Mises stress", nodes, elements),
    ).toEqual({ min: 42, max: 42 });
  });

  test("is null for von Mises when the result carries none", () => {
    expect(
      nodalResultValues(
        { displacements: result.displacements },
        "Von Mises stress",
        nodes,
        elements,
      ),
    ).toBeNull();
  });

  test("refuses a result that belongs to another mesh", () => {
    expect(() =>
      nodalResultValues(
        { displacements: new Float64Array(6) },
        "Ux",
        nodes,
        elements,
      ),
    ).toThrow("stale");
  });
});
