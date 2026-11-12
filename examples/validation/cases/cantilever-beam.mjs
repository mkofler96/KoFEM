// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// The cantilever beam that opens ready to run (KOF-261): the cantilever of
// cantilever-bending.mjs on a 25 mm Netgen mesh (four elements through the
// depth) of quadratic tetrahedra. Its analysis file opens unsolved on the
// static study, and after Run the Results panel compares the tip deflection
// with −P·L³ / (3·E·I). The app's tests open it (?example=cantilever-beam) as
// the standard solved-in-seconds model.
//
// The quadratic series of the convergence study (convergence.mjs) settles
// within 0.1 % of the reference; at 25 mm the result sits about 0.1 % from
// that converged value. The 1 % band holds this discretisation error.
//
// Until KOF-322 this was a showcase with its own generator
// (examples/gallery/generate-cantilever.mjs); the recipe reproduces its model
// and number.

import { cantileverPage, cantileverRecipe } from "./cantilever-bending.mjs";

export default {
  id: "cantilever-beam",
  name: "Cantilever beam under tip load",
  quantity: "tip deflection δ",
  unit: "mm",
  tolPct: 1,
  readout: { field: "Uy", stat: "Min" },
  page: {
    ...cantileverPage,
    summary:
      "The cantilever that opens ready to run, with a hand check in the Results panel.",
  },
  recipe: cantileverRecipe({ maxElementSize: 25, order: 2 }),
};
