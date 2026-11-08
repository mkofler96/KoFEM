// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// The app's all-solid solve through the Rust AMG solver must give the same
// result as through the MFEM engine. Both take the SAME store model, built
// into solver inputs by the app's own helpers (buildSolidEngineInputs for MFEM,
// solveSolidWithAmg for Rust), on a real Netgen mesh of the wall bracket.
//
// The model exercises everything the AMG path supports: two bodies with
// different materials, a clamped end, a roller, a prescribed displacement, a
// point load, a pressure and a total-force surface load. Node ids are offset
// from vertex indices, as in saved analyses, so the id → vertex mapping is
// exercised too.
//
// Usage:  bash ../scripts/build-fem-wasm.sh && bun tests/test_amg_solid.mjs
//         (from web/; the MFEM engine comes from scripts/fetch-wasm-engine.sh)

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { buildVertexIndexer } from "../src/lib/solveMeshPacking.ts";
import { buildSolidEngineInputs } from "../src/lib/solve/solid.ts";
import {
  amgUnavailableReason,
  solveSolidWithAmg,
} from "../src/lib/solve/amg.ts";

const here = dirname(fileURLToPath(import.meta.url));
const enginePkg = join(here, "../src/wasm/pkg");
const femPkg = join(here, "../src/wasm/fem");

function assert(condition, message) {
  if (!condition) throw new Error(`FAIL: ${message}`);
}

// ── Mesh (engine: OCCT + Netgen) ──────────────────────────────────────────────
const { default: createModule } = await import(
  join(enginePkg, "kofem_wasm_emcc.js")
);
const wasmBinary = readFileSync(join(enginePkg, "kofem_wasm_emcc.wasm")).buffer;
// Emscripten keeps (and mutates) its options object, so each instance gets its own.
const quiet = () => ({ wasmBinary, print: () => {}, printErr: () => {} });
const mesher = await createModule(quiet());
mesher.tessellate_step(
  new Uint8Array(readFileSync(join(here, "../../test_files/Wall Bracket.stp"))),
  JSON.stringify({ deflection_relative: 0.001, angular_deflection: 0.5 }),
);
const mesh = mesher.generate_fem_mesh(
  JSON.stringify({
    max_element_size: 20,
    min_element_size: 2,
    grading: 0.3,
    second_order: false,
    elementsperedge: 2.0,
    elementspercurve: 2.0,
    optsteps_2d: 3,
    optsteps_3d: 3,
  }),
);
mesher.free_geometry_cache();

// ── Store model ───────────────────────────────────────────────────────────────
const ID_OFFSET = 1000;
const nodeCount = mesh.vertices.length / 3;
const nodes = Array.from({ length: nodeCount }, (_, i) => ({
  id: i + ID_OFFSET,
  x: mesh.vertices[3 * i],
  y: mesh.vertices[3 * i + 1],
  z: mesh.vertices[3 * i + 2],
}));
const low = [Infinity, Infinity, Infinity];
const high = [-Infinity, -Infinity, -Infinity];
for (const node of nodes)
  ["x", "y", "z"].forEach((key, axis) => {
    low[axis] = Math.min(low[axis], node[key]);
    high[axis] = Math.max(high[axis], node[key]);
  });
const extent = [0, 1, 2].map((axis) => high[axis] - low[axis]);
const longest = extent.indexOf(Math.max(...extent));
const key = ["x", "y", "z"][longest];
const along = (node) => (node[key] - low[longest]) / extent[longest];

// Two bodies: the elements whose centroid lies in the first half are steel,
// the rest aluminium.
const tetCount = mesh.tetrahedra.length / 4;
const elements = Array.from({ length: tetCount }, (_, e) => {
  const nodeIds = Array.from(
    mesh.tetrahedra.subarray(4 * e, 4 * e + 4),
    (vertex) => vertex + ID_OFFSET,
  );
  const centroid =
    nodeIds.reduce((sum, id) => sum + along(nodes[id - ID_OFFSET]), 0) / 4;
  return {
    id: e + 1,
    type: "CTETRA",
    nodeIds,
    propertyId: centroid < 0.5 ? 1 : 2,
  };
});
const materials = [
  { id: 1, name: "Steel", young: 210000, poisson: 0.3, density: 7.85e-9 },
  { id: 2, name: "Aluminium", young: 70000, poisson: 0.33, density: 2.7e-9 },
];
const properties = [
  { id: 1, materialId: 1 },
  { id: 2, materialId: 2 },
];

// Clamp the first 3 %; hold the far end on a roller (the shortest axis only);
// pull one node of the far end along the longest axis by a prescribed amount.
const shortest = extent.indexOf(Math.min(...extent));
const constraints = [];
const farEnd = [];
for (const node of nodes) {
  if (along(node) <= 0.03)
    for (let dof = 0; dof < 3; dof++)
      constraints.push({ nodeId: node.id, dof });
  else if (along(node) >= 0.97) farEnd.push(node);
}
for (const node of farEnd) constraints.push({ nodeId: node.id, dof: shortest });
constraints.push({
  nodeId: farEnd[0].id,
  dof: longest,
  prescribedValue: 0.002,
});
const loads = [
  { nodeId: farEnd[farEnd.length - 1].id, dof: (longest + 1) % 3, value: 500 },
];

// Surface loads on boundary triangles selected by centroid: a pressure on the
// band at 60–70 % of the length, a total force on the band at 80–90 %.
const band = (from, to) => {
  const faces = [];
  for (let t = 0; t < mesh.surfaceTriangles.length / 3; t++) {
    const ids = Array.from(
      mesh.surfaceTriangles.subarray(3 * t, 3 * t + 3),
      (vertex) => vertex + ID_OFFSET,
    );
    const centroid =
      ids.reduce((sum, id) => sum + along(nodes[id - ID_OFFSET]), 0) / 3;
    if (centroid >= from && centroid < to) faces.push(ids);
  }
  return faces;
};
const surfaceLoads = [
  { type: "pressure", faces: band(0.6, 0.7), pressure: 10 },
  { type: "force", faces: band(0.8, 0.9), force: [0, 0, -4000] },
];
assert(
  surfaceLoads.every((load) => load.faces.length > 0),
  "both surface-load bands must select boundary triangles",
);
const model = {
  nodes,
  elements,
  materials,
  properties,
  constraints,
  loads,
  surfaceLoads,
};
console.log(
  `wall bracket: ${nodeCount} nodes, ${tetCount} tets, ${constraints.length} constrained DOFs, ` +
    `${surfaceLoads[0].faces.length} + ${surfaceLoads[1].faces.length} loaded faces`,
);
assert(
  amgUnavailableReason({
    elements,
    properties,
    elementOrder: 1,
    couplingCount: 0,
  }) === null,
  "AMG must accept a linear-tet solid model",
);
assert(
  amgUnavailableReason({
    elements,
    properties,
    elementOrder: 2,
    couplingCount: 0,
  }) !== null,
  "AMG must refuse quadratic elements",
);

// ── MFEM engine (fresh instance, as the worker does after meshing) ────────────
const vid = buildVertexIndexer(nodes);
const engine = await createModule(quiet());
const inputs = buildSolidEngineInputs(model, vid);
let started = performance.now();
const mfem = engine.solve_linear_elastic(
  inputs.mesh,
  inputs.matJson,
  inputs.bcsJson,
  1,
);
assert(!("error" in mfem), `MFEM solve failed: ${mfem.error}`);
const mfemSeconds = (performance.now() - started) / 1000;

// ── Rust AMG ──────────────────────────────────────────────────────────────────
const fem = await import(join(femPkg, "kofem_wasm.js"));
await fem.default({
  module_or_path: readFileSync(join(femPkg, "kofem_wasm_bg.wasm")),
});
const log = [];
started = performance.now();
const amg = solveSolidWithAmg(fem, model, vid, vid, undefined, (line) =>
  log.push(line),
);
const amgSeconds = (performance.now() - started) / 1000;
for (const line of log) console.log(`  ${line}`);

// ── Compare ───────────────────────────────────────────────────────────────────
const maxDifference = (lhs, rhs) => {
  let peak = 0;
  let difference = 0;
  for (let i = 0; i < lhs.length; i++) {
    peak = Math.max(peak, Math.abs(lhs[i]));
    difference = Math.max(difference, Math.abs(lhs[i] - rhs[i]));
  }
  return { peak, relative: difference / peak };
};
assert(
  amg.displacements.length === mfem.displacements.length,
  "displacement arrays differ in length",
);
assert(
  amg.vonMises.length === mfem.von_mises.length,
  "von Mises arrays differ in length",
);
const displacement = maxDifference(mfem.displacements, amg.displacements);
const stress = maxDifference(mfem.von_mises, amg.vonMises);
console.log(
  `max |u| ${displacement.peak.toExponential(4)} mm, AMG − MFEM ${displacement.relative.toExponential(2)} relative; ` +
    `max von Mises ${stress.peak.toExponential(4)} MPa, AMG − MFEM ${stress.relative.toExponential(2)} relative`,
);
console.log(`MFEM ${mfemSeconds.toFixed(2)} s, AMG ${amgSeconds.toFixed(2)} s`);
// Both stop at a 1e-6 relative tolerance (MFEM in its preconditioned norm,
// AMG on the force residual); the fields must agree to well within that.
assert(
  displacement.relative < 1e-5,
  `displacements differ by ${displacement.relative} relative`,
);
assert(
  stress.relative < 1e-4,
  `von Mises stresses differ by ${stress.relative} relative`,
);

// A surface load selecting only interior or stale faces is refused, as in MFEM.
let refusal = "";
try {
  solveSolidWithAmg(
    fem,
    {
      ...model,
      surfaceLoads: [
        {
          type: "pressure",
          faces: [elements[0].nodeIds.slice(0, 3)].filter(
            (face) =>
              !surfaceLoads[0].faces.some(
                (loaded) => loaded.join() === face.join(),
              ),
          ),
          pressure: 1,
        },
      ],
    },
    vid,
    vid,
    undefined,
    () => {},
  );
} catch (error) {
  refusal = String(error);
}
// The first tet's first face is interior on almost every mesh; if it happens
// to be on the boundary the load is simply applied, which is also correct.
console.log(
  refusal
    ? `interior-only surface load refused: ${refusal}`
    : "first tet face is on the boundary — refusal case not exercised",
);
assert(
  refusal === "" || /no force at all/.test(refusal),
  `unexpected error: ${refusal}`,
);

console.log("\nPASS");
