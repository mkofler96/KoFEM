// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Loads the committed KoFEM WASM engine and exposes a thin solve() wrapper.
//
// This is the same module the browser worker (web/src/workers/solver.worker.ts)
// drives — we just call it from Node so each validation case runs the real MFEM
// solver, not a re-implementation. See test_wall_bracket.mjs for the original
// "run the WASM under Node" pattern this follows.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = join(here, "../../../web/src/wasm/pkg");

/**
 * Initialise the WASM engine once and return a solve() closure.
 *
 * solve(mesh, material, bcs, order?) mirrors solve_linear_elastic
 * (nested tuples here are flattened to the engine's typed arrays):
 *   mesh:     { vertices:[[x,y,z]...], tetrahedra:[[..4]...], hexahedra:[[..8]...] }
 *   material: { young_modulus, poisson_ratio, density? }
 *   bcs:      { fixed_vertices:[v...],
 *               fixed_dofs:[{vertex,dofs:[0|1|2,...]}...],   // single-DOF (new)
 *               prescribed_dofs:[{vertex,dof:0|1|2,value}...], // non-zero Dirichlet
 *               point_loads:[{vertex, force:[fx,fy,fz]}...],
 *               surface_loads:[{ type:"force"|"pressure"|"traction",
 *                                faces:[[a,b,c(,d)]...],
 *                                force?:[fx,fy,fz], pressure?:p }...] }
 *   order:    FE polynomial order (default 1). Order 2 (quadratic) elements use
 *             the engine's tight 1e-6 CG tolerance and are exercised by the
 *             cantilever-bending-p2 case (see solve_mfem.cpp, order ≥ 2 path).
 * Returns { displacements:number[] (3/node), von_mises:number[] (1/elem) }.
 */
export async function loadSolver() {
  const Module = await loadModule();

  return function solve(mesh, material, bcs, order = 1) {
    // The engine takes the mesh as flat typed arrays (issue #166); the
    // validation cases author nested tuples, so flatten at this boundary.
    // Material and BCs stay JSON (small payloads).
    const meshArrays = {
      vertices: Float64Array.from(mesh.vertices.flat()),
      tetrahedra: Int32Array.from((mesh.tetrahedra ?? []).flat()),
      hexahedra: Int32Array.from((mesh.hexahedra ?? []).flat()),
    };
    const bcsJson = JSON.stringify({
      fixed_vertices: bcs.fixed_vertices ?? [],
      fixed_dofs: bcs.fixed_dofs ?? [],
      prescribed_dofs: bcs.prescribed_dofs ?? [],
      point_loads: bcs.point_loads ?? [],
      surface_loads: bcs.surface_loads ?? [],
    });
    const result = Module.solve_linear_elastic(
      meshArrays,
      JSON.stringify(material),
      bcsJson,
      order,
    );
    if ("error" in result) throw new Error(result.error);
    // Plain arrays keep the documented number[] contract for the cases.
    return {
      displacements: Array.from(result.displacements),
      von_mises: Array.from(result.von_mises),
    };
  };
}

// The raw Emscripten module, shared by the solve wrappers below.
async function loadModule() {
  const wasmBinary = readFileSync(join(pkg, "kofem_wasm_emcc.wasm")).buffer;
  const { default: createModule } = await import(
    join(pkg, "kofem_wasm_emcc.js")
  );
  return createModule({ wasmBinary, print: () => {}, printErr: () => {} });
}

/**
 * Initialise the engine and return a solveShell() closure over the Kirchhoff
 * flat-facet shell entry point (solve_shell). Same nested-tuple → typed-array
 * flattening as loadSolver, for the shell's triangle surface mesh:
 *   mesh:     { vertices:[[x,y,z]...], triangles:[[a,b,c]...],
 *               thicknesses?:[t...] }   (per-facet thickness)
 *   material: { young_modulus, poisson_ratio, thickness }
 *   bcs:      { fixed_vertices:[v...],
 *               fixed_dofs:[{vertex, dofs:[0..5,...]}...],       // u = 0
 *               prescribed_dofs:[{vertex, dof:0..5, value}...],  // u = value
 *               point_loads:[{vertex, force:[fx,fy,fz], moment?:[mx,my,mz]}...] }
 * Shell DOF components are 0..5 = (u,v,w,θx,θy,θz).
 * Returns { displacements:number[] (3/node), von_mises:number[] (1/triangle) }.
 */
export async function loadShellSolver() {
  const Module = await loadModule();

  return function solveShell(mesh, material, bcs) {
    const result = Module.solve_shell(
      {
        vertices: Float64Array.from(mesh.vertices.flat()),
        triangles: Int32Array.from(mesh.triangles.flat()),
        thicknesses: Float64Array.from(mesh.thicknesses ?? []),
      },
      JSON.stringify(material),
      JSON.stringify({
        fixed_vertices: bcs.fixed_vertices ?? [],
        fixed_dofs: bcs.fixed_dofs ?? [],
        prescribed_dofs: bcs.prescribed_dofs ?? [],
        point_loads: bcs.point_loads ?? [],
      }),
    );
    if ("error" in result) throw new Error(result.error);
    return {
      displacements: Array.from(result.displacements),
      von_mises: Array.from(result.von_mises),
    };
  };
}
