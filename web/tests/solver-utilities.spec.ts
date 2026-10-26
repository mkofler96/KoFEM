// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { test, expect } from "@playwright/test";
import { SpatialGrid, type Point3 } from "../src/lib/spatialGrid";
import {
  coupledMaterials,
  mixedCoupledMaterials,
} from "../src/lib/coupledMaterials";
import type { Element, Material, Property } from "../src/workers/solverTypes";

test("grid queries retain every point within a radius across negative coordinates and multiple rings", () => {
  const points: Point3[] = [];
  for (let x = -4; x <= 4; x++)
    for (let y = -4; y <= 4; y++)
      for (let z = -4; z <= 4; z++) points.push([x + 0.1, y - 0.1, z]);
  points.push(points[0]);
  for (const cellSize of [0.5, 1, 2.5]) {
    const grid = new SpatialGrid(points, (point) => point, cellSize);
    for (const query of [
      [0, 0, 0],
      [-1.01, 0.99, -0.01],
      [4, -4, 2],
    ] as Point3[]) {
      for (const radius of [0.1, 0.5, 1, 1.5]) {
        const inRadius = (point: Point3) =>
          Math.hypot(
            point[0] - query[0],
            point[1] - query[1],
            point[2] - query[2],
          ) <= radius;
        const key = (point: Point3) => point.join(",");
        const expected = points.filter(inRadius).map(key).sort();
        const actual = [...grid.candidates(query, Math.ceil(radius / cellSize))]
          .filter(inRadius)
          .map(key)
          .sort();
        expect(actual).toEqual(expected);
      }
    }
  }
});

test("grid traversal preserves xyz bucket and insertion order", () => {
  const points: Point3[] = [
    [1, 0, 0],
    [-1, 0, 0],
    [0, 1, 0],
    [-0.5, 0, 0],
    [0, 0, 0],
  ];
  const grid = new SpatialGrid(points, (point) => point, 1);
  expect([...grid.candidates([0, 0, 0], 1)]).toEqual([
    points[1],
    points[3],
    points[4],
    points[2],
    points[0],
  ]);
  expect([...grid.candidates([0, 0, 0], 1, 1)]).toEqual([
    points[1],
    points[3],
    points[2],
    points[0],
  ]);
  expect([
    ...new SpatialGrid([], () => [0, 0, 0], 1).candidates([0, 0, 0], 2),
  ]).toEqual([]);
  for (const cellSize of [0, -1, Infinity, NaN])
    expect(() => new SpatialGrid([], () => [0, 0, 0], cellSize)).toThrow(
      /positive and finite/,
    );
});

const materials: Material[] = [
  { id: 7, name: "Steel", young: 210000, poisson: 0.3, density: 7850 },
  { id: 9, name: "Aluminium", young: 70000, poisson: 0.33, density: 2700 },
];
const properties: Property[] = [
  { id: 10, materialId: 7 },
  { id: 20, materialId: 9 },
  { id: 30, materialId: 7 },
];
const element = (id: number, propertyId: number): Element => ({
  id,
  propertyId,
  type: "CTETRA",
  nodeIds: [],
});

test("legacy domains deduplicate by material id and reject ambiguous materials", () => {
  expect(coupledMaterials(materials, properties, 20, [10, 30, 10])).toEqual({
    solid: { young_modulus: 210000, poisson_ratio: 0.3 },
    shell: { young_modulus: 70000, poisson_ratio: 0.33 },
  });
  expect(() => coupledMaterials(materials, properties, 20, [10, 20])).toThrow(
    /solid domain spans 2 distinct materials \(Steel, Aluminium\)/,
  );
  expect(() => coupledMaterials(materials, properties, 20, [])).toThrow(
    /no solid material/,
  );
});

test("mixed domains preserve per-tet material ordering and the pure-solid coupling path", () => {
  const solids = [
    element(1, 20),
    element(2, 10),
    element(3, 30),
    element(4, 20),
  ];
  const mixed = mixedCoupledMaterials(
    materials,
    properties,
    [element(5, 10), element(6, 30)],
    solids,
  );
  expect(mixed.solidAttributes).toEqual([1, 2, 2, 1]);
  expect(mixed.solidMaterialNames).toEqual(["Aluminium", "Steel"]);
  expect(mixed.mat).toEqual({
    solid: [
      { young_modulus: 70000, poisson_ratio: 0.33 },
      { young_modulus: 210000, poisson_ratio: 0.3 },
    ],
    shell: { young_modulus: 210000, poisson_ratio: 0.3 },
  });
  expect(
    mixedCoupledMaterials(materials, properties, [], solids).mat.shell,
  ).toEqual(mixed.mat.solid[0]);
  expect(() =>
    mixedCoupledMaterials(
      materials,
      properties,
      [element(5, 10), element(6, 20)],
      solids,
    ),
  ).toThrow(/shell domain spans 2 distinct materials \(Steel, Aluminium\)/);
  expect(() => mixedCoupledMaterials(materials, properties, [], [])).toThrow(
    /no solid element/,
  );
});

test("both material paths name missing properties and material references", () => {
  expect(() => coupledMaterials(materials, properties, 99, [10])).toThrow(
    /coupled shell: body 99 has no property/,
  );
  expect(() => coupledMaterials(materials, properties, 10, [99])).toThrow(
    /coupled solid: body 99 has no property/,
  );
  expect(() =>
    mixedCoupledMaterials(
      materials,
      properties,
      [element(15, 99)],
      [element(2, 10)],
    ),
  ).toThrow(/shell element 15: body 99 has no property/);
  expect(() =>
    mixedCoupledMaterials(materials, properties, [], [element(12, 99)]),
  ).toThrow(/solid element 12: body 99 has no property/);
  const broken = [{ id: 10, materialId: 999 }];
  expect(() => coupledMaterials(materials, broken, 10, [10])).toThrow(
    /property 10 references material 999, which does not exist/,
  );
  expect(() =>
    mixedCoupledMaterials(materials, broken, [], [element(1, 10)]),
  ).toThrow(/property 10 references material 999, which does not exist/);
});
