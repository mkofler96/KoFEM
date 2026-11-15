// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// A thin optimize() wrapper over the app's topology optimizer
// (web/src/lib/solve/topOptRust.ts → optimizeSolidInRust), the one the
// browser worker's handleTopOpt runs on a solid design domain. The benchmark
// cases in ../cases exercise the shipped optimizer, not a re-implementation.
// It takes the same mesh/material/BC shapes as ../../lib/solver.mjs's solve()
// plus the topology-optimization settings block.

import { optimizeSolidInRust } from "../../../../web/src/lib/solve/topOptRust.ts";
import { rustFem, storeModel } from "../../lib/solver.mjs";

/**
 * Load the Rust module once and return an optimize() closure.
 *
 * optimize(mesh, materials, bcs, settings):
 *   mesh:      { vertices:[[x,y,z]...], tetrahedra?:[[..4]...],
 *                hexahedra?:[[..8]...] }  (the benchmarks use hex-only meshes, so
 *                the returned per-element density is in input hexahedra order)
 *   materials: [{ young_modulus, poisson_ratio, density? }]  (one material)
 *   bcs:       { fixed_vertices?:[v...],
 *                fixed_dofs?:[{vertex, dofs:[0|1|2,...]}...],
 *                prescribed_dofs?:[{vertex, dof, value}...],
 *                point_loads?:[{vertex, force:[fx,fy,fz]}...],
 *                surface_loads?:[...] }   — identical to the solve BC shape
 *   settings:  TopOptSettings (objective, constraints.volumeFraction, penalty,
 *                filterRadius, moveLimit, maxIterations, tolerance).
 *
 * Returns { density:number[] (one per element, tets then hexes),
 *           history:[{ it, objective, volume, max_change }...],
 *           converged:boolean (stopped on the tolerance, not max_iterations),
 *           logs:string[] (the "[topopt] it N: …" progress lines) }.
 */
export async function loadOptimizer() {
  const fem = await rustFem();

  return function optimize(mesh, materials, bcs, settings) {
    if (materials.length !== 1)
      throw new Error(
        `optimize: the benchmarks use one material, got ${materials.length}`,
      );
    const logs = [];
    const result = optimizeSolidInRust(
      fem,
      { ...storeModel(mesh, materials[0], bcs), settings },
      (line) => logs.push(line),
      () => {}, // no live density stream (KOF-240)
    );
    const history = result.history.map((h) => ({ ...h }));
    const last = history[history.length - 1];
    return {
      density: Array.from(result.density),
      history,
      // A run is converged exactly when the last iteration's max|Δρ| fell
      // below the tolerance, tested before the iteration cap, so a run that
      // converges on the very last allowed iteration still counts.
      converged: last !== undefined && last.max_change < settings.tolerance,
      logs,
    };
  };
}
