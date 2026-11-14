// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Node harness for the shell + coupled topology-optimization showcases
// (KOF-237): the app's Rust optimizer (web/src/lib/solve/topOptRust.ts →
// optimizeShellInRust, optimizeCoupledInRust), fed the inputs the worker builds
// for it, so these scripts drive the SHIPPED optimizer rather than a
// re-implementation.

import {
  optimizeCoupledInRust,
  optimizeShellInRust,
} from "../../web/src/lib/solve/topOptRust.ts";
import { rustFem } from "../validation/lib/solver.mjs";

// The Rust module and the log sink; `onLog` receives every "[topopt] it N: …"
// line.
export async function loadOptimizer(onLog = () => {}) {
  return { fem: await rustFem(), onLog };
}

// A structured triangle mesh of the square [0,a]×[0,a] in the z=0 plane, n×n
// cells (2 triangles each). `id(i,j)` is the corner-node index; the returned
// `triangles` order is the density order the shell optimizer reports.
export function plateMesh(a, n) {
  const id = (i, j) => i * (n + 1) + j;
  const vertices = [];
  for (let i = 0; i <= n; i++)
    for (let j = 0; j <= n; j++) vertices.push([(a * i) / n, (a * j) / n, 0]);
  const triangles = [];
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++) {
      triangles.push([id(i, j), id(i + 1, j), id(i + 1, j + 1)]);
      triangles.push([id(i, j), id(i + 1, j + 1), id(i, j + 1)]);
    }
  return { vertices, triangles, id, n, a };
}

// The shell optimizer. mesh = { vertices:[[x,y,z]...], triangles:[[a,b,c]...],
// thicknesses?:[...] }; mat = { young_modulus, poisson_ratio, thickness };
// bcs = { fixed_vertices?, fixed_dofs?, point_loads? }.
export function optimizeShell(optimizer, mesh, mat, bcs, settings) {
  const meshArrays = {
    vertices: Float64Array.from(mesh.vertices.flat()),
    triangles: Int32Array.from(mesh.triangles.flat()),
  };
  if (mesh.thicknesses)
    meshArrays.thicknesses = Float64Array.from(mesh.thicknesses);
  const result = optimizeShellInRust(
    optimizer.fem,
    {
      mesh: meshArrays,
      matJson: JSON.stringify(mat),
      bcsJson: JSON.stringify({
        fixed_vertices: bcs.fixed_vertices ?? [],
        fixed_dofs: bcs.fixed_dofs ?? [],
        point_loads: bcs.point_loads ?? [],
      }),
    },
    settings,
    optimizer.onLog,
    () => {}, // no live density stream (KOF-240)
  );
  return finalize(result, settings);
}

// The coupled optimizer. mesh = { vertices, tets:[[..4]...],
// triangles:[[..3]...], thicknesses?, attributes? }; coupling CSR = { ref,
// offsets, solid, mpc, dof_mask, relaxation }; bcs = { fixed_dofs, load_dofs,
// load_vals };
// mat = { solid:{...}, shell:{...} }. Density is [tets…, facets…] order.
export function optimizeCoupled(optimizer, mesh, coupling, bcs, mat, settings) {
  const meshArrays = {
    vertices: Float64Array.from(mesh.vertices.flat()),
    tets: Int32Array.from(mesh.tets.flat()),
    triangles: Int32Array.from(mesh.triangles.flat()),
  };
  if (mesh.thicknesses)
    meshArrays.thicknesses = Float64Array.from(mesh.thicknesses);
  if (mesh.attributes)
    meshArrays.attributes = Int32Array.from(mesh.attributes);
  const couplingArrays = {
    ref: Int32Array.from(coupling.ref),
    offsets: Int32Array.from(coupling.offsets),
    solid: Int32Array.from(coupling.solid),
    mpc: Int32Array.from(coupling.mpc),
    dof_mask: Int32Array.from(coupling.dof_mask),
    relaxation: coupling.relaxation,
  };
  const result = optimizeCoupledInRust(
    optimizer.fem,
    {
      mesh: meshArrays,
      coupling: couplingArrays,
      bcs: {
        fixed_dofs: Int32Array.from(bcs.fixed_dofs),
        load_dofs: Int32Array.from(bcs.load_dofs),
        load_vals: Float64Array.from(bcs.load_vals),
        // The showcase prescribes no non-zero displacement.
        prescribed_dofs: new Int32Array(0),
        prescribed_vals: new Float64Array(0),
      },
      matJson: JSON.stringify(mat),
    },
    settings,
    optimizer.onLog,
    () => {}, // no live density stream (KOF-240)
  );
  return finalize(result, settings);
}

function finalize(result, settings) {
  const history = result.history.map((h) => ({ ...h }));
  const last = history[history.length - 1];
  return {
    density: Array.from(result.density),
    history,
    converged: last !== undefined && last.max_change < settings.tolerance,
  };
}

// Population statistics of a density field: solid (ρ>0.9) / void (ρ<0.1) counts,
// mean and standard deviation. A stalled "uniform gray" run has std ≈ 0; a real
// topology spreads toward both extremes.
export function densityStats(density) {
  const n = density.length;
  let solid = 0;
  let empty = 0;
  let mean = 0;
  for (const r of density) {
    mean += r;
    if (r > 0.9) solid++;
    if (r < 0.1) empty++;
  }
  mean /= n;
  let variance = 0;
  for (const r of density) variance += (r - mean) ** 2;
  return { solid, void: empty, mean, std: Math.sqrt(variance / n) };
}
