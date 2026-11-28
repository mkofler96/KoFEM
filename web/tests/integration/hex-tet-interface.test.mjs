// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// A store model of hexahedra and tetrahedra whose interface quads the tets
// split along a diagonal, solved through the app's own paths (KOF-433): the
// solid solve with either Solve-panel preconditioner, and SIMP and the
// level-set method. The hexes beside the tets are transition elements, so a
// linear field is reproduced exactly, with one stress in every element (the
// mismatched interface gave neither), and the interface faces take no load.

import { beforeAll, describe, expect, test } from "bun:test";
import { buildVertexIndexer } from "../../src/lib/solveMeshPacking.ts";
import { solveSolidInRust } from "../../src/lib/solve/amg.ts";
import { optimizeSolidInRust } from "../../src/lib/solve/topOptRust.ts";
import { routeSolve } from "../../src/lib/solve/route.ts";
import { loadFem } from "../support/wasm.mjs";

let fem;
beforeAll(async () => {
  fem = await loadFem();
});

const neverAsk = () => {
  throw new Error("the continuation prompt must not appear");
};

// A 2×1×1 bar of 4×3×3 cells, node ids from 101: the cells with x < 1 are
// CHEXA, the rest six Kuhn CTETRA each, so x = 1 is a hex/tet interface.
// Every vertex off the outer surface moves, so no element is a box.
const CELLS = [4, 3, 3];
const KUHN = [
  [0, 1, 3, 7],
  [0, 3, 2, 7],
  [0, 2, 6, 7],
  [0, 6, 4, 7],
  [0, 4, 5, 7],
  [0, 5, 1, 7],
];
const HEX_OF_BITS = [0, 1, 3, 2, 4, 5, 7, 6];

function barModel() {
  const [nx, ny, nz] = CELLS;
  const id = (i, j, k) => 101 + i + (nx + 1) * (j + (ny + 1) * k);
  const nodes = [];
  for (let k = 0; k <= nz; k++)
    for (let j = 0; j <= ny; j++)
      for (let i = 0; i <= nx; i++) {
        const inside = i > 0 && i < nx && j > 0 && j < ny && k > 0 && k < nz;
        const phase = 3 * i + 5 * j + 7 * k;
        const shift = inside ? 0.12 : 0;
        nodes.push({
          id: id(i, j, k),
          x: (2 * i) / nx + (shift * 2 * Math.sin(phase)) / nx,
          y: j / ny + (shift * Math.cos(1.3 * phase)) / ny,
          z: k / nz + (shift * Math.sin(0.7 * phase)) / nz,
        });
      }
  const elements = [];
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const corner = (bits) =>
          id(i + (bits & 1), j + ((bits >> 1) & 1), k + ((bits >> 2) & 1));
        if (i < nx / 2) {
          const hex = new Array(8);
          HEX_OF_BITS.forEach((slot, bits) => (hex[slot] = corner(bits)));
          elements.push({ type: "CHEXA", nodeIds: hex });
        } else
          for (const tet of KUHN)
            elements.push({ type: "CTETRA", nodeIds: tet.map(corner) });
      }
  return {
    nodes,
    elements: elements.map((element, index) => ({
      ...element,
      id: index + 1,
      propertyId: 1,
    })),
    materials: [
      { id: 1, name: "Steel", young: 200000, poisson: 0.3, density: 7.85e-9 },
    ],
    properties: [{ id: 1, materialId: 1 }],
  };
}

const onSurface = (node) =>
  [node.x / 2, node.y, node.z].some(
    (coordinate) =>
      Math.abs(coordinate) < 1e-12 || Math.abs(coordinate - 1) < 1e-12,
  );

// u = A·x + b.
const GRADIENT = [
  [2e-3, -1e-3, 0.5e-3],
  [0.7e-3, 1.5e-3, -0.4e-3],
  [-0.3e-3, 0.9e-3, 1.1e-3],
];
const OFFSET = [1e-3, -2e-3, 0.5e-3];
const linearField = (node) =>
  [0, 1, 2].map(
    (row) =>
      OFFSET[row] +
      GRADIENT[row][0] * node.x +
      GRADIENT[row][1] * node.y +
      GRADIENT[row][2] * node.z,
  );

describe("hex/tet interface through the app's solid solve", () => {
  for (const order of [1, 2])
    for (const method of ["amg", "gauss-seidel"])
      test(`order ${order}, ${method}: a linear field is reproduced exactly`, async () => {
        const model = barModel();
        const constraints = model.nodes.filter(onSurface).flatMap((node) =>
          linearField(node).map((value, dof) => ({
            nodeId: node.id,
            dof,
            prescribedValue: value,
          })),
        );
        const vid = buildVertexIndexer(model.nodes);
        const log = [];
        const result = await solveSolidInRust(
          fem,
          { ...model, constraints, loads: [] },
          order,
          method,
          vid,
          vid,
          undefined,
          neverAsk,
          (line) => log.push(line),
        );
        expect(
          log.some((line) =>
            line.startsWith(
              "9 hexahedra joined to tetrahedra by transition elements",
            ),
          ),
          log.join("\n"),
        ).toBe(true);
        // Exact up to the solve's CG tolerance (a relative residual of 1e-6);
        // the mismatched interface was off by about 1e-3 of the field.
        let error = 0;
        let peak = 0;
        model.nodes.forEach((node, vertex) => {
          const field = linearField(node);
          for (let axis = 0; axis < 3; axis++) {
            peak = Math.max(peak, Math.abs(field[axis]));
            error = Math.max(
              error,
              Math.abs(result.displacements[3 * vertex + axis] - field[axis]),
            );
          }
        });
        expect(error / peak).toBeLessThan(1e-5);
        const first = result.vonMises[0];
        const spread = Math.max(
          ...Array.from(result.vonMises, (value) => Math.abs(value - first)),
        );
        expect(spread / first).toBeLessThan(1e-4);
      });

  test("a load on the interface faces is refused by name", () => {
    const model = barModel();
    // Element 2 is the hex at x ∈ [½, 1] in the first row; its +x side
    // (corners 1, 2, 6, 5) meets the tets.
    const interfaceQuad = [1, 2, 6, 5].map(
      (slot) => model.elements[1].nodeIds[slot],
    );
    expect(() =>
      routeSolve({
        ...model,
        constraints: [],
        loads: [],
        surfaceLoads: [
          {
            type: "pressure",
            pressure: 1,
            faces: [interfaceQuad],
            name: "Interface",
          },
        ],
        elementOrder: 1,
      }),
    ).toThrow(/Interface/);
  });
});

describe("hex/tet interface through the app's topology optimization", () => {
  for (const method of ["simp", "level_set"])
    test(`${method} optimizes the transition elements`, () => {
      const model = barModel();
      const clamped = model.nodes.filter((node) => Math.abs(node.x) < 1e-12);
      const tip = model.nodes.filter((node) => Math.abs(node.x - 2) < 1e-12);
      const logs = [];
      const result = optimizeSolidInRust(
        fem,
        {
          ...model,
          constraints: clamped.flatMap((node) =>
            [0, 1, 2].map((dof) => ({ nodeId: node.id, dof })),
          ),
          loads: tip.map((node) => ({
            nodeId: node.id,
            dof: 2,
            value: -1 / tip.length,
          })),
          settings: {
            method,
            objective: "min_compliance",
            constraints: { volumeFraction: 0.5 },
            penalty: 3,
            filterRadius: 0.6,
            moveLimit: 0.2,
            maxIterations: 3,
            tolerance: 0.01,
          },
        },
        (line) => logs.push(line),
        () => undefined,
      );
      expect(
        logs.some((line) =>
          line.startsWith(
            "[topopt] 9 hexahedra joined to tetrahedra by transition elements",
          ),
        ),
        logs.join("\n"),
      ).toBe(true);
      expect(result.density.length).toBe(model.elements.length);
      expect(result.history.length).toBeGreaterThan(0);
      for (const entry of result.history)
        expect(Number.isFinite(entry.compliance)).toBe(true);
    });
});
