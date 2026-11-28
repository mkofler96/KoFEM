// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// The safety factors Results lists (KOF-496): per body, the von Mises field is
// averaged to the nodes over that body's elements only, so a stiff body's
// stress does not leak into a soft neighbour at their shared nodes, and the
// max and the 99th percentile by volume (the Rust module's nodalPercentiles)
// are taken over that body.

import { beforeAll, describe, expect, test } from "bun:test";
import { loadFem } from "../support/wasm.mjs";
import { safetyFactors } from "../../src/lib/safetyFactor.ts";

beforeAll(async () => {
  await loadFem();
});

const node = (id, x, y, z) => ({ id, x, y, z });
const material = (id, yieldStrength) => ({
  id,
  name: `M${id}`,
  young: 210000,
  poisson: 0.3,
  density: 7.85e-9,
  color: "#4e79a7",
  yieldStrength,
});

// Two tetrahedra on the shared face 1-2-3, on either side of it.
const nodes = [
  node(1, 0, 0, 0),
  node(2, 1, 0, 0),
  node(3, 0, 1, 0),
  node(4, 0, 0, 1),
  node(5, 0, 0, -1),
];
const tet = (id, nodeIds, propertyId) => ({
  id,
  type: "CTETRA",
  nodeIds,
  propertyId,
});

describe("safetyFactors", () => {
  test("averages each body's stress over its own elements", () => {
    const elements = [tet(1, [1, 2, 3, 4], 1), tet(2, [1, 3, 2, 5], 2)];
    const properties = [
      { id: 1, materialId: 1 },
      { id: 2, materialId: 2 },
    ];
    const rows = safetyFactors(
      Float64Array.from([100, 50]),
      nodes,
      elements,
      properties,
      [material(1, 250), material(2, 500)],
    );
    const expected = [
      { propertyId: 1, materialId: 1, yieldStrength: 250, stress: 100 },
      { propertyId: 2, materialId: 2, yieldStrength: 500, stress: 50 },
    ];
    expect(rows).toHaveLength(2);
    rows.forEach((row, i) => {
      const { stress, ...ids } = expected[i];
      expect(row).toMatchObject(ids);
      expect(row.maxVonMises).toBeCloseTo(stress, 9);
      expect(row.p99VonMises).toBeCloseTo(stress, 9);
      expect(row.maxFactor).toBeCloseTo(ids.yieldStrength / stress, 9);
      expect(row.p99Factor).toBeCloseTo(ids.yieldStrength / stress, 9);
    });
  });

  test("one material: one row over the whole model's averaged field", () => {
    const elements = [tet(1, [1, 2, 3, 4], 1), tet(2, [1, 3, 2, 5], 2)];
    const properties = [
      { id: 1, materialId: 1 },
      { id: 2, materialId: 1 },
    ];
    const [row, ...rest] = safetyFactors(
      Float64Array.from([100, 50]),
      nodes,
      elements,
      properties,
      [material(1, 300)],
    );
    expect(rest).toEqual([]);
    expect(row.propertyId).toBeNull();
    // Node 4 sees only the first tetrahedron.
    expect(row.maxVonMises).toBeCloseTo(100, 9);
    expect(row.maxFactor).toBeCloseTo(3, 9);
    expect(row.p99Factor).toBe(300 / row.p99VonMises);
  });

  test("refuses a von Mises field of another mesh", () => {
    const elements = [tet(1, [1, 2, 3, 4], 1)];
    expect(() =>
      safetyFactors(
        Float64Array.from([100, 50]),
        nodes,
        elements,
        [{ id: 1, materialId: 1 }],
        [material(1, 250)],
      ),
    ).toThrow(/2 values for 1 element/);
  });
});
