// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Page text: the plate with a hole as a shell mid-surface
// (examples/gallery/generate-plate-hole-shell.mjs).

import { plateFigure } from "../lib/figures.mjs";
import { REF } from "./refs.mjs";

export default {
  description:
    "Kirsch's plate with a hole modelled with Kirchhoff shell triangles instead of solid elements: stress concentration Kt = 3 against KoFEM's shell solver.",
  opens: "Opens the solved model in the app.",
  figure: () => plateFigure(),
  intro: ({ tex, url }) => `
        <p>The <a href="${url("plate-with-hole")}">plate with a hole</a>,
        modelled as a thin-walled part usually is: one layer of shell
        elements on the mid-surface, with the thickness as a property, instead
        of solid elements through the thickness. Loaded in its own plane, the
        shell carries the load as membrane stress, so Kirsch's
        ${tex("K_{\\mathrm{t}} = 3")} is the reference here too.</p>`,
  theory: ({ tex, url }) => `
        <p>The derivation is on the
        <a href="${url("plate-with-hole")}#theory">solid plate's page</a>. On
        the edge of the hole the hoop stress is
        ${tex("σ_{θθ} = σ (1 - 2 \\cos 2θ)")}, largest at
        ${tex("θ = ±90°")}, so ${tex("K_{\\mathrm{t}} = 3")}. The solution
        is a plane-stress solution, which is exactly the state of a flat shell
        loaded in its plane.</p>`,
  model: ({ row, tex }) => `
        <p>Each triangle combines a CST membrane, which carries in-plane
        loads with constant strain, and a DKT plate-bending element. In this
        load case only the membrane part works. The mesh is the solid plate's
        O-grid (${row.mesh.rings} rings × ${row.mesh.around} around the hole)
        with every quad split into two triangles, so the hole edge is a
        polygon of ${row.mesh.around} sides. Shell nodes carry six degrees of
        freedom, three translations and three rotations. The load is a force on
        the right edge, which the app spreads as a uniform line load
        ${tex("q = σ t")}.</p>`,
  discussion: ({ row, rowOf, pct, tex, url }) => `
        <p>KoFEM's ${tex("K_{\\mathrm{t}}")} differs from 3 by ${pct(row.errPct)};
        the <a href="${url("plate-with-hole")}">solid model</a> of the same
        plate comes out ${pct(rowOf("plate-with-hole").errPct)}. Both measure
        an element value, so both sit a little away from the edge, where the
        stress has started to fall. A CST triangle has one stress, at its
        centroid, and the first ring of triangles is split from thin quads,
        so half of its centroids sit a third of the way across the ring, closer
        to the edge than the centres of the solid hexahedra. That is one
        reason the shell gets nearer to 3 on the same grid.</p>
        <p>The two models have ${row.mesh.dofs.toLocaleString("en-US")} and
        ${rowOf("plate-with-hole").mesh.dofs.toLocaleString("en-US")} unknowns:
        the shell's ${row.mesh.nodes.toLocaleString("en-US")} nodes carry six
        degrees of freedom each, the solid's
        ${rowOf("plate-with-hole").mesh.nodes.toLocaleString("en-US")} nodes
        three. Shells pay off when a thin wall bends: one layer of shell
        elements bends by construction, while solid elements need several
        layers through the thickness, or quadratic elements, to do the same
        (see the <a href="${url("cantilever")}">cantilever</a>).</p>`,
  references: [REF.kirsch, REF.timoshenkoGoodier, REF.batoz, REF.cmpw],
};
