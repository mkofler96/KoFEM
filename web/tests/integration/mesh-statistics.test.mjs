// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// What the Mesh step lists per body (KOF-497): the app's nodes, elements,
// bodies and materials packed for the Rust module's meshBodyStatistics. The
// numerics are covered in crates/kofem-fem/tests/mesh_statistics.rs; this
// checks the packing: node ids, which body an element counts for, and which
// density, if any, a body's mass is taken from.

import { beforeAll, describe, expect, test } from "bun:test";
import { loadFem } from "../support/wasm.mjs";
import { meshBodyStatistics } from "../../src/lib/meshStatistics.ts";

beforeAll(async () => {
  await loadFem();
});

const STEEL = { id: 1, name: "Steel", density: 7.85e-9 };
const node = (id, x, y, z) => ({ id, x, y, z });

// A corner tetrahedron of volume 1/6 at the origin (ids 10–13) and a unit
// right triangle far from it (ids 20–22); ids are not array positions.
const nodes = [
  node(10, 0, 0, 0),
  node(11, 1, 0, 0),
  node(12, 0, 1, 0),
  node(13, 0, 0, 1),
  node(20, 5, 0, 0),
  node(21, 6, 0, 0),
  node(22, 5, 1, 0),
];
const tet = (propertyId) => ({
  id: 1,
  type: "CTETRA",
  nodeIds: [10, 11, 12, 13],
  propertyId,
});
const facet = (propertyId) => ({
  id: 2,
  type: "CTRIA3",
  nodeIds: [20, 21, 22],
  propertyId,
});
const tetEdge = (3 + 3 * Math.SQRT2) / 6;

describe("meshBodyStatistics", () => {
  test("gives a body its volume, mean edge and mass from its material", () => {
    const [body] = meshBodyStatistics(
      nodes,
      [tet(1)],
      [{ id: 1, materialId: 1 }],
      [STEEL],
    );
    expect(body.body).toBe(1);
    expect(body.volume).toBeCloseTo(1 / 6, 12);
    expect(body.meanEdgeLength).toBeCloseTo(tetEdge, 12);
    expect(body.mass).toBeCloseTo(7.85e-9 / 6, 20);
  });

  test("counts a shell section for the CAD body it was derived from", () => {
    const properties = [
      { id: 1, materialId: 1, discretization: "shell" },
      { id: 7, materialId: 1, thickness: 2, sourceBodyId: 1 },
    ];
    const [body, ...rest] = meshBodyStatistics(
      nodes,
      [tet(1), facet(7)],
      properties,
      [STEEL],
    );
    expect(rest).toEqual([]);
    expect(body.body).toBe(1);
    expect(body.volume).toBeCloseTo(1 / 6 + 1, 12);
  });

  test("leaves the mass out without a density to take it from", () => {
    const properties = [
      { id: 1, materialId: 2 },
      { id: 2, materialId: 1, materialUnconfirmed: true },
      { id: 3, materialId: 9 },
    ];
    const elements = [tet(1), { ...tet(2), id: 3 }, { ...tet(3), id: 4 }];
    const stats = meshBodyStatistics(nodes, elements, properties, [
      STEEL,
      { id: 2, name: "Unknown", density: 0 },
    ]);
    // Density zero; nobody chose the material; the material is gone.
    expect(stats.map((s) => s.mass)).toEqual([null, null, null]);
    expect(stats.map((s) => s.volume > 0)).toEqual([true, true, true]);
  });

  test("refuses an element on a node the mesh does not have", () => {
    const broken = { ...tet(1), nodeIds: [10, 11, 12, 99] };
    expect(() =>
      meshBodyStatistics(nodes, [broken], [{ id: 1, materialId: 1 }], [STEEL]),
    ).toThrow(/99/);
  });

  test("refuses a shell facet whose section has no thickness", () => {
    expect(() =>
      meshBodyStatistics(
        nodes,
        [facet(1)],
        [{ id: 1, materialId: 1 }],
        [STEEL],
      ),
    ).toThrow(/thickness/);
  });
});
