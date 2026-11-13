// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Page text: the cantilever in two tied halves, quadratic tetrahedra
// (cases/tie-cantilever.mjs).

import { tieCantileverFigure } from "../lib/figures.mjs";
import { REF } from "./refs.mjs";

export default {
  description:
    "A cantilever cut at mid-span into two separately meshed bodies and tied: bending, shear and moment across a non-matching quadratic interface, against Euler–Bernoulli theory.",
  figure: () => tieCantileverFigure(),
  intro: ({ url }) => `
        <p>The <a href="${url("tie-patch-test")}">patch test</a> shows that a
        uniform stress crosses a tie. Bending is harder: the tie has to carry
        a shear force and a bending moment, with a stress that varies over
        the interface. This beam is the
        <a href="${url("cantilever-beam")}">cantilever</a> cut in two at
        mid-span, the halves meshed on their own with quadratic tetrahedra and
        tied across a gap.</p>`,
  theory: ({ tex, texBlock }) => `
        <p>The tie bridges the gap rigidly, so by Euler–Bernoulli theory the
        beam is one of length ${tex("L + g")} whose segment
        ${tex("L/2 ≤ x ≤ L/2 + g")} does not bend. With the bending moment
        ${tex("M(x) = -P\\,(L + g - x)")}, the unit-load method over the parts
        that do bend gives the tip deflection</p>
        ${texBlock("δ = -\\frac{P}{3 E I}\\left((L+g)^{3} - \\left(\\frac{L}{2}+g\\right)^{3} + \\left(\\frac{L}{2}\\right)^{3}\\right), \\quad I = \\frac{b h^{3}}{12}.")}
        <p>For ${tex("g = 0")} this is the uncut beam's
        ${tex("-P L^{3} / (3 E I)")}.</p>`,
  model: ({ row }) => `
        <p>The two halves are separate solids in one STEP file. Netgen meshes
        each on its own with quadratic tetrahedra and a
        ${row.mesh.maxElementSize}&nbsp;mm maximum element size, so the nodes
        of the two faces at mid-span do not match. On quadratic elements the
        tie is node-to-surface: each node of the slave face, edge midpoints
        included, follows the master face's quadratic displacement field at
        the point it projects onto.</p>`,
  discussion: ({ row, pct, url }) => `
        <p>KoFEM's tip deflection differs from the tied beam's by
        ${pct(row.errPct)}, within the ±${row.tolPct}&nbsp;% band. The
        <a href="${url("cantilever-beam")}">uncut beam</a> on the same mesh
        reads slightly above Euler–Bernoulli, since the solid also deforms
        in shear; the tied beam reads slightly below, a little stiffer. That
        is the node-to-surface tie on quadratic elements, which does not pass
        the patch test across non-matching faces: between the tied nodes the
        two faces interpolate differently and constrain each other a little
        more than a single body would. The dual mortar method removes this on
        linear elements; for quadratic ones it is not implemented yet.</p>`,
  references: [REF.gere, REF.puso2004],
};
