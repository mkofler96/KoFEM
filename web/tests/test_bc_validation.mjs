// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// KOF-180: exercise the JSON ingestion paths through the real WASM solver.
// Run after rebuilding the engine: bun tests/test_bc_validation.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import createModule from "../src/wasm/pkg/kofem_wasm_emcc.js";

const Module = await createModule({
  wasmBinary: readFileSync(
    new URL("../src/wasm/pkg/kofem_wasm_emcc.wasm", import.meta.url),
  ),
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

function expectCppError(overrides, expected, order) {
  assert.throws(
    () => solve(overrides, order),
    (error) => {
      assert.equal(typeof error, "number", "expected a C++ runtime_error");
      const [type, message] = Module.getExceptionMessage(error);
      assert.match(type, /runtime_error/);
      assert.match(message, expected);
      return true;
    },
    `order ${order}, BCs ${JSON.stringify(overrides)}`,
  );
}

for (const order of [1, 2]) {
  for (const vertex of [-1, 8, 9999]) {
    expectCppError(
      { fixed_vertices: [0, 3, 4, 7, vertex] },
      new RegExp(`add_fixed_vertices: vertex index ${vertex} is out of range`),
      order,
    );
  }

  for (const type of ["force", "traction"]) {
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
  }

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
    assert.ok(!("error" in result), result.error);
    assert.equal(result.displacements.length, mesh.vertices.length);
    assert.ok(result.displacements.every(Number.isFinite));
    assert.ok(result.displacements.some((value) => Math.abs(value) > 0));
    assert.ok(result.von_mises.every(Number.isFinite));
    for (const vertex of [0, 3, 4, 7]) {
      assert.deepEqual(
        Array.from(result.displacements.slice(3 * vertex, 3 * vertex + 3)),
        [0, 0, 0],
      );
    }
  }
  // The loaded face has area 4, so F=[4,-8,12] and t=[1,-2,3] agree.
  for (let i = 0; i < mesh.vertices.length; i++) {
    assert.ok(
      Math.abs(totalForce.displacements[i] - traction.displacements[i]) < 1e-10,
    );
  }
}

// KOF-218: a vertex/component that two BC groups constrain to DIFFERENT values
// is a modelling contradiction. The solve must refuse it with a message naming
// the vertex, the component and both values, not let the last entry win. The
// same value twice (two overlapping fixed groups, a prescribed group listed
// twice) is no contradiction and must keep solving.
for (const order of [1, 2]) {
  // Fixed (u = 0) by fixed_vertices, and prescribed to a non-zero value.
  expectCppError(
    { prescribed_dofs: [{ vertex: 0, dof: 0, value: 0.1 }] },
    /vertex 0 component Ux \(DOF 0\) is fixed to 0 and also prescribed to 0\.1/,
    order,
  );
  // Fixed by a partial fixed_dofs entry, then prescribed.
  expectCppError(
    {
      fixed_dofs: [{ vertex: 1, dofs: [2] }],
      prescribed_dofs: [{ vertex: 1, dof: 2, value: -0.25 }],
    },
    /vertex 1 component Uz \(DOF 2\) is fixed to 0 and also prescribed to -0\.25/,
    order,
  );
  // Two prescribed entries on one DOF with different values.
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

  // Identical duplicates still solve, and the prescribed value is honoured.
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
  assert.ok(!("error" in duplicate), duplicate.error);
  assert.ok(Math.abs(duplicate.displacements[3] - 0.1) < 1e-12);
}

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
  assert.ok("error" in result, `shell BCs ${JSON.stringify(overrides)} solved`);
  assert.match(result.error, expected);
}
expectShellError(
  { prescribed_dofs: [{ vertex: 0, dof: 2, value: 0.001 }] },
  /vertex 0 component Uz \(DOF 2\) is fixed to 0 and also prescribed to 0\.001/,
);
expectShellError(
  {
    prescribed_dofs: [
      { vertex: 8, dof: 2, value: 0.001 },
      { vertex: 8, dof: 2, value: 0.002 },
    ],
  },
  /vertex 8 component Uz \(DOF 2\) is prescribed to 0\.001 and also prescribed to 0\.002/,
);
const shellDuplicate = solveShell({
  fixed_dofs: [{ vertex: 0, dofs: [0, 1, 2, 3, 4, 5] }],
  prescribed_dofs: [
    { vertex: 8, dof: 2, value: 0.001 },
    { vertex: 8, dof: 2, value: 0.001 },
  ],
});
assert.ok(!("error" in shellDuplicate), shellDuplicate.error);
assert.ok(Math.abs(shellDuplicate.displacements[3 * 8 + 2] - 0.001) < 1e-9);

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
const coupledConflict = solveCoupled(clampedEdge, [[6 * 0 + 2, 0.001]]);
assert.ok(
  "error" in coupledConflict,
  "coupled fixed+prescribed conflict solved",
);
assert.match(
  coupledConflict.error,
  /vertex 0 component Uz \(DOF 2\) is fixed to 0 and also prescribed to 0\.001/,
);
const coupledDuplicate = solveCoupled(
  [...clampedEdge, ...clampedEdge],
  [
    [6 * 8 + 2, 0.001],
    [6 * 8 + 2, 0.001],
  ],
);
assert.ok(!("error" in coupledDuplicate), coupledDuplicate.error);

console.log(
  "Conflicting Dirichlet values rejected on solid, shell and coupled paths",
);
console.log("BC input validation passed for element orders 1 and 2");
