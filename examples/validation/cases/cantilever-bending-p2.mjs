// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// The cantilever of cantilever-bending.mjs on a mesh four times coarser in each
// direction, with second-order (P2) elements. Quadratic elements do not shear-
// lock, so this coarse mesh lands within a few percent where linear elements
// on it are ~30 % too stiff. It exercises the engine's order-2 path (edge
// midpoint DOFs, Dirichlet extension to them, the tighter CG tolerance) that
// the order-1 cases never reach.

import {
  cantileverInputs,
  cantileverModel,
  cantileverReference,
  cantileverTip,
} from "./cantilever-bending.mjs";

const DIV = [10, 2, 2]; // elements along x, y, z

export default {
  id: "cantilever-p2",
  name: "Cantilever beam, quadratic hexahedra",
  quantity: "tip deflection δ",
  unit: "mm",
  reference: cantileverReference,
  referenceLabel: "δ = P·L³ / (3·E·I)",
  tolPct: 4,
  readout: { field: "Uy", stat: "Min" },
  page: {
    summary:
      "The same beam on a coarse mesh of quadratic elements, which do not lock.",
    model: "Beam of span L along x, b × h section, I = b·h³/12.",
    inputs: cantileverInputs,
    supports: "x = 0 face fixed (Ux, Uy, Uz).",
    loads: "P in −y as a force on the x = L face.",
    measured: "Mean y-displacement of the x = L face vertices.",
    mesh: `${DIV.join(" × ")} grid`,
    source: "Euler–Bernoulli beam theory",
    grid: DIV,
  },
  model() {
    return cantileverModel(this.name, DIV, 2);
  },
  measure: cantileverTip,
};
