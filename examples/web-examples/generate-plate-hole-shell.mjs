// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Generates the interactive gallery card for the SHELL version of the plate with
// a hole and merges it into web/public/examples/examples.json (the manifest the
// /examples/ gallery renders). It is the exact same Kirsch stress-concentration
// problem as the solid `plate-with-hole` benchmark — same geometry, material and
// remote tension — but the through-thickness hexes are replaced by a single-layer
// Kirchhoff shell (DKT bending + CST membrane) mid-surface. Loaded in its own
// plane the shell reduces to plane stress, so the peak facet stress at the hole
// edge still approaches Kirsch's Kt = 3.
//
//   bun examples/web-examples/generate-plate-hole-shell.mjs
//
// Like the crane showcase it has its own generator (the benchmark pipeline in
// generate.mjs only knows solid hex meshes + solve_linear_elastic), and it
// appends/replaces the "plate-with-hole-shell" entry, leaving the other entries
// untouched.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadEngine } from "../shell-coupling/lib.mjs";
import { plateWithHoleShellMesh, nodesWhere } from "../validation/lib/mesh.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "../../web/public/examples");

// Same canonical mm/MPa system and geometry as the solid plate-with-hole card
// (examples.mjs): steel, a/b = 0.1 ⇒ ≈ infinite-plate Kt, σ = 100 MPa tension.
const STEEL = { young_modulus: 210000, poisson_ratio: 0.3 };
const a = 1000, // hole radius (mm)
  b = 10000, // plate half-width (mm)
  t = 500, // shell thickness (mm)
  sigma = 100; // remote tension (MPa)

const m = plateWithHoleShellMesh(a, b, 12, 64, 2);
const nNodes = m.vertices.length;

// Fix the left edge (all 6 DOF); pull the right edge in +x with a resultant equal
// to the gross axial force P = σ·(2b·t), so the far-field membrane stress is σ.
// The exact right-edge distribution is immaterial to the hole stress (St. Venant);
// an equal nodal split gives the correct resultant.
const left = nodesWhere(m.vertices, (x) => x <= -b + 1e-6);
const right = nodesWhere(m.vertices, (x) => x >= b - 1e-6);
const P = sigma * (2 * b * t);
const point_loads = right.map((vertex) => ({
  vertex,
  force: [P / right.length, 0, 0],
}));

const Module = await loadEngine();
const r = Module.solve_shell(
  {
    vertices: Float64Array.from(m.vertices.flat()),
    triangles: Int32Array.from(m.triangles.flat()),
  },
  JSON.stringify({ ...STEEL, thickness: t }),
  JSON.stringify({ fixed_vertices: left, point_loads }),
);
if ("error" in r) throw new Error(r.error);

// Peak facet von Mises sits in the hole-ring elements — the first 2·nth triangles
// (two per ring quad). Kt = peak / σ.
const holeRing = 2 * m.nth;
let peak = 0;
for (let e = 0; e < holeRing; e++) peak = Math.max(peak, r.von_mises[e]);
const Kt = peak / sigma;
const errPct = (Math.abs(Kt - 3.0) / 3.0) * 100;

// ── Gallery viewer surface (the shell triangles are already the surface) ───────
const disp = r.displacements;
const positions = [];
const displacements = [];
const magnitudes = [];
let magMin = Infinity,
  magMax = -Infinity;
for (let i = 0; i < nNodes; i++) {
  positions.push(m.vertices[i][0], m.vertices[i][1], m.vertices[i][2]);
  const dx = disp[3 * i],
    dy = disp[3 * i + 1],
    dz = disp[3 * i + 2];
  displacements.push(dx, dy, dz);
  const mag = Math.hypot(dx, dy, dz);
  magnitudes.push(mag);
  magMin = Math.min(magMin, mag);
  magMax = Math.max(magMax, mag);
}
const triangles = m.triangles.flat();

let mn = [Infinity, Infinity, Infinity],
  mx = [-Infinity, -Infinity, -Infinity];
for (let i = 0; i < nNodes; i++)
  for (let k = 0; k < 3; k++) {
    mn[k] = Math.min(mn[k], positions[3 * i + k]);
    mx[k] = Math.max(mx[k], positions[3 * i + k]);
  }
const modelSize = Math.max(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2], 1e-9);
const deformScale = magMax < 1e-30 ? 1 : (0.2 * modelSize) / magMax;
const round = (arr, p) => arr.map((x) => Number(x.toPrecision(p)));

const entry = {
  id: "plate-with-hole-shell",
  title: "Plate with a hole — shells",
  blurb:
    "The exact same Kirsch stress-concentration problem as the solid plate " +
    "with a hole, but the through-thickness hexes are replaced by a single-layer " +
    "Kirchhoff shell (DKT + CST). Loaded in its own plane it is plane stress, and " +
    "the peak facet stress at the hole still approaches Kt = 3.",
  showcase: true,
  // "Open in KoFEM web" opens the solid twin — the app solves solids, not pure
  // shells (same reason the crane showcase points at its solid assembly).
  appId: "plate-with-hole",
  metrics: [
    { k: "stress concentration Kt", v: Kt.toFixed(2) },
    {
      k: "vs. Kirsch Kt = 3",
      v: `${errPct.toFixed(1)}% err`,
      pass: errPct <= 15,
    },
  ],
  referenceLabel: "Kt = 3 (Kirsch) · Kirchhoff shell (DKT + CST membrane)",
  colorLabel: "Displacement magnitude",
  viewer: {
    center: [(mn[0] + mx[0]) / 2, (mn[1] + mx[1]) / 2, (mn[2] + mx[2]) / 2],
    modelSize,
    deformScale,
    magMin,
    magMax,
    positions: round(positions, 7),
    displacements: round(displacements, 6),
    magnitudes: round(magnitudes, 6),
    triangles,
  },
};

const manifestPath = join(outDir, "examples.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8")).filter(
  (e) => e.id !== entry.id,
);
manifest.push(entry);
writeFileSync(manifestPath, JSON.stringify(manifest));
console.log(
  `plate-with-hole-shell: ${r.iterations} it, ${nNodes} nodes, ` +
    `${triangles.length / 3} triangles, Kt=${Kt.toFixed(3)} (err ${errPct.toFixed(1)}%) → ${manifestPath}`,
);
