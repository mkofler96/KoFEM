// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Frictionless contact through the app's solve path (KOF-485): the contact
// pairs reach the Rust module (crates/kofem-fem/src/contact.rs) through
// solveSolidInRust, as the solver worker calls it. The C++ engine has no
// contact path, so the checks are against exact solutions.
//
// The model is two boxes along x with a 0.5 mm gap, meshed independently with
// different divisions, on roller supports, box B's far end pushed towards box
// A by a prescribed displacement:
//   - while the push is short of the gap, nothing touches: no contact force,
//     box A unloaded;
//   - once it closes the gap, the boxes are two bars in series: the contact
//     force is E·A·(push − gap)/(2L), carried as a uniform pressure across
//     the non-matching interface;
//   - for tetrahedra and hexahedra, with both preconditioners.

import { beforeAll, describe, expect, test } from "bun:test";
import { solveSolidInRust } from "../../src/lib/solve/amg.ts";
import { buildVertexIndexer } from "../../src/lib/solveMeshPacking.ts";
import { boxHexMesh } from "../../../examples/validation/lib/mesh.mjs";
import { loadFem } from "../support/wasm.mjs";

let fem = null;
beforeAll(async () => {
  fem = await loadFem();
});

const GAP = 0.5;
const LENGTH = 10;
const SIDE = 4;
const YOUNG = 210000;
const ID_OFFSET = 1000;

const neverAsk = () => {
  throw new Error("the continuation prompt must not appear");
};

// A hexahedron as six tetrahedra around its 0–6 diagonal.
const KUHN = [
  [0, 1, 2, 6],
  [0, 2, 3, 6],
  [0, 3, 7, 6],
  [0, 7, 4, 6],
  [0, 4, 5, 6],
  [0, 5, 1, 6],
];

// Box A (x ∈ [0, 10], 2×2 across) and box B (x ∈ [10.5, 20.5], 3×3 across).
function gappedBoxes(elementType) {
  const boxA = boxHexMesh(LENGTH, SIDE, SIDE, 4, 2, 2);
  const boxB = boxHexMesh(LENGTH, SIDE, SIDE, 4, 3, 3);
  const nodes = [];
  boxA.vertices.forEach((v, i) =>
    nodes.push({ id: i, x: v[0], y: v[1], z: v[2] }),
  );
  boxB.vertices.forEach((v, i) =>
    nodes.push({ id: ID_OFFSET + i, x: v[0] + LENGTH + GAP, y: v[1], z: v[2] }),
  );
  const elements = [];
  const add = (hex, offset, propertyId) => {
    const ids = hex.map((n) => offset + n);
    if (elementType === "CHEXA") {
      elements.push({
        id: elements.length + 1,
        type: "CHEXA",
        nodeIds: ids,
        propertyId,
      });
      return;
    }
    for (const tet of KUHN)
      elements.push({
        id: elements.length + 1,
        type: "CTETRA",
        nodeIds: tet.map((k) => ids[k]),
        propertyId,
      });
  };
  boxA.hexahedra.forEach((hex) => add(hex, 0, 1));
  boxB.hexahedra.forEach((hex) => add(hex, ID_OFFSET, 2));
  return { nodes, elements };
}

const onPlane = (nodes, x) =>
  nodes.filter((node) => Math.abs(node.x - x) < 1e-9).map((node) => node.id);

const materials = [
  { id: 1, name: "Steel", young: YOUNG, poisson: 0.3, density: 7.85e-9 },
];
const properties = [
  { id: 1, materialId: 1 },
  { id: 2, materialId: 1 },
];

async function solve(elementType, push, method) {
  const { nodes, elements } = gappedBoxes(elementType);
  const constraints = [];
  for (const node of nodes) {
    if (node.x === 0) constraints.push({ nodeId: node.id, dof: 0 });
    if (node.y === 0) constraints.push({ nodeId: node.id, dof: 1 });
    if (node.z === 0) constraints.push({ nodeId: node.id, dof: 2 });
  }
  for (const nodeId of onPlane(nodes, 2 * LENGTH + GAP))
    constraints.push({ nodeId, dof: 0, prescribedValue: -push });
  const contacts = [
    {
      name: "Contact1",
      facesA: [{ nodeIds: onPlane(nodes, LENGTH) }],
      facesB: [{ nodeIds: onPlane(nodes, LENGTH + GAP) }],
    },
  ];
  const logs = [];
  const vid = buildVertexIndexer(nodes);
  const result = await solveSolidInRust(
    fem,
    {
      nodes,
      elements,
      materials,
      properties,
      constraints,
      loads: [],
      contacts,
    },
    1,
    method,
    vid,
    vid,
    undefined,
    neverAsk,
    (line) => logs.push(line),
  );
  return { nodes, result, logs };
}

describe("contact between two boxes across a gap", () => {
  for (const elementType of ["CHEXA", "CTETRA"])
    for (const method of ["amg", "gauss-seidel"]) {
      test(`${elementType}, ${method}: no force until the gap closes`, async () => {
        const { nodes, result } = await solve(elementType, 0.6 * GAP, method);
        const { contact } = result;
        expect(contact).not.toBeNull();
        expect(contact.closed.every((closed) => closed === 0)).toBe(true);
        expect(contact.force).toBe(0);
        // Box A carries nothing.
        const moved = nodes
          .map((node, index) => [node, index])
          .filter(([node]) => node.id < ID_OFFSET)
          .reduce(
            (max, [, index]) =>
              Math.max(max, Math.abs(result.displacements[3 * index])),
            0,
          );
        expect(moved).toBe(0);
      });

      test(`${elementType}, ${method}: two bars in series once it closes`, async () => {
        const push = 2 * GAP;
        const { nodes, result, logs } = await solve(elementType, push, method);
        const { contact } = result;
        const area = SIDE * SIDE;
        const expected = (YOUNG * area * (push - GAP)) / (2 * LENGTH);
        expect(contact.closed.every((closed) => closed === 1)).toBe(true);
        // Box B's facing nodes are the finer side: they carry the condition.
        expect(contact.nodeIds.every((id) => id >= ID_OFFSET)).toBe(true);
        expect(contact.nodeIds).toHaveLength(16);
        expect(Math.abs(contact.force - expected) / expected).toBeLessThan(
          1e-5,
        );
        for (const pressure of contact.pressure)
          expect(
            Math.abs(pressure - expected / area) / (expected / area),
          ).toBeLessThan(1e-5);
        // Box A's facing end moves by F·L/(E·A).
        const facing = onPlane(nodes, LENGTH).map((id) =>
          nodes.findIndex((node) => node.id === id),
        );
        for (const index of facing)
          expect(
            Math.abs(result.displacements[3 * index] + (push - GAP) / 2),
          ).toBeLessThan(1e-5 * push);
        expect(logs.some((line) => line.startsWith("Contact converged"))).toBe(
          true,
        );
      });
    }
});
