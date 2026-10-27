// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Cantilever beam, second-order (P2) elements — regression guard for the
// element_order = 2 solver path (added in PR #281, issue #303).
//
//   Same beam as cantilever-bending.mjs (fixed at x=0, transverse tip load P),
//   tip deflection δ = P·L³ / (3·E·I),  I = b·h³/12.
//
// The mesh here is deliberately COARSE (10×2×2 hexes). Linear (P1) hexes
// shear-lock badly on a span this coarse — they predict only ~70% of the true
// tip deflection (~30% error). Quadratic (P2) elements on the *same* mesh
// recover the deflection to <2%, so this case both:
//
//   1. exercises the order ≥ 2 branch in solve_mfem.cpp that order-1 cases
//      never touch — the edge-midpoint Dirichlet extension that clamps the
//      mid-edge DOFs on the x=0 face, and the tight 1e-6 CG tolerance with the
//      raised iteration cap, and
//   2. asserts P2 is materially more accurate than P1 on the same elements;
//      the 4% tolerance is comfortably below P1's ~30% error here, so a
//      regression that drops the P2 DOFs back to P1 behaviour (or fails to
//      constrain edge midpoints) breaks this case.
//
// Reference: Euler–Bernoulli beam theory (Gere & Goodno, deflections of beams).

import {
  cantileverInputs,
  cantileverReference,
  cantileverTip,
} from "./cantilever-bending.mjs";

const DIV = [10, 2, 2]; // elements along x, y, z

export default {
  id: "cantilever-p2",
  name: "Cantilever beam (P2, coarse mesh)",
  quantity: "tip deflection δ",
  unit: "m",
  reference: cantileverReference,
  referenceLabel: "δ = P·L³ / (3·E·I)",
  tolPct: 4,
  page: {
    summary: "The same beam on a coarse mesh with quadratic elements.",
    model: "Beam of span L along x, b × h section, I = b·h³/12.",
    inputs: cantileverInputs,
    supports: "x = 0 face clamped.",
    loads: "P in −y, split equally over the x = L face vertices.",
    measured: "Mean y-displacement of the x = L face vertices.",
    mesh: `${DIV.join(" × ")} grid`,
    source: "Euler–Bernoulli beam theory",
    grid: DIV,
  },
  run(solve) {
    return cantileverTip(solve, DIV, 2); // second-order (P2) elements
  },
};
