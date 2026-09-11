// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Node harness for the shell + coupled topology-optimization showcases
// (KOF-237). Loads the committed KoFEM WASM engine and wraps the two Phase-B
// Embind entries — optimize_topology_shell and optimize_topology_coupled — the
// same way examples/validation/topopt/lib/optimize.mjs wraps the solid entry, so
// these scripts drive the SHIPPED optimizer rather than a re-implementation.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = join(here, "../../web/src/wasm/pkg");

// Load the WASM engine once; `onLog` receives every "[topopt] it N: …" line.
export async function loadEngine(onLog = () => {}) {
  const wasmBinary = readFileSync(join(pkg, "kofem_wasm_emcc.wasm")).buffer;
  const { default: createModule } = await import(
    join(pkg, "kofem_wasm_emcc.js")
  );
  return createModule({ wasmBinary, print: onLog, printErr: () => {} });
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

// optimize_topology_shell wrapper. mesh = { vertices:[[x,y,z]...],
// triangles:[[a,b,c]...], thicknesses?:[...] }; mat = { young_modulus,
// poisson_ratio, thickness }; bcs = { fixed_vertices?, fixed_dofs?, point_loads? }.
export function optimizeShell(Module, mesh, mat, bcs, settings) {
  const meshArrays = {
    vertices: Float64Array.from(mesh.vertices.flat()),
    triangles: Int32Array.from(mesh.triangles.flat()),
  };
  if (mesh.thicknesses)
    meshArrays.thicknesses = Float64Array.from(mesh.thicknesses);
  const result = Module.optimize_topology_shell(
    meshArrays,
    JSON.stringify(mat),
    JSON.stringify({
      fixed_vertices: bcs.fixed_vertices ?? [],
      fixed_dofs: bcs.fixed_dofs ?? [],
      point_loads: bcs.point_loads ?? [],
    }),
    JSON.stringify(settings),
  );
  if ("error" in result) throw new Error(result.error);
  return finalize(result, settings);
}

// optimize_topology_coupled wrapper. mesh = { vertices, tets:[[..4]...],
// triangles:[[..3]...], thicknesses?, attributes? }; coupling CSR = { ref,
// offsets, solid, mpc?, relaxation? }; bcs = { fixed_dofs, load_dofs, load_vals };
// mat = { solid:{...}, shell:{...} }. Density is [tets…, facets…] order.
export function optimizeCoupled(Module, mesh, coupling, bcs, mat, settings) {
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
  };
  if (coupling.mpc) couplingArrays.mpc = Int32Array.from(coupling.mpc);
  if (coupling.relaxation !== undefined)
    couplingArrays.relaxation = coupling.relaxation;
  const result = Module.optimize_topology_coupled(
    meshArrays,
    couplingArrays,
    {
      fixed_dofs: Int32Array.from(bcs.fixed_dofs),
      load_dofs: Int32Array.from(bcs.load_dofs),
      load_vals: Float64Array.from(bcs.load_vals),
    },
    JSON.stringify(mat),
    JSON.stringify(settings),
  );
  if ("error" in result) throw new Error(result.error);
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
