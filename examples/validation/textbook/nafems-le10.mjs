// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Page text: NAFEMS LE10, the thick plate under pressure.

import { ellipticMembraneFigure } from "../lib/figures.mjs";
import { REF } from "./refs.mjs";

export default {
  description:
    "NAFEMS benchmark LE10: a thick elliptic plate under pressure, σyy on the upper face at D, against KoFEM's quadratic tetrahedra.",
  searchTitle: "NAFEMS LE10 thick plate under pressure benchmark",
  figure: () => ellipticMembraneFigure({ load: "top" }),
  intro: ({ tex, n, row, url }) => `
        <p>The planform of <a href="${url("nafems-le1")}">LE1</a>, now a
        thick plate bent by a pressure on its upper face. NAFEMS reads the
        direct stress ${tex(`σ_{yy} = ${n(row.reference)}\\text{ MPa}`)} on
        the upper face at D, where the inner ellipse meets the symmetry
        plane.</p>`,
  theory: ({ tex, texBlock }) => `
        <p>The plate is thick, a third of its span, so plate theory does not
        describe it: the stress varies through the thickness in all six
        components, and on the upper face the pressure itself is a stress,</p>
        ${texBlock("σ_{zz} = -p \\quad \\text{on } z = t.")}
        <p>NAFEMS' target is a converged three-dimensional solution. At D the
        upper face meets the symmetry plane and the inner face, and
        ${tex("σ_{yy}")} is the bending stress there.</p>`,
  model: ({ inp, row }) => `
        <p>The quarter plate is ${inp("t")}&nbsp;mm thick and modelled whole
        through its thickness. The faces <i>x</i>&nbsp;=&nbsp;0 and
        <i>y</i>&nbsp;=&nbsp;0 are held by symmetry, the outer face in
        <i>x</i> and <i>y</i>, and NAFEMS holds the mid-height line EE′ of the
        outer face in <i>z</i>. Every support in KoFEM sits on whole faces, so
        the model splits a 20&nbsp;mm band out of the outer face around
        mid-height and holds that band in <i>z</i>.</p>
        <p>Netgen fills the plate with ${row.mesh.elements.toLocaleString("en-US")}
        quadratic tetrahedra. Each element's stress is recovered at its
        corners: in a bent plate the stress grows linearly towards the upper
        face, and an element's centre lies below it, so a centre value would
        read well short of the surface stress.</p>`,
  discussion: ({ row, pct }) => `
        <p>KoFEM reads ${pct(row.errPct)} from the NAFEMS target. D is a
        corner where three faces meet, which NAFEMS' own quadratic elements
        read several percent off; the convergence study shows KoFEM's
        read-out steady across the meshes.</p>`,
  references: [REF.nafems],
};
