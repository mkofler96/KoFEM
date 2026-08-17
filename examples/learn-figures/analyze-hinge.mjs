// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Hinge-bracket stiffness study behind /learn/hinge-bracket-stiffness/.
//
// Runs the full pipeline on web/public/examples/scharnier.igs once per mesh
// size and element order, and prints the stiffness k_w = F_w / w. Every number
// in that article — the convergence table and both curves in the plot — comes
// out of this script, so the article stays checkable against the engine.
//
// The boundary conditions come from the original exercise sketch:
//   fixed : the mounting plate's seating face (OCC face 6, y = -20 mm)
//   load  : F_w in +z spread over the eye bore (OCC faces 22 and 25)
// Material is steel in the canonical N-mm-MPa system: E = 210000 MPa, nu = 0.3.
//
// Usage (from web/):  bun ../examples/learn-figures/analyze-hinge.mjs
//                     bun ../examples/learn-figures/analyze-hinge.mjs 5 2
// with optional [max_element_size] [element_order] to run a single point.

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const wasmPkg = join(__dirname, "../../web/src/wasm/pkg");
const IGES = join(__dirname, "../../web/public/examples/scharnier.igs");

const F_W = 1000.0; // N — magnitude is arbitrary, the problem is linear
const CLAMP_FACE = 6;
const BORE_FACES = new Set([22, 25]);

// The sweep the article publishes. Linear elements are carried further because
// they are still drifting where the quadratic ones have already settled.
const SWEEP = [
  ...[10, 8, 6, 5, 4, 3, 2.5, 2].map((h) => ({ h, order: 1 })),
  ...[10, 8, 6, 5, 4].map((h) => ({ h, order: 2 })),
];

const wasmBinary = readFileSync(join(wasmPkg, "kofem_wasm_emcc.wasm")).buffer;
const { default: createModule } = await import(
  join(wasmPkg, "kofem_wasm_emcc.js")
);
const verbose = Boolean(process.env.VERBOSE);
const makeModule = () =>
  createModule({
    wasmBinary,
    print: verbose ? (t) => console.log("[wasm]", t) : () => {},
    printErr: (t) => console.error("[wasm:err]", t),
  });

const igesBytes = new Uint8Array(readFileSync(IGES));

async function run(maxElementSize, order) {
  // Meshing and solving run in SEPARATE module instances, mirroring production:
  // Netgen's global state contaminates a subsequent MFEM solve in the same
  // module, which is why the browser tears the worker down between the two.
  const meshModule = await makeModule();
  meshModule.tessellate_step(
    igesBytes,
    JSON.stringify({
      format: "iges",
      deflection_relative: 0.001,
      angular_deflection: 0.5,
    }),
  );
  const mesh = meshModule.generate_fem_mesh(
    JSON.stringify({
      max_element_size: maxElementSize,
      min_element_size: maxElementSize / 10,
      grading: 0.3,
      second_order: false,
      elementsperedge: 2.0,
      elementspercurve: 2.0,
      optsteps_2d: 3,
      optsteps_3d: 3,
    }),
  );
  meshModule.free_geometry_cache();

  // Turn the two CAD faces into a node set (the clamp) and a triangle list
  // (the loaded surface). Boundary conditions are tied to CAD faces, not to
  // node indices, so they survive re-meshing at a different element size.
  const faceIds = mesh.surfaceFaceIds;
  const tris = mesh.surfaceTriangles;
  const fixed = new Set();
  const loadTriangles = [];
  const boreNodes = new Set();
  for (let t = 0; t < tris.length / 3; t++) {
    const tri = [tris[3 * t], tris[3 * t + 1], tris[3 * t + 2]];
    if (faceIds[t] === CLAMP_FACE) for (const n of tri) fixed.add(n);
    if (BORE_FACES.has(faceIds[t])) {
      loadTriangles.push(tri);
      for (const n of tri) boreNodes.add(n);
    }
  }
  if (fixed.size === 0 || loadTriangles.length === 0)
    throw new Error(
      `boundary faces not found in the mesh (clamp nodes=${fixed.size}, ` +
        `load triangles=${loadTriangles.length}) — the OCC face numbering changed`,
    );

  const solveModule = await makeModule();
  const result = solveModule.solve_linear_elastic(
    {
      vertices: mesh.vertices,
      tetrahedra: mesh.tetrahedra,
      hexahedra: new Int32Array(0),
    },
    JSON.stringify({ young_modulus: 210000, poisson_ratio: 0.3 }),
    JSON.stringify({
      fixed_vertices: [...fixed],
      point_loads: [],
      surface_loads: [
        { type: "force", force: [0, 0, F_W], faces: loadTriangles },
      ],
    }),
    order,
  );
  if ("error" in result) throw new Error(result.error);

  // w is the mean +z displacement of the bore surface: averaging over the
  // loaded face keeps the answer independent of where individual nodes landed.
  const d = result.displacements;
  let wSum = 0;
  for (const n of boreNodes) wSum += d[3 * n + 2];
  const w = wSum / boreNodes.size;

  let maxVonMises = 0;
  for (const vm of result.von_mises) maxVonMises = Math.max(maxVonMises, vm);

  return {
    maxElementSize,
    order,
    nodes: mesh.vertices.length / 3,
    tetrahedra: mesh.tetrahedra.length / 4,
    w,
    k: F_W / w,
    maxVonMises,
  };
}

const [argH, argOrder] = process.argv.slice(2);
const points = argH
  ? [{ h: parseFloat(argH), order: parseInt(argOrder ?? "1", 10) }]
  : SWEEP;

console.log(
  `hinge bracket: F_w = ${F_W} N in +z, steel E = 210000 MPa, nu = 0.3\n`,
);
const rows = [];
for (const { h, order } of points) {
  const r = await run(h, order);
  rows.push(r);
  console.log(
    `order=${r.order}  h=${String(r.maxElementSize).padStart(4)} mm  ` +
      `${String(r.nodes).padStart(6)} nodes / ${String(r.tetrahedra).padStart(6)} tets  ` +
      `w=${r.w.toFixed(5)} mm  k_w=${r.k.toFixed(1)} N/mm  ` +
      `vM_max=${r.maxVonMises.toFixed(1)} MPa`,
  );
}

for (const order of [1, 2]) {
  const ks = rows.filter((r) => r.order === order).map((r) => r.k);
  if (ks.length < 2) continue;
  const lo = Math.min(...ks);
  const hi = Math.max(...ks);
  console.log(
    `\norder ${order}: k_w spans ${lo.toFixed(0)}–${hi.toFixed(0)} N/mm ` +
      `(${(((hi - lo) / lo) * 100).toFixed(1)} % across the sweep)`,
  );
}
