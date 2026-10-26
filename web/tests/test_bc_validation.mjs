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

console.log("BC input validation passed for element orders 1 and 2");
