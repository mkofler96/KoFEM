// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// KOF-180: exercise the JSON ingestion paths through the real WASM solver.
// Boundary-condition input validation for element orders 1 and 2, and the
// conflicting-Dirichlet-value checks (KOF-218) on the solid, shell and coupled
// paths.

import { beforeAll, describe, expect, test } from "bun:test";
import { loadEngine } from "../support/wasm.mjs";

let Module = null;
beforeAll(async () => {
  Module = await loadEngine();
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
  return Module.solve_linear_elastic(
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

// The solve must throw a C++ runtime_error whose message matches `expected`.
function expectCppError(overrides, expected, order) {
  const context = `order ${order}, BCs ${JSON.stringify(overrides)}`;
  let caught = null;
  let thrown = false;
  try {
    solve(overrides, order);
  } catch (error) {
    thrown = true;
    caught = error;
  }
  expect(thrown, `${context}: solve did not throw`).toBe(true);
  expect(typeof caught, `${context}: expected a C++ runtime_error`).toBe(
    "number",
  );
  const [type, message] = Module.getExceptionMessage(caught);
  expect(type, context).toMatch(/runtime_error/);
  expect(message, context).toMatch(expected);
}

describe.each([1, 2])("element order %i", (order) => {
  test.each([-1, 8, 9999])(
    "a fixed vertex index %i out of range is refused",
    (vertex) => {
      expectCppError(
        { fixed_vertices: [0, 3, 4, 7, vertex] },
        new RegExp(
          `add_fixed_vertices: vertex index ${vertex} is out of range`,
        ),
        order,
      );
    },
  );

  test.each(["force", "traction"])(
    "a malformed %s vector is refused",
    (type) => {
      for (const force of [
        undefined,
        null,
        [],
        [1],
        [1, 2],
        [1, 2, 3, 4],
        {},
        "123",
        3,
        { length: 3 },
      ]) {
        expectCppError(
          { surface_loads: [pressure, { type, faces, force }] },
          new RegExp(
            `surface_load 1 \\(${type}\\): malformed force vector.*exactly 3`,
          ),
          order,
        );
      }
    },
  );

  test("total force, traction and pressure loads solve to finite displacements with the fixed vertices at zero", () => {
    const totalForce = solve(
      { surface_loads: [{ type: "force", faces, force: [4, -8, 12] }] },
      order,
    );
    const traction = solve(
      { surface_loads: [{ type: "traction", faces, force: [1, -2, 3] }] },
      order,
    );
    for (const result of [
      totalForce,
      traction,
      solve({ surface_loads: [pressure] }, order),
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
  test("a total force and the equivalent traction give the same displacements", () => {
    const totalForce = solve(
      { surface_loads: [{ type: "force", faces, force: [4, -8, 12] }] },
      order,
    );
    const traction = solve(
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
// the vertex, the component and both values, not let the last entry win. The
// same value twice (two overlapping fixed groups, a prescribed group listed
// twice) is no contradiction and must keep solving.
describe.each([1, 2])(
  "conflicting Dirichlet values, element order %i",
  (order) => {
    test("a vertex fixed by fixed_vertices and prescribed non-zero is refused", () => {
      expectCppError(
        { prescribed_dofs: [{ vertex: 0, dof: 0, value: 0.1 }] },
        /vertex 0 component Ux \(DOF 0\) is fixed to 0 and also prescribed to 0\.1/,
        order,
      );
    });

    test("a vertex fixed by a partial fixed_dofs entry and prescribed is refused", () => {
      expectCppError(
        {
          fixed_dofs: [{ vertex: 1, dofs: [2] }],
          prescribed_dofs: [{ vertex: 1, dof: 2, value: -0.25 }],
        },
        /vertex 1 component Uz \(DOF 2\) is fixed to 0 and also prescribed to -0\.25/,
        order,
      );
    });

    test("two prescribed entries with different values on one DOF are refused", () => {
      expectCppError(
        {
          prescribed_dofs: [
            { vertex: 1, dof: 0, value: 0.1 },
            { vertex: 1, dof: 0, value: 0.2 },
          ],
        },
        /vertex 1 component Ux \(DOF 0\) is prescribed to 0\.1 and also prescribed to 0\.2/,
        order,
      );
    });

    test("identical duplicates still solve and the prescribed value is honoured", () => {
      const duplicate = solve(
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

// Shell path (solve_shell → shell_core add_prescribed): a 2×2-cell plate in
// z = 0, clamped on the x = 0 edge (vertices 0, 1, 2).
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
  return Module.solve_shell(
    shellMesh,
    shellMaterial,
    JSON.stringify({
      fixed_vertices: [0, 1, 2],
      point_loads: [],
      ...overrides,
    }),
  );
}
function expectShellError(overrides, expected) {
  const result = solveShell(overrides);
  expect(
    "error" in result,
    `shell BCs ${JSON.stringify(overrides)} solved`,
  ).toBe(true);
  expect(result.error).toMatch(expected);
}

describe("conflicting Dirichlet values on the shell path", () => {
  test("a clamped vertex prescribed to a non-zero value is refused", () => {
    expectShellError(
      { prescribed_dofs: [{ vertex: 0, dof: 2, value: 0.001 }] },
      /vertex 0 component Uz \(DOF 2\) is fixed to 0 and also prescribed to 0\.001/,
    );
  });

  test("two prescribed entries with different values on one DOF are refused", () => {
    expectShellError(
      {
        prescribed_dofs: [
          { vertex: 8, dof: 2, value: 0.001 },
          { vertex: 8, dof: 2, value: 0.002 },
        ],
      },
      /vertex 8 component Uz \(DOF 2\) is prescribed to 0\.001 and also prescribed to 0\.002/,
    );
  });

  test("identical duplicates still solve and the prescribed value is honoured", () => {
    const shellDuplicate = solveShell({
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

// Coupled path (solve_coupled → shell_core add_prescribed): the same plate as a
// shell-only coupled model, DOFs addressed as 6·vertex + component.
function solveCoupled(fixed, prescribed) {
  return Module.solve_coupled(
    {
      vertices: shellMesh.vertices,
      tets: new Int32Array(0),
      triangles: shellMesh.triangles,
      thicknesses: Float64Array.from({ length: 8 }, () => 0.01),
    },
    {
      ref: new Int32Array(0),
      offsets: Int32Array.from([0]),
      solid: new Int32Array(0),
      mpc: new Int32Array(0),
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
  test("a clamped vertex prescribed to a non-zero value is refused", () => {
    const coupledConflict = solveCoupled(clampedEdge, [[6 * 0 + 2, 0.001]]);
    expect(
      "error" in coupledConflict,
      "coupled fixed+prescribed conflict solved",
    ).toBe(true);
    expect(coupledConflict.error).toMatch(
      /vertex 0 component Uz \(DOF 2\) is fixed to 0 and also prescribed to 0\.001/,
    );
  });

  test("identical duplicates still solve", () => {
    const coupledDuplicate = solveCoupled(
      [...clampedEdge, ...clampedEdge],
      [
        [6 * 8 + 2, 0.001],
        [6 * 8 + 2, 0.001],
      ],
    );
    expect("error" in coupledDuplicate, coupledDuplicate.error).toBe(false);
  });
});
