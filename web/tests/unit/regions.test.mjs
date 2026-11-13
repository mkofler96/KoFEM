// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Bodies and their regions (src/lib/regions.ts, KOF-257): body grouping and
// names, region element sizes, the optimizer's passive elements, and the
// mesh-type label.

import { describe, expect, test } from "bun:test";
import {
  bodyGroups,
  nextBodyNumber,
  passiveElements,
  regionMaxSizes,
  sameBody,
  solidName,
  solidsWithOwnSize,
} from "../../src/lib/regions.ts";
import { meshKind, meshSizesChanged } from "../../src/store/geometrySlice.ts";

// Body 1 split into solids 1 and 2; solid 3 is Body 2; solid 4 is a shell
// section the mesh derived from solid 2.
const props = [
  { id: 1, materialId: 1, body: 1 },
  { id: 2, materialId: 1, body: 1, optimizationRole: "solid" },
  { id: 3, materialId: 1, body: 2, optimizationRole: "void" },
  { id: 4, materialId: 1, sourceBodyId: 2, thickness: 2 },
];

describe("bodies and regions", () => {
  test("solids group into bodies; a derived shell section is not a region", () => {
    expect(
      bodyGroups(props).map((g) => [g.body, g.regions.map((r) => r.id)]),
    ).toEqual([
      [1, [1, 2]],
      [2, [3]],
    ]);
  });

  test("a solid without a body number is a body of its own", () => {
    expect(
      bodyGroups([
        { id: 1, materialId: 1 },
        { id: 2, materialId: 1 },
      ]).map((g) => g.body),
    ).toEqual([1, 2]);
  });

  test("names: a region of a split body, a one-region body", () => {
    expect(solidName(props, 2)).toBe("Body 1 · Region 2");
    expect(solidName(props, 3)).toBe("Body 2");
  });

  test("same body", () => {
    expect(sameBody(props, 1, 2)).toBe(true);
    expect(sameBody(props, 2, 3)).toBe(false);
  });

  test("next body number", () => {
    expect(nextBodyNumber(props)).toBe(3);
  });

  test("naming a solid that is not in the model throws", () => {
    expect(() => solidName(props, 9)).toThrow(/Region 9 is not a CAD solid/);
  });
});

describe("region element sizes", () => {
  test("region sizes: only the regions that set one", () => {
    expect([
      ...regionMaxSizes([
        { id: 1, materialId: 1, maxElementSize: "2.5" },
        { id: 2, materialId: 1, maxElementSize: " " },
        { id: 3, materialId: 1 },
      ]),
    ]).toEqual([[1, 2.5]]);
  });

  test("own sizes: the CAD solids that set one, not blanks or shell sections", () => {
    expect(
      solidsWithOwnSize([
        { id: 3, materialId: 1, maxElementSize: "4" },
        { id: 1, materialId: 1, maxElementSize: "2.5" },
        { id: 2, materialId: 1, maxElementSize: " " },
        { id: 4, materialId: 1, sourceBodyId: 1, maxElementSize: "1" },
      ]).map((p) => p.id),
    ).toEqual([1, 3]);
  });

  test("a region size that is not a positive number is refused, naming the region", () => {
    expect(() =>
      regionMaxSizes([
        { id: 1, materialId: 1, body: 1 },
        { id: 2, materialId: 1, body: 1, maxElementSize: "-1" },
      ]),
    ).toThrow(/Body 1 · Region 2 must be a positive number of mm — got "-1"/);
  });
});

describe("passive elements for the optimizer", () => {
  // Elements in store order: a hex of solid 1, tets of solids 1/2/3, and a
  // facet of the shell section of solid 2. Design order: tets, hexes, facets.
  const elements = [
    { id: 1, type: "CHEXA", nodeIds: [], propertyId: 1 },
    { id: 2, type: "CTETRA", nodeIds: [], propertyId: 1 },
    { id: 3, type: "CTETRA", nodeIds: [], propertyId: 2 },
    { id: 4, type: "CTETRA", nodeIds: [], propertyId: 3 },
    { id: 5, type: "CTRIA3", nodeIds: [], propertyId: 4 },
  ];

  test("passive elements in design order; a shell section takes its region's role", () => {
    expect(passiveElements(elements, props)).toEqual({
      solid: [1, 4],
      void: [2],
    });
  });

  test("every region a design region: nothing passive", () => {
    expect(
      passiveElements(elements, [
        { id: 1, materialId: 1 },
        { id: 2, materialId: 1 },
        { id: 3, materialId: 1 },
        { id: 4, materialId: 1, sourceBodyId: 2 },
      ]),
    ).toBeUndefined();
  });

  test("an element of an unknown property is refused", () => {
    expect(() =>
      passiveElements(
        [{ id: 1, type: "CTETRA", nodeIds: [], propertyId: 7 }],
        props,
      ),
    ).toThrow(/property 7 is not in the model's property table/);
  });
});

describe("mesh kind and mesh sizes", () => {
  test("mesh kind from its elements", () => {
    expect(meshKind([{ type: "CTETRA" }])).toBe("volume");
    expect(meshKind([{ type: "CTRIA3" }])).toBe("shell");
    expect(meshKind([{ type: "CTETRA" }, { type: "CTRIA3" }])).toBe("mixed");
  });

  const meshed = { max: 5, min: 0.5, regions: { 2: 1 } };
  const withSize = (size) =>
    props.map((p) => (p.id === 2 ? { ...p, maxElementSize: size } : p));

  test("mesh sizes: unchanged settings match the mesh", () => {
    expect(meshSizesChanged(meshed, "5", "0.5", withSize("1"))).toBe(false);
  });

  test("mesh sizes: a changed region size, or a region size cleared, is a change", () => {
    expect(meshSizesChanged(meshed, "5", "0.5", withSize("2"))).toBe(true);
    expect(meshSizesChanged(meshed, "5", "0.5", withSize(""))).toBe(true);
  });
});
