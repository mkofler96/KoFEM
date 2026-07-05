// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Wall Bracket solve test — runs the full WASM pipeline in Node.js.
// STEP → tessellate (OCC) → FEM mesh (Netgen) → linear-elastic solve (MFEM)
//
// No error handling: any failure surfaces immediately as a raw Node.js error.
// Usage:  bun tests/test_wall_bracket.mjs [max_element_size]   (from the web/ directory)

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const maxElementSize = parseFloat(process.argv[2] ?? "20.0");

const wasmPkg = join(__dirname, "../src/wasm/pkg");
const wasmBinary = readFileSync(join(wasmPkg, "kofem_wasm_emcc.wasm")).buffer;

const { default: createModule } = await import(
  join(wasmPkg, "kofem_wasm_emcc.js")
);
const makeModule = () =>
  createModule({
    wasmBinary,
    print: (t) => console.log("[wasm]", t),
    printErr: (t) => console.error("[wasm:err]", t),
  });

// Meshing and solving run in SEPARATE module instances, mirroring production:
// Netgen's Ng_Init installs global C++ state that contaminates the WASM runtime
// for a subsequent MFEM solve in the same module, so the browser tears the
// worker down between mesh and solve (resetWorker in
// web/src/components/panel/LeftPanel.tsx). Sharing one module here left the
// Netgen→MFEM hand-off sensitive to the binary's memory layout — an unrelated
// engine.cpp change could shift it enough to trap in FinalizeTopology.
const Module = await makeModule();

const stepBytes = new Uint8Array(
  readFileSync(join(__dirname, "../../test_files/Wall Bracket.stp")),
);
console.log(
  `\nWall bracket: ${stepBytes.length} bytes, max_element_size=${maxElementSize}\n`,
);

// 1. Tessellate (stores OCC shape in WASM for the mesher).
// Returns flat typed arrays (Float32 vertices xyz-interleaved, Uint32 indices),
// not a JSON string; deflection_relative mirrors solver.worker.ts.
const tess = Module.tessellate_step(
  stepBytes,
  JSON.stringify({ deflection_relative: 0.001, angular_deflection: 0.5 }),
);
console.log(
  `tessellate_step:  ${tess.vertices.length / 3} vertices, ${tess.triangles.length / 3} triangles`,
);

// 2. FEM mesh via Netgen OCC.
// Returns flat typed arrays (Float64 vertices xyz-interleaved, Int32 indices),
// not a JSON string (issue #166).
const mesh = Module.generate_fem_mesh(
  JSON.stringify({
    // min_element_size floors curvature refinement — same default as solver.worker.ts
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
const nNodes = mesh.vertices.length / 3;
console.log(
  `generate_fem_mesh: ${nNodes} nodes, ${mesh.tetrahedra.length / 4} tetrahedra`,
);
Module.free_geometry_cache();

// 3. Solve in a fresh module — a clean WASM instance with no Netgen global
// state, exactly as the browser does after resetWorker(). The mesh crosses
// the boundary as flat typed arrays; the result comes back the same way.
const SolveModule = await makeModule();
const result = SolveModule.solve_linear_elastic(
  {
    vertices: mesh.vertices,
    tetrahedra: mesh.tetrahedra,
    hexahedra: new Int32Array(0),
  },
  JSON.stringify({ young_modulus: 210e9, poisson_ratio: 0.3 }),
  JSON.stringify({
    fixed_vertices: Array.from({ length: Math.min(10, nNodes) }, (_, i) => i),
    point_loads: [{ vertex: nNodes - 1, force: [0, -10000, 0] }],
  }),
  1,
);
if ("error" in result) throw new Error(result.error);

console.log(
  `solve_linear_elastic: ${result.displacements.length / 3} nodes solved`,
);
let maxVm = 0;
for (const vm of result.von_mises) maxVm = Math.max(maxVm, vm);
console.log(`max von Mises: ${maxVm.toExponential(3)} Pa`);
console.log("\nPASS");
