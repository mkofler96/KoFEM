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
//
// With box B unsupported and pushed by a force instead (KOF-501), only the
// contact holds it, and only along x: it is pressed onto box A across the
// gap all the same, and a load across the contact is refused by name.

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

// Box A (x ∈ [0, 10], 2×2 across) and box B (x ∈ [10.5, 20.5], 3×3 across,
// or `acrossB` × `acrossB`).
function gappedBoxes(elementType, acrossB = 3) {
  const boxA = boxHexMesh(LENGTH, SIDE, SIDE, 4, 2, 2);
  const boxB = boxHexMesh(LENGTH, SIDE, SIDE, 4, acrossB, acrossB);
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

// The facing surfaces as one contact, or as two split at y = SIDE / 2.
const facing = (nodes, split) => {
  const sides = (keep) => [
    { nodeIds: onPlane(nodes.filter(keep), LENGTH) },
    { nodeIds: onPlane(nodes.filter(keep), LENGTH + GAP) },
  ];
  const pair = (name, [facesA, facesB]) => ({
    name,
    facesA: [facesA],
    facesB: [facesB],
  });
  return split
    ? [
        pair(
          "Contact1",
          sides((node) => node.y <= SIDE / 2),
        ),
        pair(
          "Contact2",
          sides((node) => node.y >= SIDE / 2),
        ),
      ]
    : [
        pair(
          "Contact1",
          sides(() => true),
        ),
      ];
};

// `split`: the facing surfaces as two contacts meeting at y = SIDE / 2;
// "half": only the half y ≤ SIDE / 2 picked.
async function solve(elementType, push, method, split = false) {
  const { nodes, elements } = gappedBoxes(elementType, split ? 4 : 3);
  const constraints = [];
  for (const node of nodes) {
    if (node.x === 0) constraints.push({ nodeId: node.id, dof: 0 });
    if (node.y === 0) constraints.push({ nodeId: node.id, dof: 1 });
    if (node.z === 0) constraints.push({ nodeId: node.id, dof: 2 });
  }
  for (const nodeId of onPlane(nodes, 2 * LENGTH + GAP))
    constraints.push({ nodeId, dof: 0, prescribedValue: -push });
  const contacts =
    split === "half" ? facing(nodes, true).slice(0, 1) : facing(nodes, split);
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

// Box A on its rollers, box B on nothing, a force `[fx, fy]` spread over box
// B's far end, or the loads `endLoads(end nodes)` there.
function solveResting(elementType, [fx, fy], method, endLoads) {
  const { nodes, elements } = gappedBoxes(elementType);
  const constraints = [];
  for (const node of nodes) {
    if (node.id >= ID_OFFSET) continue;
    if (node.x === 0) constraints.push({ nodeId: node.id, dof: 0 });
    if (node.y === 0) constraints.push({ nodeId: node.id, dof: 1 });
    if (node.z === 0) constraints.push({ nodeId: node.id, dof: 2 });
  }
  const endNodes = nodes.filter(
    (node) => Math.abs(node.x - (2 * LENGTH + GAP)) < 1e-9,
  );
  const loads = endLoads
    ? endLoads(endNodes)
    : endNodes.flatMap(({ id: nodeId }) => [
        { nodeId, dof: 0, value: fx / endNodes.length },
        { nodeId, dof: 1, value: fy / endNodes.length },
      ]);
  const vid = buildVertexIndexer(nodes);
  return solveSolidInRust(
    fem,
    {
      nodes,
      elements,
      materials,
      properties,
      constraints,
      loads,
      contacts: [
        {
          name: "Contact1",
          facesA: [{ nodeIds: onPlane(nodes, LENGTH) }],
          facesB: [{ nodeIds: onPlane(nodes, LENGTH + GAP) }],
        },
      ],
    },
    1,
    method,
    vid,
    vid,
    undefined,
    neverAsk,
    () => undefined,
  );
}

const PUSH = 1000;

describe("a box only the contact holds", () => {
  for (const elementType of ["CHEXA", "CTETRA"])
    for (const method of ["amg", "gauss-seidel"]) {
      test(`${elementType}, ${method}: pressed onto the other box across the gap`, async () => {
        const { contact } = await solveResting(elementType, [-PUSH, 0], method);
        expect(contact.closed.every((closed) => closed === 1)).toBe(true);
        // The end load is lumped evenly over the end nodes, not as a uniform
        // traction, so the pressure is not uniform; the force is the push.
        expect(Math.abs(contact.force - PUSH) / PUSH).toBeLessThan(1e-5);
        expect(contact.pressure.every((pressure) => pressure > 0)).toBe(true);
      });
    }

  test("a load across the contact is refused, naming the body and the motion", async () => {
    await expect(solveResting("CHEXA", [-PUSH, 10], "amg")).rejects.toThrow(
      "Body 2 is held only by contact, which cannot stop it: its load would make it move along Y. " +
        "Add a support or connect it to another body.",
    );
  });

  test("a box pulled off the contact is refused", async () => {
    await expect(solveResting("CHEXA", [PUSH, 0], "amg")).rejects.toThrow(
      "Body 2 is held only by contact, which cannot stop it: its load would make it move along X.",
    );
  });
});

for (const sense of [1, -1])
  test(`a twist about the contact normal is refused as a rotation (sense ${sense})`, async () => {
    // Opposite forces along y on the top and bottom edges of box B's end: a
    // couple about x, which a flat frictionless contact cannot take. Either
    // way round it is a rotation about X.
    const twist = (end) =>
      end
        .filter((node) => node.z === 0 || node.z === SIDE)
        .map((node) => ({
          nodeId: node.id,
          dof: 1,
          value: (node.z === 0 ? 10 : -10) * sense,
        }));
    await expect(
      solveResting("CHEXA", [-PUSH, 0], "amg", (end) => [
        ...end.map((node) => ({
          nodeId: node.id,
          dof: 0,
          value: -PUSH / end.length,
        })),
        ...twist(end),
      ]),
    ).rejects.toThrow(
      "Body 2 is held only by contact, which cannot stop it: its load would make it rotate about X.",
    );
  });

// One surface picked as two contacts meeting at y = 2, a grid line of both
// boxes: the nodes on it take both contacts' shares as one condition, so the
// boxes are the same two bars in series.
test("two contacts meeting at an edge act as one", async () => {
  const push = 2 * GAP;
  const { result } = await solve("CHEXA", push, "amg", true);
  const { contact } = result;
  const area = SIDE * SIDE;
  const expected = (YOUNG * area * (push - GAP)) / (2 * LENGTH);
  expect(contact.closed.every((closed) => closed === 1)).toBe(true);
  expect(contact.nodeIds).toHaveLength(25);
  expect(Math.abs(contact.force - expected) / expected).toBeLessThan(1e-5);
  for (const pressure of contact.pressure)
    expect(
      Math.abs(pressure - expected / area) / (expected / area),
    ).toBeLessThan(1e-5);
});

// Only half of the facing surfaces picked: the other half would pass through
// box A, so the contact grows over it, and the boxes are the same two bars
// in series as with the whole surface picked.
test("a contact picked on half the facing surfaces grows over the rest", async () => {
  const push = 2 * GAP;
  const { result, logs } = await solve("CHEXA", push, "amg", "half");
  const { contact } = result;
  const area = SIDE * SIDE;
  const expected = (YOUNG * area * (push - GAP)) / (2 * LENGTH);
  expect(contact.nodeIds).toHaveLength(25);
  expect(contact.closed.every((closed) => closed === 1)).toBe(true);
  expect(Math.abs(contact.force - expected) / expected).toBeLessThan(1e-5);
  expect(logs.some((line) => line.startsWith("Contact grew over"))).toBe(true);
});
