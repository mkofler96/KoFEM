// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// 3D cantilever — a genuinely three-dimensional minimum-compliance benchmark
// (the classic short-cantilever problem, e.g. Liu & Tovar's top3d).
//
// A 2:1:1 box is fully fixed over its root face (x = 0) and carries a downward
// load along the bottom edge of the free tip (x = L, y = 0). Unlike the planar
// MBB case this keeps all three translations free, so the optimizer is free to
// move material out of plane — and it does: the mass migrates to the two outer
// z-faces, leaving the neutral mid-planes nearly void, the 3D analogue of an
// I-section's flanges-and-web. Each z-face carries a tip-loaded cantilever truss
// (a top tension chord, a bottom chord and diagonal bracing back to the root).
//
// Because the geometry, supports and load are all symmetric about the
// z-midplane, the optimal design must be too. We assert that mirror symmetry
// (a strong correctness check a buggy solve would break), lock the converged
// compliance and volume fraction, and confirm a real bimodal topology emerged.
// This run is also the coarse half of the mesh-independence case.

import {
  boxHexMesh,
  dirichletBuilder,
  distributeForce,
  densityStats,
  zSymmetryMaxDiff,
  verticesWhere,
} from "../lib/topopt.mjs";

export const L = 2.0;
export const H = 1.0;
export const D = 1.0;
export const VOLFRAC = 0.4;
export const PENALTY = 3;
// Physical filter radius, fixed in model length units so the mesh-independence
// case can refine the grid while holding r_min constant (2 element widths of the
// 10×5×5 coarse grid: 2 × L/10 = 0.4).
export const FILTER_RADIUS = 0.4;
export const MOVE_LIMIT = 0.2;
export const MAX_ITERATIONS = 80;
export const TOLERANCE = 0.01;

// Build the cantilever at an nx×ny×nz resolution. Exported so the
// mesh-independence case can reuse the exact same problem at two resolutions.
export function buildCantilever(nx, ny, nz) {
  const mesh = boxHexMesh(L, H, D, nx, ny, nz);
  const tol = 1e-9;
  const bc = dirichletBuilder();
  for (let v = 0; v < mesh.vertices.length; v++) {
    const [x] = mesh.vertices[v];
    if (x <= tol) {
      bc.fix(v, 0);
      bc.fix(v, 1);
      bc.fix(v, 2); // fully built-in root face
    }
  }
  const loaded = verticesWhere(mesh, (x, y) => x >= L - tol && y <= tol);
  const { fixed_vertices, fixed_dofs } = bc.build();
  return {
    mesh,
    materials: [{ young_modulus: 1, poisson_ratio: 0.3, density: 1 }],
    bcs: {
      fixed_vertices,
      fixed_dofs,
      point_loads: distributeForce(loaded, [0, -1, 0]),
    },
    settings: {
      objective: "min_compliance",
      constraints: { volumeFraction: VOLFRAC },
      penalty: PENALTY,
      filterRadius: FILTER_RADIUS,
      moveLimit: MOVE_LIMIT,
      maxIterations: MAX_ITERATIONS,
      tolerance: TOLERANCE,
    },
  };
}

const NX = 10;
const NY = 5;
const NZ = 5;

// Reference numbers from the committed engine (see REPORT.md); ±15 % band.
const COMPLIANCE_REF = 188.5;
const COMPLIANCE_TOL_PCT = 15;
const MAX_COMPLIANCE_RATIO = 0.4;

// ASCII of the k = 0 outer z-face (top row first), where the tip-loaded truss
// sits — the mid-planes are near-void by design.
function faceArt(density, mesh) {
  const { nx, ny } = mesh.dims;
  const rows = [];
  for (let j = ny - 1; j >= 0; j--) {
    let row = "";
    for (let i = 0; i < nx; i++) {
      const r = density[mesh.eidx(i, j, 0)];
      row += r > 0.5 ? "#" : r > 0.25 ? ":" : " ";
    }
    rows.push("  " + row);
  }
  return rows.join("\n");
}

export default {
  name: "3D cantilever (tip load)",
  description: `${NX}×${NY}×${NZ} box, volfrac ${VOLFRAC}, p ${PENALTY} — fixed root, tip load`,
  run(optimize) {
    const { mesh, materials, bcs, settings } = buildCantilever(NX, NY, NZ);
    const { density, history, converged } = optimize(
      mesh,
      materials,
      bcs,
      settings,
    );

    const c0 = history[0].objective;
    const cN = history.at(-1).objective;
    const volN = history.at(-1).volume;
    const ratio = cN / c0;
    const stats = densityStats(density);
    const zdiff = zSymmetryMaxDiff(density, mesh.dims);

    // See mbb-beam.mjs: MMA may oscillate mid-run, so we require the run to END
    // at its stiffest design rather than to decrease monotonically.
    const cMin = Math.min(...history.map((h) => h.objective));

    const cLo = COMPLIANCE_REF * (1 - COMPLIANCE_TOL_PCT / 100);
    const cHi = COMPLIANCE_REF * (1 + COMPLIANCE_TOL_PCT / 100);

    return {
      metrics: [
        {
          label: "iterations",
          value: `${history.length} (converged: ${converged})`,
        },
        {
          label: "compliance",
          value: `${c0.toFixed(1)} → ${cN.toFixed(1)} (ratio ${ratio.toFixed(3)})`,
        },
        {
          label: "volume fraction",
          value: `${volN.toFixed(4)} (target ${VOLFRAC})`,
        },
        {
          label: "density",
          value: `${stats.solid} solid, ${stats.void} void, std ${stats.std.toFixed(3)}`,
        },
        { label: "z-mirror max |Δρ|", value: zdiff.toExponential(2) },
      ],
      checks: [
        { label: "converged within the iteration budget", pass: converged },
        {
          label: `volume fraction within 1 % of ${VOLFRAC}`,
          pass: Math.abs(volN - VOLFRAC) < 0.01,
        },
        {
          label: `compliance in band [${cLo.toFixed(0)}, ${cHi.toFixed(0)}]`,
          pass: cN >= cLo && cN <= cHi,
        },
        {
          label: `compliance ratio < ${MAX_COMPLIANCE_RATIO}`,
          pass: ratio < MAX_COMPLIANCE_RATIO,
        },
        {
          label: "ended at its stiffest design (final = min compliance)",
          pass: cN <= cMin * (1 + 1e-6),
        },
        {
          label: "material concentrated to solid and void",
          pass: stats.solid > 0 && stats.void > 0,
        },
        {
          label: "topology emerged (density std > 0.15)",
          pass: stats.std > 0.15,
        },
        {
          label: "design symmetric about z-midplane (max |Δρ| < 1e-3)",
          pass: zdiff < 1e-3,
        },
      ],
      layout: faceArt(density, mesh),
    };
  },
};
