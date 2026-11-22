// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Page text: NAFEMS LE1, the elliptic membrane.

import { ellipticMembraneFigure } from "../lib/figures.mjs";
import { REF } from "./refs.mjs";

export default {
  description:
    "NAFEMS benchmark LE1: an elliptic membrane in plane stress, σyy at the sharp end of the inner ellipse, against KoFEM's quadratic tetrahedra.",
  searchTitle: "NAFEMS LE1 elliptic membrane benchmark",
  figure: () => ellipticMembraneFigure({ load: "outward" }),
  intro: ({ tex, n, row }) => `
        <p>The first of the NAFEMS linear-elastic benchmarks, the standard
        tests commercial codes publish their results for. A quarter of an
        elliptic ring is pulled outward along its outer edge. Where the inner
        ellipse is sharpest, at D, the tangential stress peaks at
        ${tex(`σ_{yy} = ${n(row.reference)}\\text{ MPa}`)}.</p>`,
  theory: ({ tex, texBlock }) => `
        <p>In plane stress the faces of the ring carry no load, so
        ${tex("σ_{zz} = τ_{xz} = τ_{yz} = 0")} through the thickness. At D the
        free inner edge meets the symmetry line ${tex("y = 0")}: the stress
        normal to the edge vanishes and only the tangential stress
        ${tex("σ_{yy}")} remains. It peaks there because the inner ellipse is
        sharpest at D, with the radius of curvature</p>
        ${texBlock("ρ_{D} = \\frac{b^{2}}{a} = \\frac{(1\\text{ m})^{2}}{2\\text{ m}} = 0.5\\text{ m}.")}
        <p>The ring is too short for a closed-form solution: NAFEMS' target is
        a converged numerical one.</p>`,
  model: ({ inp, row }) => `
        <p>The ring is ${inp("t")}&nbsp;mm thick and in plane stress, so it
        is modelled as a thin solid: the faces through the thickness are
        free, and the model keeps half of the thickness, with its mid-plane
        held in <i>z</i> by symmetry. The cut edges are held by rollers, and
        the outer face carries an outward pressure of ${inp("p")}&nbsp;MPa
        (the app's pressure pushes along the inward normal, so it is entered
        as negative).</p>
        <p>Netgen fills it with ${row.mesh.elements.toLocaleString("en-US")}
        quadratic tetrahedra. Each element's stress is recovered at its
        corners and averaged over the elements that meet at a node; a probe
        placed at D by its coordinates reads <i>σyy</i> there.</p>`,
  discussion: ({ row, pct }) => `
        <p>KoFEM reads ${pct(row.errPct)} from the NAFEMS target. NAFEMS'
        own coarse meshes of linear triangles read as much as half the peak:
        a constant-stress element cannot follow the steep rise towards D.
        Quadratic elements follow it, and the convergence study shows the
        read-out settling onto the target as the mesh is refined.</p>`,
  references: [REF.nafems],
};
