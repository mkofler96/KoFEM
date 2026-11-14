// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// KOF-180: exercise the boundary-condition ingestion of the app's Rust solve
// paths (web/src/lib/solve: amg.ts, shellRust.ts, coupledRust.ts, through
// tests/support/rust-solvers.mjs). Boundary-condition input validation for
// element orders 1 and 2, and the conflicting-Dirichlet-value checks (KOF-218)
// on the solid, shell and coupled paths.

import { beforeAll, describe, expect, test } from "bun:test";
import { loadRustSolvers } from "../support/rust-solvers.mjs";

let rust = null;
beforeAll(async () => {
  rust = await loadRustSolvers();
});

const mesh = {
  vertices: Float64Array.from([
    0, 0, 0, 2, 0, 0, 2, 2, 0, 0, 2, 0, 0, 0, 2, 2, 0, 2, 2, 2, 2, 0, 2, 2,
  ]),
  tetrahedra: new Int32Array(),
  hexahedra: Int32Array.from([0, 1, 2, 3, 4, 5, 6, 7]),
};
const material = JSON.stringify({ young_modulus: 210000, poisson_ratio: 0.3 });
const faces = [[1, 2, 6, 5]];
const pressure = { type: "pressure", faces, pressure: 1 };

function solve(overrides, order = 1) {
  return rust.solve_linear_elastic(
    mesh,
    material,
    JSON.stringify({
      fixed_vertices: [0, 3, 4, 7],
      point_loads: [],
      surface_loads: [],
      ...overrides,
    }),
    order,
  );
}

// The solve must reject with an Error whose message matches `expected`.
async function expectSolveError(overrides, expected, order) {
  const context = `order ${order}, BCs ${JSON.stringify(overrides)}`;
  let caught = null;
  try {
    await solve(overrides, order);
  } catch (error) {
    caught = error;
  }
  expect(caught, `${context}: solve did not throw`).toBeInstanceOf(Error);
  expect(caught.message, context).toMatch(expected);
}

describe.each([1, 2])("element order %i", (order) => {
  test.each([-1, 8, 9999])(
    "a fixed vertex index %i out of range is refused",
    async (vertex) => {
      await expectSolveError(
        { fixed_vertices: [0, 3, 4, 7, vertex] },
        new RegExp(`constraint references unknown node id ${vertex}\\b`),
        order,
      );
    },
  );

  // Each malformed vector is refused, naming surface load 1 and its type: a
  // missing one, and anything but three finite numbers — including the
  // string "123", which Float64Array.from would spread into [1, 2, 3].
  test.each(["force", "traction"])(
    "a malformed %s vector is refused",
    async (type) => {
      const named = `Surface load 1 \\(${type}\\)`;
      const notThree = new RegExp(
        `${named}: the force vector must be three finite numbers`,
      );
      await expectSolveError(
        { surface_loads: [pressure, { type, faces }] },
        new RegExp(`${named} has no force vector`),
        order,
      );
      for (const force of [
        null,
        [],
        [1],
        [1, 2],
        [1, 2, 3, 4],
        {},
        3,
        "123",
        { length: 3 },
        [1, Number.NaN, 3],
        [1, Infinity, 3],
        [1, "2", 3],
      ])
        await expectSolveError(
          { surface_loads: [pressure, { type, faces, force }] },
          notThree,
          order,
        );
    },
  );

  test("total force, traction and pressure loads solve to finite displacements with the fixed vertices at zero", async () => {
    const totalForce = await solve(
      { surface_loads: [{ type: "force", faces, force: [4, -8, 12] }] },
      order,
    );
    const traction = await solve(
      { surface_loads: [{ type: "traction", faces, force: [1, -2, 3] }] },
      order,
    );
    for (const result of [
      totalForce,
      traction,
      await solve({ surface_loads: [pressure] }, order),
    ]) {
      expect("error" in result, result.error).toBe(false);
      expect(result.displacements).toHaveLength(mesh.vertices.length);
      expect(result.displacements.every(Number.isFinite)).toBe(true);
      expect(result.displacements.some((value) => Math.abs(value) > 0)).toBe(
        true,
      );
      expect(result.von_mises.every(Number.isFinite)).toBe(true);
      for (const vertex of [0, 3, 4, 7]) {
        expect(
          Array.from(result.displacements.slice(3 * vertex, 3 * vertex + 3)),
        ).toEqual([0, 0, 0]);
      }
    }
  });

  // The loaded face has area 4, so F=[4,-8,12] and t=[1,-2,3] agree.
  test("a total force and the equivalent traction give the same displacements", async () => {
    const totalForce = await solve(
      { surface_loads: [{ type: "force", faces, force: [4, -8, 12] }] },
      order,
    );
    const traction = await solve(
      { surface_loads: [{ type: "traction", faces, force: [1, -2, 3] }] },
      order,
    );
    for (let index = 0; index < mesh.vertices.length; index++) {
      expect(
        Math.abs(
          totalForce.displacements[index] - traction.displacements[index],
        ),
      ).toBeLessThan(1e-10);
    }
  });
});

// KOF-218: a vertex/component that two BC groups constrain to DIFFERENT values
// is a modelling contradiction. The solve must refuse it with a message naming
// the constrained DOF and both values, not let the last entry win. The same
// value twice (two overlapping fixed groups, a prescribed group listed twice)
// is no contradiction and must keep solving. The Rust solid path names the DOF
// as its index 3·vertex + component.
describe.each([1, 2])(
  "conflicting Dirichlet values, element order %i",
  (order) => {
    test("a vertex fixed by fixed_vertices and prescribed non-zero is refused", async () => {
      // Vertex 0, Ux: DOF 3·0 + 0.
      await expectSolveError(
        { prescribed_dofs: [{ vertex: 0, dof: 0, value: 0.1 }] },
        /degree of freedom 0 is constrained twice, to 0 and 0\.1\b/,
        order,
      );
    });

    test("a vertex fixed by a partial fixed_dofs entry and prescribed is refused", async () => {
      // Vertex 1, Uz: DOF 3·1 + 2.
      await expectSolveError(
        {
          fixed_dofs: [{ vertex: 1, dofs: [2] }],
          prescribed_dofs: [{ vertex: 1, dof: 2, value: -0.25 }],
        },
        /degree of freedom 5 is constrained twice, to 0 and -0\.25\b/,
        order,
      );
    });

    test("two prescribed entries with different values on one DOF are refused", async () => {
      // Vertex 1, Ux: DOF 3·1 + 0.
      await expectSolveError(
        {
          prescribed_dofs: [
            { vertex: 1, dof: 0, value: 0.1 },
            { vertex: 1, dof: 0, value: 0.2 },
          ],
        },
        /degree of freedom 3 is constrained twice, to 0\.1 and 0\.2\b/,
        order,
      );
    });

    test("identical duplicates still solve and the prescribed value is honoured", async () => {
      const duplicate = await solve(
        {
          fixed_dofs: [{ vertex: 0, dofs: [0, 1, 2] }],
          prescribed_dofs: [
            { vertex: 1, dof: 0, value: 0.1 },
            { vertex: 1, dof: 0, value: 0.1 },
          ],
        },
        order,
      );
      expect("error" in duplicate, duplicate.error).toBe(false);
      expect(Math.abs(duplicate.displacements[3] - 0.1)).toBeLessThan(1e-12);
    });
  },
);

// Shell path (solveShellInRust's boundary-condition reader): a 2×2-cell plate
// in z = 0, clamped on the x = 0 edge (vertices 0, 1, 2).
const shellMesh = {
  vertices: Float64Array.from(
    [0, 1, 2].flatMap((i) => [0, 1, 2].flatMap((j) => [i * 0.5, j * 0.5, 0])),
  ),
  triangles: Int32Array.from([
    0, 3, 4, 0, 4, 1, 1, 4, 5, 1, 5, 2, 3, 6, 7, 3, 7, 4, 4, 7, 8, 4, 8, 5,
  ]),
};
const shellMaterial = JSON.stringify({
  young_modulus: 210000,
  poisson_ratio: 0.3,
  thickness: 0.01,
});
function solveShell(overrides) {
  return rust.solve_shell(
    shellMesh,
    shellMaterial,
    JSON.stringify({
      fixed_vertices: [0, 1, 2],
      point_loads: [],
      ...overrides,
    }),
  );
}
async function expectShellError(overrides, expected) {
  await expect(
    solveShell(overrides),
    `shell BCs ${JSON.stringify(overrides)} solved`,
  ).rejects.toThrow(expected);
}

describe("conflicting Dirichlet values on the shell path", () => {
  test("a clamped vertex prescribed to a non-zero value is refused", async () => {
    await expectShellError(
      { prescribed_dofs: [{ vertex: 0, dof: 2, value: 0.001 }] },
      /vertex 0 component Uz \(DOF 2\) is fixed to 0 and also prescribed to 0\.001/,
    );
  });

  test("two prescribed entries with different values on one DOF are refused", async () => {
    await expectShellError(
      {
        prescribed_dofs: [
          { vertex: 8, dof: 2, value: 0.001 },
          { vertex: 8, dof: 2, value: 0.002 },
        ],
      },
      /vertex 8 component Uz \(DOF 2\) is prescribed to 0\.001 and also prescribed to 0\.002/,
    );
  });

  test("identical duplicates still solve and the prescribed value is honoured", async () => {
    const shellDuplicate = await solveShell({
      fixed_dofs: [{ vertex: 0, dofs: [0, 1, 2, 3, 4, 5] }],
      prescribed_dofs: [
        { vertex: 8, dof: 2, value: 0.001 },
        { vertex: 8, dof: 2, value: 0.001 },
      ],
    });
    expect("error" in shellDuplicate, shellDuplicate.error).toBe(false);
    expect(
      Math.abs(shellDuplicate.displacements[3 * 8 + 2] - 0.001),
    ).toBeLessThan(1e-9);
  });
});

// Coupled path (solveCoupledInRust): the same plate as a coupled model, DOFs
// addressed as 6·vertex + component. The Rust mixed model needs at least one
// solid element (a shell-only model goes to the shell path in the app), so a
// tet on plate vertices 4, 7, 8 and one vertex above them (9) joins the plate.
const coupledMesh = (tets) => ({
  vertices: Float64Array.from([...shellMesh.vertices, 1, 1, 0.5]),
  tets: Int32Array.from(tets),
  triangles: shellMesh.triangles,
  thicknesses: Float64Array.from({ length: 8 }, () => 0.01),
});
function solveCoupled(fixed, prescribed, tets = [4, 7, 8, 9]) {
  return rust.solve_coupled(
    coupledMesh(tets),
    {
      ref: new Int32Array(0),
      offsets: Int32Array.from([0]),
      solid: new Int32Array(0),
      mpc: new Int32Array(0),
      dof_mask: new Int32Array(0),
      relaxation: 1.0,
    },
    {
      fixed_dofs: Int32Array.from(fixed),
      prescribed_dofs: Int32Array.from(prescribed.map(([dof]) => dof)),
      prescribed_vals: Float64Array.from(prescribed.map(([, value]) => value)),
      load_dofs: new Int32Array(0),
      load_vals: new Float64Array(0),
    },
    JSON.stringify({
      solid: { young_modulus: 210000, poisson_ratio: 0.3 },
      shell: { young_modulus: 210000, poisson_ratio: 0.3 },
    }),
  );
}
const clampedEdge = [0, 1, 2].flatMap((vertex) =>
  [0, 1, 2, 3, 4, 5].map((dof) => 6 * vertex + dof),
);

describe("conflicting Dirichlet values on the coupled path", () => {
  // The Rust coupled path names the DOF as its index 6·vertex + component.
  test("a clamped vertex prescribed to a non-zero value is refused", async () => {
    // Vertex 0, Uz: DOF 6·0 + 2.
    await expect(
      solveCoupled(clampedEdge, [[6 * 0 + 2, 0.001]]),
      "coupled fixed+prescribed conflict solved",
    ).rejects.toThrow(
      /degree of freedom 2 is constrained twice, to 0 and 0\.001\b/,
    );
  });

  test("identical duplicates still solve and the prescribed value is honoured", async () => {
    const coupledDuplicate = await solveCoupled(
      [...clampedEdge, ...clampedEdge],
      [
        [6 * 8 + 2, 0.001],
        [6 * 8 + 2, 0.001],
      ],
    );
    expect(
      Math.abs(coupledDuplicate.displacements[3 * 8 + 2] - 0.001),
    ).toBeLessThan(1e-9);
  });

  // The engine solved the plate alone as a coupled model. The Rust mixed model
  // refuses a model without solid elements; the app sends pure shells to the
  // shell path (route.ts), whose conflict checks are tested above.
  test("a shell-only coupled model is refused", async () => {
    await expect(solveCoupled(clampedEdge, [], [])).rejects.toThrow(
      /the mesh has no elements/,
    );
  });
});
