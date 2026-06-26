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
 * solve(mesh, material, bcs, order?) mirrors solve_linear_elastic:
 *   mesh:     { vertices:[[x,y,z]...], tetrahedra:[[..4]...], hexahedra:[[..8]...] }
 *   material: { young_modulus, poisson_ratio, density? }
 *   bcs:      { fixed_vertices:[v...],
 *               fixed_dofs:[{vertex,dofs:[0|1|2,...]}...],   // single-DOF (new)
 *               prescribed_dofs:[{vertex,dof:0|1|2,value}...], // non-zero Dirichlet
 *               point_loads:[{vertex, force:[fx,fy,fz]}...] }
 *   order:    FE polynomial order (default 1; order 2 is unreliable with the
 *             engine's loose CG tolerance — keep validation cases at order 1).
 * Returns { displacements:number[] (3/node), von_mises:number[] (1/elem) }.
 */
export async function loadSolver() {
  const wasmBinary = readFileSync(join(pkg, "kofem_wasm_emcc.wasm")).buffer;
  const { default: createModule } = await import(
    join(pkg, "kofem_wasm_emcc.js")
  );
  const Module = await createModule({
    wasmBinary,
    print: () => {},
    printErr: () => {},
  });

  return function solve(mesh, material, bcs, order = 1) {
    const meshJson = JSON.stringify({
      vertices: mesh.vertices,
      tetrahedra: mesh.tetrahedra ?? [],
      hexahedra: mesh.hexahedra ?? [],
    });
    const bcsJson = JSON.stringify({
      fixed_vertices: bcs.fixed_vertices ?? [],
      fixed_dofs: bcs.fixed_dofs ?? [],
      prescribed_dofs: bcs.prescribed_dofs ?? [],
      point_loads: bcs.point_loads ?? [],
    });
    return JSON.parse(
      Module.solve_linear_elastic(
        meshJson,
        JSON.stringify(material),
        bcsJson,
        order,
      ),
    );
  };
}
