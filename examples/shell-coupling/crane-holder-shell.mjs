// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Showcase: solve the crane-hook assembly with its thin holder modelled as
// SHELLS coupled to the solid pin/hook — the case that stalls when everything is
// solid tets (issue #358). The thin walls of the holder are auto-detected and
// collapsed to a Kirchhoff shell mid-surface (per-wall thickness); the bulk
// bodies stay solid (assembled by MFEM); the two are joined by a distributing
// (RBE3) coupling that transmits force and moment across the mid-surface offset.
//
//   node examples/shell-coupling/crane-holder-shell.mjs [--vtu out.vtu]
//
// Exits non-zero if the coupled solve does not converge, so it doubles as a
// regression/verification check. Pass --vtu to write the deformed shell surface
// for visual inspection in ParaView.

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadEngine, meshStep, extractThinWallShells, shellWallTets, buildCoupledModel, dropCouplingsOnFixedNodes } from "./lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const STEP = join(here, "../../test_files/full-crane-hook.step");
const STEEL = { young_modulus: 210000, poisson_ratio: 0.3 }; // MPa

// CAD (OCC) face ids of the boundary conditions, stable across re-meshing of the
// same STEP: face 7 is the holder mounting face (fixed); faces 66/67 are the two
// loaded faces on the hook (−1000 N in Y each). These match the saved analysis in
// web/public/examples/full-crane-hook.vtu.
const BC_FIXED_FACE = 7;
const LOAD_FACES = { 66: [0, -1000, 0], 67: [0, -1000, 0] };

const vtuArg = process.argv.indexOf("--vtu");
const vtuPath = vtuArg >= 0 ? process.argv[vtuArg + 1] : null;

const Module = await loadEngine();

// ── 1. mesh the assembly ───────────────────────────────────────────────────────
const mesh = meshStep(Module, STEP, { maxElementSize: 6 });
const bodies = [...new Set(mesh.body)].sort();
console.log(`mesh: ${mesh.V.length / 3} nodes, ${mesh.tet.length / 4} tets, bodies ${bodies.join(",")}`);

// ── 2. thin holder walls → shell mid-surface ───────────────────────────────────
const shells = extractThinWallShells(mesh);
console.log(
  `thin walls: ${shells.walls.length} on body ${shells.shellBody} → shell of ` +
    `${shells.shellVerts.length / 3} nodes, ${shells.shellTris.length / 3} triangles ` +
    `(t = ${Math.min(...shells.shellThk).toFixed(1)}–${Math.max(...shells.shellThk).toFixed(1)} mm)`,
);

// ── 3. classify the holder's thin-wall tets (→ shells) vs its base (→ solid) ───
const wallTets = shellWallTets(mesh, shells);

// ── 4. build the coupled node pool + distributing couplings ────────────────────
// Pin/hook/base stay separate solid bodies joined by distributing couplings; a
// gapped pin/hole interface becomes a force-and-moment tie, not a sparse hinge.
const model = buildCoupledModel(mesh, shells, wallTets);
const nSolid = model.solidPool.size, nShell = model.shellPool.length;
console.log(
  `coupled model: ${model.pool.length / 3} nodes (${nSolid} solid + ${nShell} shell), ` +
    `${model.tets.length / 4} tets, ${model.triangles.length / 3} shell tris, ` +
    `${model.coupling.ref.length} distributing couplings`,
);

// ── 5. boundary conditions + loads (by CAD face) ───────────────────────────────
// Fix every node of a face-7 facet (fold nodes shared with the side walls carry the
// wall's label, so a per-node test would drop them and let the walls hinge).
const fixed = [], fixedLocal = new Set();
for (let t = 0; t < shells.shellTris.length / 3; t++)
  if (shells.shellTriSrc[t] === BC_FIXED_FACE)
    for (let k = 0; k < 3; k++) fixedLocal.add(shells.shellTris[3 * t + k]);
for (const s of fixedLocal) for (let c = 0; c < 6; c++) fixed.push(6 * model.shellPool[s] + c);
if (fixed.length === 0) throw new Error(`no shell nodes on BC face ${BC_FIXED_FACE} — check the face id`);

const loadNodes = new Map(Object.keys(LOAD_FACES).map((f) => [Number(f), new Set()]));
for (let t = 0; t < mesh.surfFace.length; t++) {
  const F = LOAD_FACES[mesh.surfFace[t]];
  if (!F) continue;
  for (const oi of [mesh.surfTri[3 * t], mesh.surfTri[3 * t + 1], mesh.surfTri[3 * t + 2]]) {
    const pi = model.solidPool.get(oi);
    if (pi !== undefined) loadNodes.get(mesh.surfFace[t]).add(pi);
  }
}
const load_dofs = [], load_vals = [];
for (const [fid, F] of Object.entries(LOAD_FACES)) {
  const ns = [...loadNodes.get(Number(fid))];
  for (const pi of ns) for (let c = 0; c < 3; c++) if (F[c] !== 0) { load_dofs.push(6 * pi + c); load_vals.push(F[c] / ns.length); }
}
console.log(`BCs: ${fixed.length / 6} fixed shell nodes (face ${BC_FIXED_FACE}); loads on ${[...loadNodes].map(([f, s]) => `f${f}:${s.size}`).join(" ")} solid nodes`);

// ── 6. solve ───────────────────────────────────────────────────────────────────
// Drop distributing couplings on the clamped rim (fixed RBE3 dependent, #377).
const coupling = dropCouplingsOnFixedNodes(model.coupling, fixed);
console.log("solving coupled crane…");
const t0 = Date.now();
const r = Module.solve_coupled(
  {
    vertices: Float64Array.from(model.pool),
    tets: Int32Array.from(model.tets),
    triangles: Int32Array.from(model.triangles),
    thicknesses: Float64Array.from(model.thicknesses),
  },
  {
    ref: Int32Array.from(coupling.ref),
    offsets: Int32Array.from(coupling.offsets),
    solid: Int32Array.from(coupling.solid),
  },
  { fixed_dofs: Int32Array.from(fixed), load_dofs: Int32Array.from(load_dofs), load_vals: Float64Array.from(load_vals) },
  JSON.stringify({ solid: STEEL, shell: STEEL }),
);
const secs = ((Date.now() - t0) / 1000).toFixed(1);

if ("error" in r) {
  console.error(`\n✗ ${r.error}  (${secs}s)`);
  process.exit(1);
}
const nPool = model.pool.length / 3;
let maxU = 0, maxNode = 0;
for (let i = 0; i < nPool; i++) {
  const u = Math.hypot(r.displacements[3 * i], r.displacements[3 * i + 1], r.displacements[3 * i + 2]);
  if (u > maxU) { maxU = u; maxNode = i; }
}
console.log(`\n✓ CONVERGED in ${r.iterations} iterations, ${secs}s`);
console.log(`  max |u| = ${maxU.toExponential(4)} mm at node ${maxNode}`);
const vmSolid = Math.max(0, ...r.von_mises_tets);
const vmShell = Math.max(0, ...r.von_mises_tris);
console.log(`  max von Mises: solid ${vmSolid.toFixed(1)} MPa · shell ${vmShell.toFixed(1)} MPa`);

// ── 7. optional VTU of the deformed shell surface (ParaView) ───────────────────
if (vtuPath) {
  const pts = [], disp = [];
  for (let s = 0; s < nShell; s++) {
    const gi = model.shellPool[s];
    pts.push(model.pool[3 * gi], model.pool[3 * gi + 1], model.pool[3 * gi + 2]);
    disp.push(r.displacements[3 * gi], r.displacements[3 * gi + 1], r.displacements[3 * gi + 2]);
  }
  const conn = [], offs = [], types = [];
  for (let t = 0; t < model.triangles.length / 3; t++) {
    // map pool triangle nodes back to local shell indices
    conn.push(model.triangles[3 * t] - model.shellPool[0], model.triangles[3 * t + 1] - model.shellPool[0], model.triangles[3 * t + 2] - model.shellPool[0]);
    offs.push(3 * (t + 1)); types.push(5); // VTK_TRIANGLE
  }
  const vtu = [
    '<?xml version="1.0"?>',
    '<VTKFile type="UnstructuredGrid" version="1.0" byte_order="LittleEndian">',
    "<UnstructuredGrid>",
    `<Piece NumberOfPoints="${nShell}" NumberOfCells="${model.triangles.length / 3}">`,
    "<Points>",
    `<DataArray type="Float64" NumberOfComponents="3" format="ascii">\n${pts.join(" ")}\n</DataArray>`,
    "</Points>",
    "<Cells>",
    `<DataArray type="Int64" Name="connectivity" format="ascii">\n${conn.join(" ")}\n</DataArray>`,
    `<DataArray type="Int64" Name="offsets" format="ascii">\n${offs.join(" ")}\n</DataArray>`,
    `<DataArray type="UInt8" Name="types" format="ascii">\n${types.join(" ")}\n</DataArray>`,
    "</Cells>",
    "<PointData>",
    `<DataArray type="Float64" Name="Displacement" NumberOfComponents="3" format="ascii">\n${disp.join(" ")}\n</DataArray>`,
    "</PointData>",
    "</Piece>",
    "</UnstructuredGrid>",
    "</VTKFile>",
    "",
  ].join("\n");
  writeFileSync(vtuPath, vtu);
  console.log(`  wrote deformed shell surface → ${vtuPath}`);
}
