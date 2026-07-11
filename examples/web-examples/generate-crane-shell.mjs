// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Generates the interactive gallery card for the coupled solid+shell crane
// showcase and merges it into web/public/examples/examples.json (the manifest
// the /examples/ gallery renders). Unlike the benchmark examples, this one meshes
// a STEP assembly, turns the thin holder into shells, and solves the coupled
// system — so it has its own generator rather than living in examples.mjs.
//
//   bun examples/web-examples/generate-crane-shell.mjs
//
// It appends/replaces the "crane-hook-shell" entry, leaving the benchmark
// entries produced by generate.mjs untouched.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  loadEngine,
  meshStep,
  extractThinWallShells,
  tieSolidBodies,
  buildCoupledModel,
} from "../shell-coupling/lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const STEP = join(here, "../../test_files/full-crane-hook.step");
const outDir = join(here, "../../web/public/examples");
const STEEL = { young_modulus: 210000, poisson_ratio: 0.3 };
const BC_FIXED_FACE = 7;
const LOAD_FACES = { 66: [0, -1000, 0], 67: [0, -1000, 0] };

const Module = await loadEngine();
const mesh = meshStep(Module, STEP, { maxElementSize: 6 });
const shells = extractThinWallShells(mesh);
const tie = tieSolidBodies(mesh, shells.shellBody);
const model = buildCoupledModel(mesh, shells, tie);
const nShell = model.shellPool.length;

// BCs + loads by CAD face (see crane-holder-shell.mjs).
const fixed = [];
for (let s = 0; s < nShell; s++)
  if (shells.shellSrc[s] === BC_FIXED_FACE) for (let c = 0; c < 6; c++) fixed.push(6 * model.shellPool[s] + c);
const loadNodes = new Map(Object.keys(LOAD_FACES).map((f) => [Number(f), new Set()]));
for (let t = 0; t < mesh.surfFace.length; t++) {
  const F = LOAD_FACES[mesh.surfFace[t]];
  if (!F) continue;
  for (const oi of [mesh.surfTri[3 * t], mesh.surfTri[3 * t + 1], mesh.surfTri[3 * t + 2]]) {
    const pi = model.solidPool.get(model.tied(oi));
    if (pi !== undefined) loadNodes.get(mesh.surfFace[t]).add(pi);
  }
}
const load_dofs = [], load_vals = [];
for (const [fid, F] of Object.entries(LOAD_FACES)) {
  const ns = [...loadNodes.get(Number(fid))];
  for (const pi of ns) for (let c = 0; c < 3; c++) if (F[c] !== 0) { load_dofs.push(6 * pi + c); load_vals.push(F[c] / ns.length); }
}

const r = Module.solve_coupled(
  { vertices: Float64Array.from(model.pool), tets: Int32Array.from(model.tets),
    triangles: Int32Array.from(model.triangles), thicknesses: Float64Array.from(model.thicknesses) },
  { ref: Int32Array.from(model.coupling.ref), offsets: Int32Array.from(model.coupling.offsets), solid: Int32Array.from(model.coupling.solid) },
  { fixed_dofs: Int32Array.from(fixed), load_dofs: Int32Array.from(load_dofs), load_vals: Float64Array.from(load_vals) },
  JSON.stringify({ solid: STEEL, shell: STEEL }),
);
if ("error" in r) throw new Error(r.error);

// ── Build the gallery viewer surface: shell triangles + solid boundary faces ───
const disp = r.displacements;
const pool = model.pool;

// solid boundary = tet faces used by exactly one solid tet
const TF = [[0, 1, 2], [0, 1, 3], [0, 2, 3], [1, 2, 3]];
const fc = new Map(), fn = new Map();
for (let e = 0; e < model.tets.length / 4; e++) {
  const p = [model.tets[4 * e], model.tets[4 * e + 1], model.tets[4 * e + 2], model.tets[4 * e + 3]];
  for (const f of TF) { const v = [p[f[0]], p[f[1]], p[f[2]]]; const k = [...v].sort((a, b) => a - b).join(","); const c = fc.get(k); if (c) c.n++; else { fc.set(k, { n: 1 }); fn.set(k, v); } }
}
const surfaceTris = [];
for (const [k, c] of fc) if (c.n === 1) surfaceTris.push(fn.get(k));
for (let t = 0; t < model.triangles.length / 3; t++) surfaceTris.push([model.triangles[3 * t], model.triangles[3 * t + 1], model.triangles[3 * t + 2]]);

// compact remap to used surface vertices, with per-vertex displacement + magnitude
const remap = new Map(), positions = [], displacements = [], magnitudes = [];
let magMin = Infinity, magMax = -Infinity;
const idxOf = (g) => {
  let i = remap.get(g);
  if (i === undefined) {
    i = remap.size; remap.set(g, i);
    positions.push(pool[3 * g], pool[3 * g + 1], pool[3 * g + 2]);
    const dx = disp[3 * g], dy = disp[3 * g + 1], dz = disp[3 * g + 2];
    displacements.push(dx, dy, dz);
    const m = Math.hypot(dx, dy, dz); magnitudes.push(m);
    magMin = Math.min(magMin, m); magMax = Math.max(magMax, m);
  }
  return i;
};
const triangles = [];
for (const [a, b, c] of surfaceTris) triangles.push(idxOf(a), idxOf(b), idxOf(c));

let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
for (let i = 0; i < positions.length / 3; i++) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], positions[3 * i + k]); mx[k] = Math.max(mx[k], positions[3 * i + k]); }
const modelSize = Math.max(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2], 1e-9);
const deformScale = magMax < 1e-30 ? 1 : (0.2 * modelSize) / magMax;
const round = (a, p) => a.map((x) => Number(x.toPrecision(p)));

const entry = {
  id: "crane-hook-shell",
  title: "Crane hook — coupled shell + solid",
  blurb:
    "A multibody crane hook: the thin holder is modelled as Kirchhoff shells, " +
    "the pin and hook stay solid, and the two are joined by a distributing (RBE3) " +
    "coupling. This coupled model converges where the all-solid mesh stalls (#358).",
  showcase: true,
  // "Open in KoFEM web" opens the underlying crane assembly (the app can't
  // re-solve the coupled shell model yet — that's the app-integration follow-up).
  appId: "full-crane-hook",
  metrics: [
    { k: "max displacement", v: `${magMax.toPrecision(3)} mm` },
    { k: "coupled solve", v: `converged · ${r.iterations} it`, pass: true },
  ],
  referenceLabel: "shell holder ↔ solid pin/hook · distributing (RBE3) coupling",
  colorLabel: "Displacement magnitude",
  viewer: {
    center: [(mn[0] + mx[0]) / 2, (mn[1] + mx[1]) / 2, (mn[2] + mx[2]) / 2],
    modelSize, deformScale, magMin, magMax,
    positions: round(positions, 7),
    displacements: round(displacements, 6),
    magnitudes: round(magnitudes, 6),
    triangles,
  },
};

const manifestPath = join(outDir, "examples.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8")).filter((e) => e.id !== entry.id);
manifest.push(entry);
writeFileSync(manifestPath, JSON.stringify(manifest));
console.log(
  `crane-hook-shell: ${r.iterations} it, max |u| ${magMax.toPrecision(3)} mm, ` +
    `${triangles.length / 3} surface tris → ${manifestPath}`,
);
