// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Page text: NAFEMS LE5, the Z-section cantilever.

import { zSectionFigure } from "../lib/figures.mjs";
import { REF } from "./refs.mjs";

export default {
  description:
    "NAFEMS benchmark LE5: a Z-section cantilever under torque, the warping stress the clamped root raises, against KoFEM's quadratic tetrahedra.",
  searchTitle: "NAFEMS LE5 Z-section cantilever benchmark",
  figure: () => zSectionFigure(),
  intro: ({ tex, n, row }) => `
        <p>A 10&nbsp;m cantilever with a Z cross-section, twisted at its free
        end. An open section twists by warping: its flanges move along the
        beam in opposite directions. The clamped root stops that, so axial
        stresses build up near it. NAFEMS reads
        ${tex(`σ_{xx} = ${n(row.reference)}\\text{ MPa}`)} at A, on the free
        edge of the lower flange, 2.5&nbsp;m from the root.</p>`,
  model: ({ inp, row }) => `
        <p>The beam is imported as one solid, its end face cut into web and
        flanges so that each flange's shear sits on a whole face. The torque
        is the couple of the two shears, <i>T</i>&nbsp;=&nbsp;${inp("T") / 1e9}&nbsp;MN·m.
        The beam runs along the app's <i>z</i> axis, so NAFEMS'
        <i>σxx</i> is the app's <i>σzz</i>.</p>
        <p>NAFEMS meant the walls for shells. KoFEM's shell idealisation welds
        walls where one stands on another (a T-junction) but not yet at the
        L-corners of a Z, so the beam is solid:
        ${row.mesh.elements.toLocaleString("en-US")} quadratic tetrahedra.</p>`,
  discussion: ({ row, pct }) => `
        <p>KoFEM reads ${pct(row.errPct)} from the NAFEMS target. The
        convergence study shows the solid settling slightly beyond the thin-shell
        value: walls 0.1&nbsp;m thick on a section 2&nbsp;m deep are not quite
        thin.</p>`,
  references: [REF.nafems],
};
