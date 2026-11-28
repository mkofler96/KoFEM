// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// The safety factor against yield (KOF-496): the yield strength over the von
// Mises stress, and which elements each factor is taken over. A model of one
// material gets one factor over the whole model; a model of several gets one
// per body whose material has a yield strength. Without a yield strength
// there is no factor, never one against a default.

import { describe, expect, test } from "bun:test";
import {
  safetyFactor,
  safetyGroups,
  withCurrentYield,
} from "../../src/lib/safetyFactor";
import type { Element, Material, Property } from "../../src/store/modelStore";

const material = (id: number, yieldStrength?: number): Material => ({
  id,
  name: `M${id}`,
  young: 210000,
  poisson: 0.3,
  density: 7.85e-9,
  color: "#4e79a7",
  yieldStrength,
});
const tet = (id: number, propertyId: number): Element => ({
  id,
  type: "CTETRA",
  nodeIds: [1, 2, 3, 4],
  propertyId,
});

describe("safetyFactor", () => {
  test("is the yield strength over the stress", () => {
    expect(safetyFactor(250, 100)).toBe(2.5);
  });

  test("is infinite where nothing is stressed", () => {
    expect(safetyFactor(250, 0)).toBe(Number.POSITIVE_INFINITY);
  });

  test("refuses a yield strength that is not positive", () => {
    expect(() => safetyFactor(0, 100)).toThrow(/yield strength/);
    expect(() => safetyFactor(Number.NaN, 100)).toThrow(/yield strength/);
  });

  test("refuses a negative or non-finite stress", () => {
    expect(() => safetyFactor(250, -1)).toThrow(/stress/);
    expect(() => safetyFactor(250, Number.NaN)).toThrow(/stress/);
  });
});

describe("safetyGroups", () => {
  test("one material: one group over every element of the model", () => {
    const properties: Property[] = [
      { id: 1, materialId: 1 },
      { id: 2, materialId: 1 },
    ];
    const elements = [tet(1, 1), tet(2, 2), tet(3, 1)];
    expect(safetyGroups(elements, properties, [material(1, 250)])).toEqual([
      {
        propertyId: null,
        materialId: 1,
        yieldStrength: 250,
        elements: [0, 1, 2],
      },
    ]);
  });

  test("several materials: one group per body with a yield strength", () => {
    const properties: Property[] = [
      { id: 1, materialId: 1 },
      { id: 2, materialId: 2 },
      { id: 3, materialId: 1 },
    ];
    const elements = [tet(1, 3), tet(2, 2), tet(3, 1), tet(4, 3)];
    expect(
      safetyGroups(elements, properties, [material(1, 250), material(2)]),
    ).toEqual([
      { propertyId: 1, materialId: 1, yieldStrength: 250, elements: [2] },
      { propertyId: 3, materialId: 1, yieldStrength: 250, elements: [0, 3] },
    ]);
  });

  test("no yield strength set: no group", () => {
    const properties: Property[] = [{ id: 1, materialId: 1 }];
    expect(safetyGroups([tet(1, 1)], properties, [material(1)])).toEqual([]);
  });

  test("refuses an element whose body or material the model lacks", () => {
    expect(() =>
      safetyGroups([tet(1, 9)], [{ id: 1, materialId: 1 }], [material(1)]),
    ).toThrow(/property 9/);
    expect(() =>
      safetyGroups([tet(1, 1)], [{ id: 1, materialId: 7 }], [material(1)]),
    ).toThrow(/material 7/);
  });
});

describe("withCurrentYield", () => {
  test("keeps the solved materials, with the yield strength as it is now", () => {
    const solved = [material(1), { ...material(2, 100), name: "Old" }];
    const current = [material(1, 250), { ...material(2), name: "New" }];
    expect(withCurrentYield(solved, current)).toEqual([
      material(1, 250),
      { ...material(2), name: "Old" },
    ]);
  });

  test("refuses a solved material the model no longer has", () => {
    expect(() => withCurrentYield([material(3)], [material(1)])).toThrow(
      /material 3/,
    );
  });
});
