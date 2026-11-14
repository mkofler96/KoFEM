// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Wall Bracket solve test — runs the full pipeline in Node.js.
// STEP → tessellate (OCC) → FEM mesh (Netgen) → linear-elastic solve (the
// app's Rust path, through tests/support/rust-solvers.mjs)

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { beforeAll, describe, expect, test } from "bun:test";
import { loadRustSolvers } from "../support/rust-solvers.mjs";
import { loadEngine } from "../support/wasm.mjs";

const here = dirname(fileURLToPath(import.meta.url));

// Maximum element size (mm) the bracket is meshed at; CI used 20.0.
const MAX_ELEMENT_SIZE = 20.0;

describe("wall bracket pipeline", () => {
  let mesh = null;
  let result = null;

  beforeAll(async () => {
    const Module = await loadEngine();

    const stepBytes = new Uint8Array(
      readFileSync(join(here, "../../../test_files/Wall Bracket.stp")),
    );

    // 1. Tessellate (stores OCC shape in WASM for the mesher).
    // Returns flat typed arrays (Float32 vertices xyz-interleaved, Uint32 indices),
    // not a JSON string; deflection_relative mirrors solver.worker.ts.
    Module.tessellate_step(
      stepBytes,
      JSON.stringify({ deflection_relative: 0.001, angular_deflection: 0.5 }),
    );

    // 2. FEM mesh via Netgen OCC.
    // Returns flat typed arrays (Float64 vertices xyz-interleaved, Int32 indices),
    // not a JSON string (issue #166).
    mesh = Module.generate_fem_mesh(
      JSON.stringify({
        // min_element_size floors curvature refinement — same default as solver.worker.ts
        max_element_size: MAX_ELEMENT_SIZE,
        min_element_size: MAX_ELEMENT_SIZE / 10,
        grading: 0.3,
        second_order: false,
        elementsperedge: 2.0,
        elementspercurve: 2.0,
        optsteps_2d: 3,
        optsteps_3d: 3,
      }),
    );
    const nodeCount = mesh.vertices.length / 3;
    Module.free_geometry_cache();

    // 3. Solve on the Rust module. The mesh crosses the boundary as flat typed
    // arrays; the result comes back the same way.
    const rust = await loadRustSolvers();
    result = await rust.solve_linear_elastic(
      {
        vertices: mesh.vertices,
        tetrahedra: mesh.tetrahedra,
        hexahedra: new Int32Array(0),
      },
      JSON.stringify({ young_modulus: 210e9, poisson_ratio: 0.3 }),
      JSON.stringify({
        fixed_vertices: Array.from(
          { length: Math.min(10, nodeCount) },
          (_, index) => index,
        ),
        point_loads: [{ vertex: nodeCount - 1, force: [0, -10000, 0] }],
      }),
      1,
    );
  });

  test("the bracket meshes into tetrahedra", () => {
    expect(mesh.tetrahedra.length).toBeGreaterThan(0);
  });

  test("the linear-elastic solve returns no error", () => {
    expect(result.error).toBeUndefined();
    expect("error" in result).toBe(false);
  });

  test("the solve returns a displacement for every node", () => {
    expect(result.displacements).toHaveLength(mesh.vertices.length);
  });

  test("the loaded bracket has a positive von Mises stress", () => {
    let maxVonMises = 0;
    for (const value of result.von_mises)
      maxVonMises = Math.max(maxVonMises, value);
    expect(maxVonMises).toBeGreaterThan(0);
  });
});
