// Wall Bracket solve test — runs the full WASM pipeline in Node.js.
// STEP → tessellate (OCC) → FEM mesh (Netgen) → linear-elastic solve (MFEM)
//
// No error handling: any failure surfaces immediately as a raw Node.js error.
// Usage:  node test_wall_bracket.mjs [max_element_size]

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const maxElementSize = parseFloat(process.argv[2] ?? "20.0");

const wasmPkg = join(__dirname, "web/src/wasm/pkg");
const wasmBinary = readFileSync(join(wasmPkg, "kofem_wasm_emcc.wasm")).buffer;

const { default: createModule } = await import(
  join(wasmPkg, "kofem_wasm_emcc.js")
);
const Module = await createModule({
  wasmBinary,
  print: (t) => console.log("[wasm]", t),
  printErr: (t) => console.error("[wasm:err]", t),
});

const stepBytes = new Uint8Array(
  readFileSync(join(__dirname, "test_files/Wall Bracket.stp")),
);
console.log(
  `\nWall bracket: ${stepBytes.length} bytes, max_element_size=${maxElementSize}\n`,
);

// 1. Tessellate (stores OCC shape in WASM for the mesher)
const tess = JSON.parse(
  Module.tessellate_step(
    stepBytes,
    JSON.stringify({ linear_deflection: 0.1, angular_deflection: 0.5 }),
  ),
);
console.log(
  `tessellate_step:  ${tess.vertices.length} vertices, ${tess.triangles.length} triangles`,
);

// 2. FEM mesh via Netgen OCC
const mesh = JSON.parse(
  Module.generate_fem_mesh(
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
  ),
);
console.log(
  `generate_fem_mesh: ${mesh.vertices.length} nodes, ${mesh.tetrahedra.length} tetrahedra`,
);
Module.free_geometry_cache();

// 3. Solve — no try/catch; WASM traps and solver errors propagate as-is
const result = JSON.parse(
  Module.solve_linear_elastic(
    JSON.stringify({
      vertices: mesh.vertices,
      tetrahedra: mesh.tetrahedra,
      hexahedra: [],
    }),
    JSON.stringify({ young_modulus: 210e9, poisson_ratio: 0.3 }),
    JSON.stringify({
      fixed_vertices: Array.from(
        { length: Math.min(10, mesh.vertices.length) },
        (_, i) => i,
      ),
      point_loads: [
        { vertex: mesh.vertices.length - 1, force: [0, -10000, 0] },
      ],
    }),
    1,
  ),
);

console.log(
  `solve_linear_elastic: ${result.displacements.length / 3} nodes solved`,
);
console.log(
  `max von Mises: ${Math.max(...result.von_mises).toExponential(3)} Pa`,
);
console.log("\nPASS");
