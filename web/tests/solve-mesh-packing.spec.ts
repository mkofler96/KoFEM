// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { test, expect } from "@playwright/test";
import {
  buildVertexIndexer,
  packSolveMesh,
  groupDirichlet,
  groupPointLoads,
  resolveMaterials,
} from "../src/lib/solveMeshPacking";

const nodes = [41, 7, 99, 12, 101, 102, 103, 104].map((id, index) => ({
  id,
  x: index,
  y: index + 1,
  z: -index,
}));
const vid = buildVertexIndexer(nodes);

test("solid packing remaps arbitrary ids in tet/hex connectivity and BCs", () => {
  const tet = {
    id: 3,
    type: "CTETRA",
    propertyId: 8,
    nodeIds: [99, 41, 12, 7],
  };
  const hex = {
    id: 4,
    type: "CHEXA",
    propertyId: 9,
    nodeIds: nodes.map((n) => n.id),
  };
  const packed = packSolveMesh(nodes, [tet], [hex], vid);
  expect([...packed.vertices]).toEqual(nodes.flatMap((n) => [n.x, n.y, n.z]));
  expect([...packed.tetrahedra]).toEqual([2, 0, 3, 1]);
  expect([...packed.hexahedra]).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  expect(
    groupDirichlet(
      [
        ...[0, 1, 2].map((dof) => ({ nodeId: 99, dof })),
        { nodeId: 7, dof: 2 },
        { nodeId: 7, dof: 2 },
        { nodeId: 41, dof: 1, prescribedValue: 0.25 },
        { nodeId: 12, dof: 5 },
      ],
      vid,
    ),
  ).toEqual({
    fixed_vertices: [2],
    fixed_dofs: [{ vertex: 1, dofs: [2] }],
    prescribed_dofs: [{ vertex: 0, dof: 1, value: 0.25 }],
  });
  expect(
    groupPointLoads(
      [
        { nodeId: 7, dof: 1, value: 2 },
        { nodeId: 7, dof: 1, value: -5 },
        { nodeId: 7, dof: 0, value: 8 },
        { nodeId: 12, dof: 5, value: 100 },
      ],
      vid,
    ),
  ).toEqual([{ vertex: 1, force: [8, -3, 0] }]);
});

test("material attributes follow packed element order and name missing assignments", () => {
  const materials = [
    { id: 10, name: "Steel", young: 210000, poisson: 0.3, density: 1 },
    { id: 20, name: "Aluminium", young: 70000, poisson: 0.33, density: 2 },
  ];
  const elements = [9, 8, 9].map((propertyId, id) => ({
    id,
    propertyId,
    type: "CTETRA",
    nodeIds: [],
  }));
  const properties = [
    { id: 8, materialId: 10 },
    { id: 9, materialId: 20 },
  ];
  const resolved = resolveMaterials(elements, materials, properties);
  expect([...resolved.attributes]).toEqual([2, 1, 2]);
  expect(resolved.materials.map((m) => m.young_modulus)).toEqual([
    210000, 70000,
  ]);
  expect(() =>
    resolveMaterials(elements, materials, properties.slice(0, 1)),
  ).toThrow(/element 0 belongs to body 9/);
});

test("invalid connectivity and missing node references fail before WASM", () => {
  expect(() => vid(500, "load")).toThrow(/load references unknown node id 500/);
  expect(() => packSolveMesh(nodes, [], [], vid)).toThrow(
    /No supported elements/,
  );
  expect(() =>
    packSolveMesh(
      nodes,
      [{ id: 3, type: "CTETRA", propertyId: 8, nodeIds: [41, 7] }],
      [],
      vid,
    ),
  ).toThrow(/CTETRA element 3 has 2 nodes/);
});
