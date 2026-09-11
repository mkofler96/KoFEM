// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Loads the committed KoFEM WASM engine and exposes a thin optimize() wrapper
// over the `optimize_topology` Embind entry (KOF-231).
//
// This is the node counterpart of what the browser worker
// (web/src/workers/solver.worker.ts → handleTopOpt) drives: the same SIMP
// minimum-compliance loop (KOF-230) runs inside the real WASM engine, so the
// benchmark cases in ../cases exercise the shipped optimizer, not a
// re-implementation. It mirrors ../../lib/solver.mjs's "run the WASM under node"
// pattern, and takes the same mesh/material/BC shapes the linear-elastic
// solve() does plus the topology-optimization settings block.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = join(here, "../../../../web/src/wasm/pkg");

/**
 * Initialise the WASM engine once and return an optimize() closure.
 *
 * optimize(mesh, materials, bcs, settings) mirrors optimize_topology (nested
 * tuples here are flattened to the engine's typed arrays):
 *   mesh:      { vertices:[[x,y,z]...], tetrahedra?:[[..4]...],
 *                hexahedra?:[[..8]...] }  (the benchmarks use hex-only meshes, so
 *                the returned per-element density is in input hexahedra order)
 *   materials: [{ young_modulus, poisson_ratio, density? }...]  (single-material
 *                here; the engine applies the first to every element)
 *   bcs:       { fixed_vertices?:[v...],
 *                fixed_dofs?:[{vertex, dofs:[0|1|2,...]}...],
 *                prescribed_dofs?:[{vertex, dof, value}...],
 *                point_loads?:[{vertex, force:[fx,fy,fz]}...],
 *                surface_loads?:[...] }   — identical to the solve BC shape
 *   settings:  TopOptSettings (objective, constraints.volumeFraction, penalty,
 *                filterRadius, moveLimit, maxIterations, tolerance) — see
 *                web/src/wasm/pkg/kofem_wasm.d.ts.
 *
 * Returns { density:number[] (one per element, solve/element order),
 *           history:[{ it, objective, volume, max_change }...],
 *           converged:boolean (stopped on the tolerance, not max_iterations),
 *           logs:string[] (the streamed "[topopt] it N: …" progress lines) }.
 */
export async function loadOptimizer() {
  const logs = [];
  const Module = await loadModule((line) => logs.push(line));

  return function optimize(mesh, materials, bcs, settings) {
    logs.length = 0;
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
    const result = Module.optimize_topology(
      meshArrays,
      JSON.stringify(materials),
      bcsJson,
      JSON.stringify(settings),
    );
    if ("error" in result) throw new Error(result.error);
    const history = result.history.map((h) => ({ ...h }));
    return {
      density: Array.from(result.density),
      history,
      // The JS boundary returns only { density, history }; the loop stops early
      // only on the convergence tolerance, so fewer iterations than the budget
      // means it converged (it never short-circuits for any other reason).
      converged: history.length < settings.maxIterations,
      logs: [...logs],
    };
  };
}

async function loadModule(onLog) {
  const wasmBinary = readFileSync(join(pkg, "kofem_wasm_emcc.wasm")).buffer;
  const { default: createModule } = await import(
    join(pkg, "kofem_wasm_emcc.js")
  );
  return createModule({
    wasmBinary,
    print: (line) => onLog(line),
    printErr: () => {},
  });
}
