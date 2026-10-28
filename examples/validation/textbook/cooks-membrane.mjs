// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Case page text: Cook's membrane.

import { cookFigure } from "../lib/figures.mjs";
import { REF } from "./refs.mjs";

export default {
  description:
    "Cook's membrane, the tapered-panel benchmark for skewed elements in bending and shear: setup, reference value, mesh convergence and KoFEM's result.",
  figure: ({ page }) => cookFigure({ n: page.grid[0] }),
  intro: () => `
        <p>Cook's membrane (1974) is a tapered panel, clamped on one edge and
        sheared on the other. It has no closed-form solution. The finite
        element literature uses it because it combines bending and shear on a
        mesh that cannot be rectangular, which exposes elements that lock or
        lose accuracy when distorted.</p>`,
  theory: ({ tex }) => `
        <p>The panel is the quadrilateral with corners (0, 0), (48, 44),
        (48, 60) and (0, 44), of unit thickness, with ${tex("E = 1")} and
        ${tex("ν = 1/3")}. A total shear force ${tex("F = 1")} is spread
        uniformly over the right edge, and the left edge is clamped. All
        quantities are dimensionless. The result compared is the vertical
        displacement of the top-right corner C.</p>
        <p>Without an analytical solution, the reference is the converged
        value of very fine plane-stress meshes reported in the literature,
        about 23.9.</p>
        <p>The panel behaves like a short, tapered cantilever: span 48, depth
        tapering from 44 to 16. Linear elements lock in its bending, as in the
        <a href="/validation/cantilever/">cantilever</a>, and every element is
        skewed, so elements whose accuracy depends on rectangular shapes do
        poorly. Coarse meshes of simple elements land far below 23.9.</p>`,
  model: ({ tex }) => `
        <p>KoFEM is a 3-D solver, so the panel is a slab of thickness
        ${tex("t = 1")} with one element through the thickness, clamped over
        the whole ${tex("x = 0")} face. The load ${tex("F")} is split equally
        over the nodes of the ${tex("x = 48")} face, and the result is the
        mean vertical displacement of the two nodes at C.</p>`,
  discussion: ({ row, pct, study, page }) => {
    const p1 = study.series.find((s) => s.order === 1).points;
    const p2 = study.series.find((s) => s.order === 2).points;
    const l1 = p1[p1.length - 1],
      l2 = p2[p2.length - 1];
    return `
        <p>On the ${page.grid[0]} × ${page.grid[1]} case mesh
        KoFEM gives ${row.fe.toFixed(2)}, which differs from 23.9 by
        ${pct(row.errPct)}. The
        convergence study shows that this agreement is partly coincidence.
        Under refinement both linear and quadratic elements move past the
        reference, to ${l1.fe.toFixed(2)} (linear, ${l1.mesh}) and
        ${l2.fe.toFixed(2)} (quadratic, ${l2.mesh}), and they have not yet
        levelled off at a common value.</p>
        <p>A converging discretisation of the same problem would approach one
        value from both element orders. So the 3-D model here is not yet the
        problem the 23.9 reference solves. Possible causes, not yet resolved,
        are the 3-D slab clamped over a face versus the 2-D plane-stress
        model, and the equal nodal split of the edge load, which also puts a
        nodal force on the measured corner. Until this is reconciled the case
        is a regression check: it catches a change in the solver's answer,
        but it is not evidence of accuracy.</p>`;
  },
  references: [REF.cook1974, REF.cmpw],
};
