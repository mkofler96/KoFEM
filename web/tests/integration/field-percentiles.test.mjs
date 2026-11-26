// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Volume-weighted percentiles of the plotted nodal field (KOF-477), as the
// Results panel asks for them: the app's nodes and elements packed for the
// Rust module's nodalPercentiles. The numerics are covered in
// crates/kofem-fem/tests/field_statistics.rs; this checks the packing.

import { beforeAll, describe, expect, test } from "bun:test";
import { loadFem } from "../support/wasm.mjs";
import { fieldPercentiles } from "../../src/lib/resultStatistics.ts";

beforeAll(async () => {
  await loadFem();
});

const node = (id, x, y, z) => ({ id, x, y, z });
const steel = { id: 1, materialId: 1 };

// Two equal unit-corner tetrahedra far apart, with node ids that are not
// their array positions: the first at 1, the second at 2.
const nodes = [
  node(10, 0, 0, 0),
  node(11, 1, 0, 0),
  node(12, 0, 1, 0),
  node(13, 0, 0, 1),
  node(20, 5, 0, 0),
  node(21, 6, 0, 0),
  node(22, 5, 1, 0),
  node(23, 5, 0, 1),
];
const values = Float64Array.from([1, 1, 1, 1, 2, 2, 2, 2]);
const tet = (id, nodeIds) => ({ id, type: "CTETRA", nodeIds, propertyId: 1 });

describe("fieldPercentiles", () => {
  test("maps node ids to the values in node order", () => {
    const elements = [tet(1, [10, 11, 12, 13]), tet(2, [20, 21, 22, 23])];
    expect(
      fieldPercentiles(values, nodes, elements, [steel], [0.5, 0.51]),
    ).toEqual([1, 2]);
  });

  test("weighs shell facets by their property's thickness", () => {
    // The shell facet (area 0.5) is thick enough to hold 3/4 of the volume.
    const wall = { id: 2, materialId: 1, thickness: 1 };
    const elements = [
      tet(1, [10, 11, 12, 13]),
      { id: 2, type: "CTRIA3", nodeIds: [20, 21, 22], propertyId: 2 },
    ];
    expect(
      fieldPercentiles(values, nodes, elements, [steel, wall], [0.25, 0.26]),
    ).toEqual([1, 2]);
  });

  test("refuses a shell facet whose property has no thickness", () => {
    const elements = [
      { id: 1, type: "CTRIA3", nodeIds: [20, 21, 22], propertyId: 1 },
    ];
    expect(() =>
      fieldPercentiles(values, nodes, elements, [steel], [0.5]),
    ).toThrow(/thickness/);
  });

  test("refuses an element on a node the mesh does not have", () => {
    const elements = [tet(1, [10, 11, 12, 99])];
    expect(() =>
      fieldPercentiles(values, nodes, elements, [steel], [0.5]),
    ).toThrow(/99/);
  });
});
