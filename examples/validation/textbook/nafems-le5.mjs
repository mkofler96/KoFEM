// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Page text: NAFEMS LE5, the Z-section cantilever.

import { zSectionFigure } from "../lib/figures.mjs";
import { REF } from "./refs.mjs";

export default {
  description:
    "NAFEMS benchmark LE5: a Z-section cantilever under torque, the warping stress the clamped root raises, against KoFEM's shell triangles.",
  searchTitle: "NAFEMS LE5 Z-section cantilever benchmark",
  figure: () => zSectionFigure(),
  intro: ({ tex, n, row }) => `
        <p>A 10&nbsp;m cantilever with a Z cross-section, twisted at its free
        end. An open section twists by warping: its flanges move along the
        beam in opposite directions. The clamped root stops that, so axial
        stresses build up near it. NAFEMS reads
        ${tex(`σ_{xx} = ${n(row.reference)}\\text{ MPa}`)} at A, on the free
        edge of the lower flange, 2.5&nbsp;m from the root.</p>`,
  theory: ({ tex, texBlock }) => `
        <p>An open thin-walled section twists by warping: each point moves
        along the beam by ${tex("u = -ω θ'")}, with ${tex("ω")} the sectorial
        coordinate of the section and ${tex("θ'")} the rate of twist. Where
        the clamped root stops the warping, the twist rate varies along the
        beam and the warping carries an axial stress (Vlasov),</p>
        ${texBlock("σ_{xx} = -E \\, ω \\, θ''.")}
        <p>It is largest at the flange tips, where ${tex("|ω|")} is largest,
        and dies away from the root.</p>`,
  model: ({ inp, row }) => `
        <p>The beam is imported as one solid, its end face cut into web and
        flanges so that each flange's shear sits on a whole face. The torque
        is the couple of the two shears, <i>T</i>&nbsp;=&nbsp;${inp("T") / 1e9}&nbsp;MN·m.
        The beam runs along the app's <i>z</i> axis, so NAFEMS'
        <i>σxx</i> is the app's <i>σzz</i>.</p>
        <p>The body is marked Shell, as NAFEMS meant it: each wall collapses
        to its mid-surface, and web and flanges are welded where their
        mid-planes cross at the corners.
        ${row.mesh.elements.toLocaleString("en-US")} linear shell
        triangles.</p>`,
  discussion: ({ row, pct }) => `
        <p>KoFEM reads ${pct(row.errPct)} from the NAFEMS target. The
        convergence study shows the shell approaching it from below as the
        mesh is refined.</p>`,
  references: [REF.nafems],
};
