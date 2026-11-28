// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Large deformation through the app's solve path (KOF-486): solveSolidInRust
// with `largeDeformation`, as the solver worker calls it, into the Rust
// module's Neo-Hookean solve (crates/kofem-fem/src/hyperelastic.rs). The C++
// engine had no large-deformation path, so the checks are against the
// closed-form Neo-Hookean answer:
//   - a cube stretched to 1.5 times its length along x, free to contract
//     across, contracts by the lateral stretch that leaves σyy = σzz = 0, and
//     carries σxx on its contracted face, which the support reaction reports;
//   - two bodies of different stiffness (same ν) stretched side by side
//     contract alike and each carries the stress of its own material;
//   - for tetrahedra and hexahedra of both orders, with both preconditioners;
//   - a column pushed past its Euler load is refused as unstable.

import { beforeAll, describe, expect, test } from "bun:test";
import { solveSolidInRust } from "../../src/lib/solve/amg.ts";
import { buildVertexIndexer } from "../../src/lib/solveMeshPacking.ts";
import { boxHexMesh } from "../../../examples/validation/lib/mesh.mjs";
import { loadFem } from "../support/wasm.mjs";

let fem = null;
beforeAll(async () => {
  fem = await loadFem();
});

const YOUNG = 1000;
const POISSON = 0.3;
const STRETCH = 1.5;

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

// A box of `width` along y, 2 × 2 × 2 cells per unit, of CHEXA or CTETRA;
// cells with y below `split` belong to property 1, the rest to property 2.
function box(elementType, width = 1, split = Infinity) {
  const mesh = boxHexMesh(1, width, 1, 2, 2 * width, 2);
  const nodes = mesh.vertices.map((v, i) => ({
    id: i + 1,
    x: v[0],
    y: v[1],
    z: v[2],
  }));
  const elements = [];
  for (const hex of mesh.hexahedra) {
    const ids = hex.map((n) => n + 1);
    const centreY = hex.reduce((sum, n) => sum + mesh.vertices[n][1], 0) / 8;
    const propertyId = centreY < split ? 1 : 2;
    if (elementType === "CHEXA")
      elements.push({
        id: elements.length + 1,
        type: "CHEXA",
        nodeIds: ids,
        propertyId,
      });
    else
      for (const tet of KUHN)
        elements.push({
          id: elements.length + 1,
          type: "CTETRA",
          nodeIds: tet.map((k) => ids[k]),
          propertyId,
        });
  }
  return { nodes, elements };
}

// Symmetry planes x = 0, y = 0, z = 0 (support 0); the x = 1 face pulled to
// x = STRETCH (support 1).
function stretchSupports(nodes) {
  const constraints = [];
  for (const node of nodes) {
    if (node.x === 0) constraints.push({ nodeId: node.id, dof: 0, group: 0 });
    if (node.y === 0) constraints.push({ nodeId: node.id, dof: 1, group: 0 });
    if (node.z === 0) constraints.push({ nodeId: node.id, dof: 2, group: 0 });
    if (node.x === 1)
      constraints.push({
        nodeId: node.id,
        dof: 0,
        group: 1,
        prescribedValue: STRETCH - 1,
      });
  }
  return constraints;
}

function lame(young) {
  return {
    lambda: (young * POISSON) / ((1 + POISSON) * (1 - 2 * POISSON)),
    mu: young / (2 * (1 + POISSON)),
  };
}

// The lateral stretch where σyy = μ·(λ₂² − 1) + λ·ln(STRETCH·λ₂²) vanishes
// (it depends on ν only), and σxx of a material of modulus `young` there.
function closedForm(young) {
  const { lambda, mu } = lame(young);
  const condition = (lateral) =>
    mu * (lateral * lateral - 1) +
    lambda * Math.log(STRETCH * lateral * lateral);
  let [low, high] = [0.1, 2];
  for (let i = 0; i < 200; i++) {
    const middle = (low + high) / 2;
    if (condition(middle) > 0) high = middle;
    else low = middle;
  }
  const lateral = (low + high) / 2;
  const jacobian = STRETCH * lateral * lateral;
  const sigmaXX =
    (mu * (STRETCH * STRETCH - 1) + lambda * Math.log(jacobian)) / jacobian;
  return { lateral, sigmaXX };
}

async function solve(model, { order, method, increments = 5 }) {
  const logs = [];
  const vid = buildVertexIndexer(model.nodes);
  const result = await solveSolidInRust(
    fem,
    { loads: [], ...model, largeDeformation: { increments } },
    order,
    method,
    vid,
    vid,
    undefined,
    neverAsk,
    (line) => logs.push(line),
  );
  return { result, logs };
}

const materials = [
  { id: 1, name: "Soft", young: YOUNG, poisson: POISSON, density: 1e-9 },
  { id: 2, name: "Stiff", young: 3 * YOUNG, poisson: POISSON, density: 1e-9 },
];

describe("a cube stretched to 1.5 times its length", () => {
  const { lateral, sigmaXX } = closedForm(YOUNG);
  for (const elementType of ["CHEXA", "CTETRA"])
    for (const order of [1, 2])
      for (const method of ["amg", "gauss-seidel"])
        test(`${elementType}, order ${order}, ${method}: the closed-form Neo-Hookean answer`, async () => {
          const { nodes, elements } = box(elementType);
          const { result, logs } = await solve(
            {
              nodes,
              elements,
              materials,
              properties: [{ id: 1, materialId: 1 }],
              constraints: stretchSupports(nodes),
            },
            { order, method },
          );
          nodes.forEach((node, index) => {
            for (const [axis, coordinate] of [
              [1, node.y],
              [2, node.z],
            ])
              expect(
                Math.abs(
                  result.displacements[3 * index + axis] -
                    (lateral - 1) * coordinate,
                ),
              ).toBeLessThan(1e-5);
          });
          // Cauchy stress at every element corner (σxx, σyy, σzz, τxy, τyz,
          // τzx): uniaxial, σxx on the contracted face.
          const tensors = result.stress.top;
          expect(tensors.length).toBeGreaterThan(0);
          for (let i = 0; i < tensors.length; i += 6) {
            expect(Math.abs(tensors[i] - sigmaXX) / sigmaXX).toBeLessThan(1e-5);
            for (let k = 1; k < 6; k++)
              expect(Math.abs(tensors[i + k]) / sigmaXX).toBeLessThan(1e-5);
          }
          for (const vonMises of result.vonMises)
            expect(Math.abs(vonMises - sigmaXX) / sigmaXX).toBeLessThan(1e-5);
          // The pulled face's reaction is σxx on its current area lateral²;
          // the symmetry planes take the opposite.
          const pulled = result.reactions.supports[1].force[0];
          expect(
            Math.abs(pulled - sigmaXX * lateral * lateral) / sigmaXX,
          ).toBeLessThan(1e-5);
          expect(
            Math.abs(result.reactions.supports[0].force[0] + pulled) / sigmaXX,
          ).toBeLessThan(1e-5);
          expect(
            logs.some((line) => line.startsWith("Large deformation converged")),
          ).toBe(true);
        });
});

test("two bodies of different stiffness stretched side by side carry their own stress", async () => {
  const { nodes, elements } = box("CHEXA", 2, 1);
  const { result } = await solve(
    {
      nodes,
      elements,
      materials,
      properties: [
        { id: 1, materialId: 1 },
        { id: 2, materialId: 2 },
      ],
      constraints: stretchSupports(nodes),
    },
    { order: 1, method: "amg" },
  );
  const soft = closedForm(YOUNG);
  const stiff = closedForm(3 * YOUNG);
  expect(Math.abs(soft.lateral - stiff.lateral)).toBeLessThan(1e-12);
  // CHEXA stress is read at the eight corners of each element, in order,
  // six components each.
  const tensors = result.stress.top;
  elements.forEach((element, index) => {
    const expected = element.propertyId === 1 ? soft.sigmaXX : stiff.sigmaXX;
    for (let corner = 0; corner < 8; corner++)
      expect(
        Math.abs(tensors[6 * (8 * index + corner)] - expected) / expected,
      ).toBeLessThan(1e-5);
  });
  // Each body's face area along the pulled face: 1 × 1 before, lateral² after.
  const pulled = result.reactions.supports[1].force[0];
  const expected = (soft.sigmaXX + stiff.sigmaXX) * soft.lateral * soft.lateral;
  expect(Math.abs(pulled - expected) / expected).toBeLessThan(1e-5);
});

test("the reactions balance in moment where the forces act, in the deformed configuration", async () => {
  // One tetrahedron, every vertex moved to u_x = 0.5·X + 0.4·Y by support 0:
  // its reactions are its internal forces, which balance in moment about any
  // point of the deformed shape. Taken about the undeformed vertices, their
  // moment would be about −19 N·mm about z.
  const corners = [
    [0, 0, 0],
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  const nodes = corners.map(([x, y, z], i) => ({ id: i + 1, x, y, z }));
  const constraints = nodes.flatMap((node) => [
    {
      nodeId: node.id,
      dof: 0,
      group: 0,
      prescribedValue: 0.5 * node.x + 0.4 * node.y,
    },
    { nodeId: node.id, dof: 1, group: 0, prescribedValue: 0 },
    { nodeId: node.id, dof: 2, group: 0, prescribedValue: 0 },
  ]);
  const { result } = await solve(
    {
      nodes,
      elements: [
        { id: 1, type: "CTETRA", nodeIds: [1, 2, 3, 4], propertyId: 1 },
      ],
      materials,
      properties: [{ id: 1, materialId: 1 }],
      constraints,
    },
    { order: 1, method: "gauss-seidel", increments: 2 },
  );
  const [support] = result.reactions.supports;
  const scale = Math.max(
    ...result.reactions.nodal.flatMap((node) => node.force.map(Math.abs)),
  );
  expect(scale).toBeGreaterThan(10);
  for (let axis = 0; axis < 3; axis++) {
    expect(Math.abs(support.force[axis])).toBeLessThan(1e-9 * scale);
    expect(Math.abs(support.moment[axis])).toBeLessThan(1e-9 * scale);
  }
  // The arrows stay where the support's nodes are drawn, undeformed.
  expect(support.centroid).toEqual([0.25, 0.25, 0.25]);
});

test("a column pushed past its Euler load is refused as unstable", async () => {
  // 10 long, 0.4 square, clamped at x = 0, pushed along −x at x = 10 with
  // twice Euler's load π²·E·I/(4·L²).
  const length = 10;
  const depth = 0.4;
  const mesh = boxHexMesh(length, depth, depth, 20, 1, 1);
  const nodes = mesh.vertices.map((v, i) => ({
    id: i + 1,
    x: v[0],
    y: v[1],
    z: v[2],
  }));
  const elements = mesh.hexahedra.map((hex, index) => ({
    id: index + 1,
    type: "CHEXA",
    nodeIds: hex.map((n) => n + 1),
    propertyId: 1,
  }));
  const inertia = depth ** 4 / 12;
  const euler = (Math.PI ** 2 * YOUNG * inertia) / (4 * length * length);
  const end = nodes.filter((node) => node.x === length);
  const constraints = nodes
    .filter((node) => node.x === 0)
    .flatMap((node) => [0, 1, 2].map((dof) => ({ nodeId: node.id, dof })));
  const loads = end.map((node) => ({
    nodeId: node.id,
    dof: 0,
    value: (-2 * euler) / end.length,
  }));
  await expect(
    solve(
      {
        nodes,
        elements,
        materials,
        properties: [{ id: 1, materialId: 1 }],
        constraints,
        loads,
      },
      { order: 2, method: "amg", increments: 4 },
    ),
  ).rejects.toThrow(/not positive definite.*buckles or snaps through/);
});
