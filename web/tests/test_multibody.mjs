// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Multibody assembly test (#317/#353) — runs the full WASM pipeline in Node.js
// on test_files/two_boxes.stp: two 20×10×10 boxes written as independent
// solids that touch on the full 10×10 face at x=20.
//
// Verifies:
//   1. import reports two bodies (bodyCount)
//   2. touching faces are imprinted → ONE conforming mesh: the interface nodes
//      are shared (no duplicated coordinates), tets carry per-body ids {1, 2}
//   3. per-body materials reach the solve: softening one body's E makes the
//      cantilever tip deflection strictly larger
//
// No error handling: any failure surfaces immediately as a raw Node.js error.
// Usage:  bun tests/test_multibody.mjs   (from the web/ directory)

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));

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

function assert(cond, msg) {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}

// Mesh and solve run in separate module instances, mirroring production
// (see test_wall_bracket.mjs for the Netgen-global-state rationale).
const Module = await makeModule();

const stepBytes = new Uint8Array(
  readFileSync(join(__dirname, "../../test_files/two_boxes.stp")),
);
console.log(`\nTwo-box assembly: ${stepBytes.length} bytes\n`);

// 1. Import: two bodies expected.
const tess = Module.tessellate_step(
  stepBytes,
  JSON.stringify({ deflection_relative: 0.001, angular_deflection: 0.5 }),
);
console.log(
  `tessellate_step:  ${tess.vertices.length / 3} vertices, ${tess.triangles.length / 3} triangles, ${tess.bodyCount} bodies`,
);
assert(tess.bodyCount === 2, `expected bodyCount 2, got ${tess.bodyCount}`);

// 2. Mesh: conforming across the imprinted interface, per-tet body ids.
const mesh = Module.generate_fem_mesh(
  JSON.stringify({
    max_element_size: 5.0,
    min_element_size: 0.5,
    grading: 0.3,
    second_order: false,
    elementsperedge: 2.0,
    elementspercurve: 2.0,
    optsteps_2d: 3,
    optsteps_3d: 3,
  }),
);
Module.free_geometry_cache();
const nNodes = mesh.vertices.length / 3;
const nTets = mesh.tetrahedra.length / 4;
console.log(`generate_fem_mesh: ${nNodes} nodes, ${nTets} tetrahedra`);

assert(
  mesh.bodyIds.length === nTets,
  `bodyIds length ${mesh.bodyIds.length} != tet count ${nTets}`,
);
const bodyTets = new Map();
for (const id of mesh.bodyIds) bodyTets.set(id, (bodyTets.get(id) ?? 0) + 1);
console.log(
  `bodies in mesh: ${[...bodyTets.entries()].map(([b, n]) => `body ${b}: ${n} tets`).join(", ")}`,
);
assert(
  bodyTets.size === 2 && bodyTets.has(1) && bodyTets.has(2),
  `expected tets in bodies {1, 2}, got {${[...bodyTets.keys()].sort().join(", ")}}`,
);

// Conforming interface: were the bodies meshed independently, every interface
// node would exist twice (one copy per body) at identical coordinates.
const seen = new Set();
for (let i = 0; i < nNodes; i++) {
  const key = `${mesh.vertices[3 * i].toFixed(6)},${mesh.vertices[3 * i + 1].toFixed(6)},${mesh.vertices[3 * i + 2].toFixed(6)}`;
  assert(
    !seen.has(key),
    `duplicated node at (${key}) — interface not conforming`,
  );
  seen.add(key);
}
// …and the shared face at x=20 must have nodes referenced by tets of BOTH bodies.
const nodeBodies = new Map();
for (let tet = 0; tet < nTets; tet++)
  for (let corner = 0; corner < 4; corner++) {
    const vertex = mesh.tetrahedra[4 * tet + corner];
    if (!nodeBodies.has(vertex)) nodeBodies.set(vertex, new Set());
    nodeBodies.get(vertex).add(mesh.bodyIds[tet]);
  }
let nInterfaceNodes = 0;
for (const [vertex, bodies] of nodeBodies)
  if (bodies.size === 2) {
    assert(
      Math.abs(mesh.vertices[3 * vertex] - 20.0) < 1e-6,
      `node ${vertex} shared by both bodies but at x=${mesh.vertices[3 * vertex]}, not on the interface plane x=20`,
    );
    nInterfaceNodes++;
  }
console.log(`conforming interface: ${nInterfaceNodes} shared nodes at x=20`);
assert(
  nInterfaceNodes > 0,
  "no nodes shared between the two bodies — interface not bonded",
);

// 3. Solve as a cantilever: clamp the x=0 face, load the x=40 tip face down.
//    Per-tet material attributes come straight from the body ids because
//    material k is assigned to body k here.
const fixed_vertices = [];
const tipLoads = [];
for (let i = 0; i < nNodes; i++) {
  const xCoord = mesh.vertices[3 * i];
  if (Math.abs(xCoord) < 1e-6) fixed_vertices.push(i);
  if (Math.abs(xCoord - 40.0) < 1e-6)
    tipLoads.push({ vertex: i, force: [0, -100, 0] });
}
assert(fixed_vertices.length > 0, "no nodes found on the clamp face x=0");
assert(tipLoads.length > 0, "no nodes found on the tip face x=40");
const bcs = JSON.stringify({ fixed_vertices, point_loads: tipLoads });

const solveOnce = async (materials) => {
  const SolveModule = await makeModule();
  const result = SolveModule.solve_linear_elastic(
    {
      vertices: mesh.vertices,
      tetrahedra: mesh.tetrahedra,
      hexahedra: new Int32Array(0),
      attributes: mesh.bodyIds,
    },
    JSON.stringify(materials),
    bcs,
    1,
  );
  if ("error" in result) throw new Error(result.error);
  let maxDefl = 0;
  for (let i = 0; i < nNodes; i++)
    maxDefl = Math.max(maxDefl, Math.abs(result.displacements[3 * i + 1]));
  for (const vm of result.von_mises)
    assert(Number.isFinite(vm), "non-finite von Mises stress");
  return maxDefl;
};

const steel = { young_modulus: 210000, poisson_ratio: 0.3 };
const soft = { young_modulus: 21000, poisson_ratio: 0.3 };

const deflSame = await solveOnce([steel, steel]);
console.log(`max |uy|, steel + steel: ${deflSame.toExponential(4)} mm`);
const deflSoft = await solveOnce([steel, soft]);
console.log(`max |uy|, steel + soft tip: ${deflSoft.toExponential(4)} mm`);

assert(
  Number.isFinite(deflSame) && deflSame > 0,
  "steel/steel solve produced no deflection",
);
assert(
  deflSoft > 1.5 * deflSame,
  `softening body 2 must increase tip deflection: ${deflSoft} vs ${deflSame} — per-body materials are not reaching the solve`,
);

console.log("\nPASS");
