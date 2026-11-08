// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Mesh a STEP file with the C++ engine (OCCT + Netgen) and write the volume
// mesh as raw little-endian arrays for preconditioner_sweep.rs:
// <out>.verts (f64 x,y,z per node) and <out>.tets (u32, four per tet).
//
// Usage (from the repo root, after `cd web && bun run wasm:fetch`):
//   bun crates/kofem-fem/examples/dump_mesh.mjs <step> <size> <out>
// <size> is the maximum element size in model units, or "r<f>" for a
// fraction f of the bounding-box diagonal (e.g. r0.01).

import { readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const [stepPath, sizeArg, out] = process.argv.slice(2);
if (!stepPath || !sizeArg || !out)
  throw new Error("usage: dump_mesh.mjs <step> <size|r<fraction>> <out>");
const pkg = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../web/src/wasm/pkg",
);
const { default: createModule } = await import(join(pkg, "kofem_wasm_emcc.js"));
// The engine's own log is kept back and shown only if meshing fails, so a
// successful run prints just the summary line.
const engineLog = [];
const engine = await createModule({
  wasmBinary: readFileSync(join(pkg, "kofem_wasm_emcc.wasm")).buffer,
  print: (line) => engineLog.push(line),
  printErr: (line) => engineLog.push(line),
});
process.on("exit", (code) => {
  if (code !== 0) console.error(engineLog.join("\n"));
});
const tessellation = engine.tessellate_step(
  new Uint8Array(readFileSync(stepPath)),
  JSON.stringify({ deflection_relative: 0.001, angular_deflection: 0.5 }),
);
const low = [Infinity, Infinity, Infinity];
const high = [-Infinity, -Infinity, -Infinity];
tessellation.vertices.forEach((value, index) => {
  low[index % 3] = Math.min(low[index % 3], value);
  high[index % 3] = Math.max(high[index % 3], value);
});
const diagonal = Math.hypot(...high.map((value, axis) => value - low[axis]));
const size = sizeArg.startsWith("r")
  ? diagonal * Number(sizeArg.slice(1))
  : Number(sizeArg);
if (!(size > 0)) throw new Error(`invalid element size "${sizeArg}"`);
// Same mesher settings as test_wall_bracket.mjs / solver.worker.ts.
const mesh = engine.generate_fem_mesh(
  JSON.stringify({
    max_element_size: size,
    min_element_size: size / 10,
    grading: 0.3,
    second_order: false,
    elementsperedge: 2.0,
    elementspercurve: 2.0,
    optsteps_2d: 3,
    optsteps_3d: 3,
  }),
);
writeFileSync(
  `${out}.verts`,
  Buffer.from(new Float64Array(mesh.vertices).buffer),
);
writeFileSync(
  `${out}.tets`,
  Buffer.from(new Uint32Array(mesh.tetrahedra).buffer),
);
console.log(
  `${out}: element size ${size.toFixed(3)}, ${mesh.vertices.length / 3} nodes, ` +
    `${mesh.tetrahedra.length / 4} tets`,
);
