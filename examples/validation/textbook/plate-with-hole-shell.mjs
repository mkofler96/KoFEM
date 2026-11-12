// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Page text: the plate with a hole as a shell mid-surface.

import { quarterPlateFigure } from "../lib/figures.mjs";
import { REF } from "./refs.mjs";

export default {
  description:
    "Kirsch's plate with a hole meshed as a shell: the app collapses the plate to its mid-surface, and KoFEM's shell triangles give the stress concentration Kt = 3.",
  figure: () => quarterPlateFigure(),
  intro: ({ tex }) => `
        <p>Kirsch's plate with a hole, modelled as a thin-walled part usually
        is: one layer of shell elements on the mid-surface, with the thickness
        as a property, instead of solid elements through the thickness.
        Loaded in its own plane, the shell carries the load as membrane
        stress, so Kirsch's ${tex("K_{\\mathrm{t}} = 3")} is the
        reference.</p>`,
  theory: ({ tex, url }) => `
        <p>The derivation is on the
        <a href="${url("plate-with-hole")}#theory">solid plate's page</a>. On
        the edge of the hole the hoop stress is
        ${tex("σ_{θθ} = σ (1 - 2 \\cos 2θ)")}, largest at
        ${tex("θ = ±90°")}, so ${tex("K_{\\mathrm{t}} = 3")}. The solution
        is a plane-stress solution, which is exactly the state of a flat shell
        loaded in its plane. It is for an infinite plate: only the ratio of
        the hole to the plate matters, and at ${tex("a/b = 0.1")} this plate
        is close to Kirsch's infinite one. The solid example is a narrower
        strip, so its reference is Howland's value for that width
        instead.</p>`,
  model: ({ row, tex, inp }) => `
        <p>The plate is a square of half-width
        ${tex(`b = ${inp("b") / inp("a")} a`)}, and ${tex("t")} =
        ${inp("t")}&nbsp;mm thick, thin enough for the app to treat as a shell
        (walls up to 15 mm). By symmetry, a quarter of it is enough: the cut
        edges keep their symmetry, and the edge ${tex("x = b")} is pulled
        with ${tex("σ b t")}.</p>
        <p>Netgen meshes the solid quarter plate, and the app then measures
        the ${inp("t")}&nbsp;mm wall and replaces it by its mid-surface. The
        faces through the wall, such as the edge faces and the hole, become
        the edges of the shell, so each support and the load is picked as an
        Edge. A force on an edge is spread as a uniform line load
        ${tex("q = σ t")}.</p>
        <p>Each of the ${row.mesh.elements.toLocaleString("en-US")} triangles
        combines a CST membrane, which carries in-plane loads with constant
        strain, and a DKT plate-bending element; in this load case only the
        membrane part works. Shell nodes carry six degrees of freedom, three
        translations and three rotations. The out-of-plane ones are held on
        the symmetry edges, which changes nothing here but keeps the plate from
        floating.</p>`,
  discussion: ({ row, rowOf, pct, tex, url }) => `
        <p>KoFEM's ${tex("K_{\\mathrm{t}}")} is ${pct(row.errPct)} from 3, read
        as the Results panel reads it: the largest nodal von Mises stress.
        Each triangle has one stress, the one at its centroid, and the app
        averages those to the nodes. At the hole edge the stress falls off
        steeply, so the triangles around the peak node have centroids where it
        is already lower, and the average reads the peak low. The mesh study
        above shows ${tex("K_{\\mathrm{t}}")} rising towards 3 as the triangles
        shrink.</p>
        <p>The mesh panel sets one element size for the whole plate, and Netgen
        meshes the solid plate in tetrahedra before the app collapses it, so a
        finer mesh at the hole costs a finer mesh everywhere. The 1 mm mesh
        here is the finest that solves in about a minute. The tolerance band
        allows for the discretisation error left at that size.</p>
        <p>The <a href="${url("plate-with-hole")}">solid plate with a
        hole</a> is a different model: a narrower strip, an eighth of it in
        quadratic tetrahedra, checked against Howland's 3.14 for its width.
        It comes out ${pct(rowOf("plate-with-hole").errPct)}. This page shows
        what one layer of linear shell triangles does with the same kind of
        peak.
        Shells pay off when a thin wall bends: one layer of shell elements
        bends by construction, while solid elements need several layers
        through the thickness, or quadratic elements, to do the same (see the
        <a href="${url("cantilever-beam")}">cantilever</a>).</p>`,
  references: [REF.kirsch, REF.timoshenkoGoodier, REF.batoz, REF.cmpw],
};
