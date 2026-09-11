// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Showcase + regression check for COUPLED shell/solid topology optimization
// (KOF-237): a solid block (CTETRA) with a thin shell wall (CTRIA3) hanging from
// its underside on an offset mid-surface, the two joined by distributing (RBE3)
// couplings. A single density field spans the whole design domain — the solid
// tets AND the shell facets — while the RBE3 coupling stays a fixed constraint,
// eliminated by the same master-slave reduction every iteration, so the
// shell↔solid interface is intact from the first solve to the last.
//
//   node examples/topopt-shell/coupled-bracket.mjs
//
// Exits non-zero if the coupled run does not converge or leaves the volume
// constraint — it verifies the interface survives the whole optimization.

import { loadEngine, optimizeCoupled, densityStats } from "./lib.mjs";

// ── Geometry: solid block [0,L]×[0,W]×[0,H] + shell wall on y = W/2 ────────────
const L = 60,
  W = 12,
  H = 12,
  Hw = 30,
  t = 1.5;
const nx = 6,
  ny = 2,
  nz = 2,
  nzw = 3;
const STEEL = { young_modulus: 210000, poisson_ratio: 0.3 };
const ALUM = { young_modulus: 70000, poisson_ratio: 0.33 };
const VOLFRAC = 0.5;

const vertices = [];
const sid = (i, j, k) => (i * (ny + 1) + j) * (nz + 1) + k;
for (let i = 0; i <= nx; i++)
  for (let j = 0; j <= ny; j++)
    for (let k = 0; k <= nz; k++)
      vertices.push([(L * i) / nx, (W * j) / ny, (H * k) / nz]);
const tets = [];
for (let i = 0; i < nx; i++)
  for (let j = 0; j < ny; j++)
    for (let k = 0; k < nz; k++) {
      const a = sid(i, j, k),
        b = sid(i + 1, j, k),
        c = sid(i + 1, j + 1, k),
        d = sid(i, j + 1, k),
        e = sid(i, j, k + 1),
        f = sid(i + 1, j, k + 1),
        g = sid(i + 1, j + 1, k + 1),
        h = sid(i, j + 1, k + 1);
      for (const tt of [
        [a, b, c, g],
        [a, c, d, g],
        [a, d, h, g],
        [a, h, e, g],
        [a, e, f, g],
        [a, f, b, g],
      ])
        tets.push(tt);
    }
const nSolid = vertices.length;

const base = nSolid;
const wid = (i, k) => base + i * (nzw + 1) + k;
for (let i = 0; i <= nx; i++)
  for (let k = 0; k <= nzw; k++)
    vertices.push([(L * i) / nx, W / 2, (-Hw * k) / nzw]);
const triangles = [];
for (let i = 0; i < nx; i++)
  for (let k = 0; k < nzw; k++) {
    const a = wid(i, k),
      b = wid(i + 1, k),
      c = wid(i + 1, k + 1),
      d = wid(i, k + 1);
    triangles.push([a, b, c]);
    triangles.push([a, c, d]);
  }
const thicknesses = triangles.map(() => t);

// ── Distributing (RBE3) couplings: each wall top-row node → nearby block nodes ─
const ref = [];
const offsets = [0];
const solid = [];
const radius = 0.6 * L;
for (let i = 0; i <= nx; i++) {
  const rn = wid(i, 0);
  const [rx, ry, rz] = vertices[rn];
  const patch = [];
  for (let sn = 0; sn < nSolid; sn++) {
    const [x, y, z] = vertices[sn];
    if ((x - rx) ** 2 + (y - ry) ** 2 + (z - rz) ** 2 <= radius * radius)
      patch.push(sn);
  }
  if (patch.length < 3) continue;
  ref.push(rn);
  for (const sn of patch) solid.push(sn);
  offsets.push(solid.length);
}

// ── BCs: clamp the block's x=0 face; pull the wall's bottom row sideways ───────
const fixed_dofs = [];
for (let j = 0; j <= ny; j++)
  for (let k = 0; k <= nz; k++)
    for (let c = 0; c < 3; c++) fixed_dofs.push(6 * sid(0, j, k) + c);
const load_dofs = [];
const load_vals = [];
for (let i = 0; i <= nx; i++) {
  load_dofs.push(6 * wid(i, nzw) + 0); // +x on the wall's free edge
  load_vals.push(20);
}

console.log(
  `Coupled block+wall: ${tets.length} solid tets + ${triangles.length} shell facets, ` +
    `${ref.length} RBE3 couplings, ${vertices.length} nodes`,
);
console.log(`min compliance s.t. volume ≤ ${VOLFRAC}; SIMP p=3`);

const Module = await loadEngine((line) => {
  if (/it \d+:/.test(line)) process.stdout.write(`  ${line}\n`);
});

const { density, history, converged } = optimizeCoupled(
  Module,
  { vertices, tets, triangles, thicknesses },
  { ref, offsets, solid, mpc: ref.map(() => 0) }, // 0 = distributing RBE3
  { fixed_dofs, load_dofs, load_vals },
  { solid: STEEL, shell: ALUM },
  {
    objective: "min_compliance",
    constraints: { volumeFraction: VOLFRAC },
    penalty: 3.0,
    filterRadius: 1.5 * (L / nx),
    moveLimit: 0.2,
    maxIterations: 40,
    tolerance: 0.01,
  },
);

const first = history[0];
const last = history[history.length - 1];
const nDesign = tets.length + triangles.length;
const stats = densityStats(density);
console.log("");
console.log(`design els : ${density.length} (expected ${nDesign}: ${tets.length} tets + ${triangles.length} facets)`);
console.log(`iterations : ${history.length} (${converged ? "converged" : "hit cap"})`);
console.log(`compliance : ${first.objective.toPrecision(5)} → ${last.objective.toPrecision(5)}`);
console.log(`volume frac: ${last.volume.toFixed(4)} (target ${VOLFRAC})`);
console.log(`density    : mean ${stats.mean.toFixed(3)}, ${stats.solid} solid / ${stats.void} void, std ${stats.std.toFixed(3)}`);

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};
check(
  "density spans the whole coupled domain",
  density.length === nDesign,
  `${density.length} vs ${nDesign}`,
);
check("run converged (RBE3 solve stable every iteration)", converged, `${history.length} iterations`);
check(
  "compliance decreased",
  last.objective < first.objective,
  `${first.objective.toPrecision(4)} → ${last.objective.toPrecision(4)}`,
);
check(
  "volume constraint respected",
  last.volume <= VOLFRAC * 1.05,
  `vol ${last.volume.toFixed(4)}`,
);
check("material redistributed", stats.std > 0.15, `std ${stats.std.toFixed(3)}`);

console.log("");
console.log(failures === 0 ? "coupled-bracket showcase OK" : "coupled-bracket showcase FAILED");
process.exit(failures === 0 ? 0 : 1);
