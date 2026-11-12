// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// The cantilever of cantilever-bending.mjs on a coarse Netgen mesh (50 mm,
// two elements through the depth) of quadratic (P2) tetrahedra. Quadratic
// elements do not shear-lock, so this mesh lands within a few tenths of a
// percent of the reference, where linear tetrahedra on it are ~27 % too stiff.
// It exercises the solver's order-2 path (edge DOFs, the Dirichlet values on
// them, the quadratic surface-load integration) on a model small enough to
// solve in a second.
//
// The quadratic series of the convergence study (convergence.mjs) settles
// within 0.1 % of the reference; at 50 mm the result sits about 0.4 % from
// that converged value. The 1 % band holds this discretisation error.

import { cantileverPage, cantileverRecipe } from "./cantilever-bending.mjs";

export default {
  id: "cantilever-p2",
  name: "Cantilever beam, quadratic tetrahedra",
  quantity: "tip deflection δ",
  unit: "mm",
  tolPct: 1,
  readout: { field: "Uy", stat: "Min" },
  page: {
    ...cantileverPage,
    summary:
      "The same beam on a coarse mesh of quadratic elements, which do not lock.",
  },
  recipe: cantileverRecipe({ maxElementSize: 50, order: 2 }),
};
