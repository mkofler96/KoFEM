// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Showcase + regression check for SHELL topology optimization (KOF-237): a
// simply-supported square plate under a uniform transverse pressure, optimized
// for minimum compliance under a volume constraint. The optimizer runs on the
// plate's Kirchhoff/DKT shell facets (no solid tets), and a sound run pulls the
// material into a rib layout — solid stiffeners where the bending moment is
// largest, voids elsewhere — rather than a uniform gray sheet.
//
//   node examples/topopt-shell/thin-plate.mjs
//
// Exits non-zero if the run does not converge, leaves the volume constraint, or
// fails to separate solid from void — so it doubles as a verification gate.

import { loadEngine, plateMesh, optimizeShell, densityStats } from "./lib.mjs";

const a = 100.0; // plate edge, mm
const n = 24; // cells per edge
const t = 2.0; // thickness, mm
const STEEL = { young_modulus: 210000, poisson_ratio: 0.3, thickness: t }; // MPa
const VOLFRAC = 0.4;

const Module = await loadEngine((line) => {
  if (/it \d+:/.test(line)) process.stdout.write(`  ${line}\n`);
});

const mesh = plateMesh(a, n);

// Simply supported: pin the three translations on every boundary node, leaving
// the rotations free (a clamped edge would fix the rotations too).
const fixed_dofs = [];
for (let i = 0; i <= n; i++)
  for (let j = 0; j <= n; j++)
    if (i === 0 || j === 0 || i === n || j === n)
      fixed_dofs.push({ vertex: mesh.id(i, j), dofs: [0, 1, 2] });

// Uniform downward pressure → equal transverse point loads on the interior nodes.
const point_loads = [];
for (let i = 1; i < n; i++)
  for (let j = 1; j < n; j++)
    point_loads.push({ vertex: mesh.id(i, j), force: [0, 0, -1] });

console.log(
  `Simply-supported plate ${a}×${a} mm, t=${t} mm → ${mesh.triangles.length} shell facets`,
);
console.log(
  `min compliance s.t. volume ≤ ${VOLFRAC}; SIMP p=3, r_min=${(2.5 * (a / n)).toFixed(1)} mm`,
);

const { density, history, converged } = optimizeShell(
  Module,
  mesh,
  STEEL,
  { fixed_dofs, point_loads },
  {
    objective: "min_compliance",
    constraints: { volumeFraction: VOLFRAC },
    penalty: 3.0,
    filterRadius: 2.5 * (a / n),
    moveLimit: 0.2,
    maxIterations: 60,
    tolerance: 0.01,
  },
);

const first = history[0];
const last = history[history.length - 1];
const stats = densityStats(density);
console.log("");
console.log(`iterations : ${history.length} (${converged ? "converged" : "hit cap"})`);
console.log(`compliance : ${first.objective.toPrecision(5)} → ${last.objective.toPrecision(5)}`);
console.log(`volume frac: ${last.volume.toFixed(4)} (target ${VOLFRAC})`);
console.log(
  `density    : mean ${stats.mean.toFixed(3)}, ${stats.solid} solid / ${stats.void} void of ${density.length}, std ${stats.std.toFixed(3)}`,
);

// ── Verification gates ────────────────────────────────────────────────────────
let failures = 0;
const check = (name, ok, detail) => {
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};
check("run converged", converged, `${history.length} iterations`);
check(
  "compliance decreased",
  last.objective < first.objective,
  `${first.objective.toPrecision(4)} → ${last.objective.toPrecision(4)}`,
);
check(
  "volume constraint respected",
  last.volume <= VOLFRAC * 1.05,
  `vol ${last.volume.toFixed(4)} ≤ ${(VOLFRAC * 1.05).toFixed(4)}`,
);
check(
  "rib layout emerged (not uniform gray)",
  stats.std > 0.2 && stats.solid > 0 && stats.void > 0,
  `std ${stats.std.toFixed(3)}, ${stats.solid} solid / ${stats.void} void`,
);

console.log("");
console.log(failures === 0 ? "thin-plate showcase OK" : "thin-plate showcase FAILED");
process.exit(failures === 0 ? 0 : 1);
