// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Page text: NAFEMS LE6, the skew plate under normal pressure.

import { skewPlateFigure } from "../lib/figures.mjs";
import { REF } from "./refs.mjs";

export default {
  description:
    "NAFEMS benchmark LE6: a 30° skew plate under pressure, the largest principal stress at its centre, against KoFEM's shell triangles.",
  searchTitle: "NAFEMS LE6 skew plate benchmark",
  figure: () => skewPlateFigure(),
  intro: ({ tex, n, row }) => `
        <p>A thin rhombic plate, its corners skewed by 30°, simply supported
        on every edge and pressed by a uniform pressure. Skew plates are a
        classic trap for plate elements. NAFEMS reads the largest principal
        stress ${tex(`σ_{1} = ${n(row.reference)}\\text{ MPa}`)} on the lower
        surface at the centre E.</p>`,
  theory: ({ tex, texBlock }) => `
        <p>A thin plate under a lateral pressure bends as a Kirchhoff plate,
        its deflection ${tex("w")} governed by</p>
        ${texBlock("D \\, \\nabla^{4} w = p, \\quad D = \\frac{E t^{3}}{12 (1 - ν^{2})},")}
        <p>and the bending moments give the surface stresses
        ${tex("σ = 6 M / t^{2}")}. On a skew plate the obtuse corners stiffen
        the plate, the principal moments turn away from the edges, and no
        closed form exists: NAFEMS' target is a converged numerical one.</p>`,
  model: ({ row }) => `
        <p>The plate is imported as a 10&nbsp;mm thick solid and marked Shell;
        the app collapses it to its mid-surface. Each edge is held in all
        three translations with its rotations free: a flat plate under a
        normal load does not stretch its mid-surface, so holding the edges in
        their plane carries no force, and it stands in for NAFEMS' point
        supports against rigid motion. A probe reads the largest principal
        stress on the bottom surface at E.</p>
        <p>${row.mesh.elements.toLocaleString("en-US")} triangles, each a CST
        membrane with a DKT plate-bending element.</p>`,
  discussion: ({ row, pct }) => `
        <p>KoFEM reads ${pct(row.errPct)} from the NAFEMS target, and the
        convergence study shows it settling about half a percent above it.
        The DKT element is free of the skew sensitivity some plate elements
        show.</p>`,
  references: [REF.nafems, REF.batoz],
};
