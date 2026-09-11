// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// MBB beam — the canonical minimum-compliance topology-optimization benchmark
// (Sigmund's 99-line code; Andreassen et al. 2011, "Efficient topology
// optimization in MATLAB using 88 lines of code").
//
// Half the simply-supported beam is modelled, exploiting the mid-span symmetry:
// the left face is the symmetry plane (u_x = 0), a roller at the bottom-right
// corner carries the reaction (u_y = 0), and half the central load presses down
// at the top of the symmetry edge. A single element through the thickness with
// u_z ≡ 0 makes it a 2D (plane) problem solved by the 3D engine — the same
// 2D-in-3D idealisation the native loop test (engine/tests/topology_optimize_
// validation.cpp) uses, here at the resolution that resolves the textbook truss.
//
// At volfrac 0.5, p 3 the optimizer returns the well-known layout: a curved
// upper compression chord, a straight lower tension tie, and the triangulated
// web of diagonals between them. We lock the converged compliance and the volume
// fraction to a band, and assert the layout is a real (bimodal) topology rather
// than a stalled gray field.

import {
  boxHexMesh,
  dirichletBuilder,
  distributeForce,
  densityStats,
  verticesWhere,
} from "../lib/topopt.mjs";

const L = 6.0; // half-span
const H = 2.0; // height
const T = 0.5; // thickness (one element)
const NX = 36;
const NY = 12;
const VOLFRAC = 0.5;
const PENALTY = 3;
const FILTER_RADIUS = 0.3; // ≈ 1.8 element widths (element size L/NX = 0.1667)
const MOVE_LIMIT = 0.2;
const MAX_ITERATIONS = 80;
const TOLERANCE = 0.01;

// Reference numbers measured from the committed engine (see REPORT.md); the
// ±15 % band tolerates numerical drift across engine rebuilds while still
// catching a real regression in the optimizer.
const COMPLIANCE_REF = 413.1;
const COMPLIANCE_TOL_PCT = 15;
// A converged design concentrates mass into solid/void; the run must stiffen to
// well under half the uniform-density starting compliance.
const MAX_COMPLIANCE_RATIO = 0.3;

function buildModel() {
  const mesh = boxHexMesh(L, H, T, NX, NY, 1);
  const tol = 1e-9;
  const bc = dirichletBuilder();
  for (let v = 0; v < mesh.vertices.length; v++) {
    const [x, y] = mesh.vertices[v];
    bc.fix(v, 2); // u_z = 0 everywhere → 2D (plane) behaviour
    if (x <= tol) bc.fix(v, 0); // symmetry plane: u_x = 0 on x = 0
    if (x >= L - tol && y <= tol) bc.fix(v, 1); // roller: u_y = 0 at (L, 0)
  }
  // Half the central point load, pressing down at the top of the symmetry edge.
  const loaded = verticesWhere(mesh, (x, y) => x <= tol && y >= H - tol);
  return {
    mesh,
    bcs: { ...bc.build(), point_loads: distributeForce(loaded, [0, -1, 0]) },
  };
}

// Compact ASCII of the single-layer density field, top row first: '#' solid,
// ':' intermediate, ' ' void. Printed as visual evidence of the emergent truss.
function layoutArt(density, mesh) {
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
  name: "MBB beam (half-model)",
  description: `${NX}×${NY} half-beam, volfrac ${VOLFRAC}, p ${PENALTY} — Sigmund/Andreassen`,
  run(optimize) {
    const { mesh, bcs } = buildModel();
    const materials = [{ young_modulus: 1, poisson_ratio: 0.3, density: 1 }];
    const settings = {
      objective: "min_compliance",
      constraints: { volumeFraction: VOLFRAC },
      penalty: PENALTY,
      filterRadius: FILTER_RADIUS,
      moveLimit: MOVE_LIMIT,
      maxIterations: MAX_ITERATIONS,
      tolerance: TOLERANCE,
    };
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

    // MMA legitimately oscillates mid-run while the layout reorganises, so we
    // don't demand a monotone trajectory; we demand the run END at its stiffest
    // design — the returned compliance must be the lowest of the whole history
    // (the optimizer settled on its best, it didn't bounce away from it).
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
      ],
      layout: layoutArt(density, mesh),
    };
  },
};
