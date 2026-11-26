// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Page text: NAFEMS LE3, the hemisphere with point loads.

import { meridianFigure } from "../lib/figures.mjs";
import { REF } from "./refs.mjs";

const top = (72 * Math.PI) / 180;

export default {
  description:
    "NAFEMS benchmark LE3: a hemispherical shell with an 18° hole, pinched by point loads, the radial displacement at A against KoFEM's curved shells.",
  searchTitle: "NAFEMS LE3 hemisphere with point loads",
  figure: () =>
    meridianFigure({
      start: [10, 0],
      segments: [
        {
          type: "arc",
          to: [10 * Math.cos(top), 10 * Math.sin(top)],
          center: [0, 0],
          ccw: true,
        },
      ],
      closed: false,
      points: { A: [10, 0], E: [10 * Math.cos(top), 10 * Math.sin(top)] },
      name: "hemisphere-diagram",
      label:
        "Meridian of the hemisphere of radius 10 m from the equator at A up to the 18° hole at E; A and C on the equator carry the point loads",
      note: "2 kN out at A, in at C (quarter model)",
    }),
  intro: ({ tex, n, row }) => `
        <p>A hemisphere of radius 10&nbsp;m and 40&nbsp;mm wall, open at the
        pole by an 18° hole, pinched on its equator: pushed out at A and in at
        C, a quarter turn apart. The shell bends almost without stretching,
        which makes this a hard test for shell elements: one that cannot bend
        without stretching locks and moves far too little. NAFEMS gives the
        radial displacement ${tex(`u_{x} = ${n(row.reference)}\\text{ mm}`)} at
        A.</p>`,
  theory: ({ tex, texBlock }) => `
        <p>A Kirchhoff shell strains through its thickness as its
        mid-surface stretches and bends:</p>
        ${texBlock("ε(z) = ε_{m} + z κ, \\quad -\\frac{t}{2} \\le z \\le \\frac{t}{2}.")}
        <p>Pinched at four points, a thin hemisphere deforms almost without
        stretching its mid-surface (${tex("ε_{m} \\approx 0")}): all its
        work goes into bending. An element that cannot bend without
        stretching stores membrane energy that is not there and moves far
        too little.</p>`,
  model: ({ inp, row }) => `
        <p>A quarter of the hemisphere, its cut meridians held by symmetry,
        imported as a ${inp("t")}&nbsp;mm solid and marked Shell. The point
        loads of ${inp("F")}&nbsp;N sit on short pieces split off the equator
        edge at A and C, and a short piece of the hole edge is held in
        <i>z</i> against rigid motion. The result does not depend on the
        length of those pieces.</p>
        <p>${row.mesh.elements.toLocaleString("en-US")} flat triangles, each an
        OPT drilling membrane with a DKT plate-bending element.</p>`,
  discussion: ({ row, pct }) => `
        <p>KoFEM reads ${pct(row.errPct)} from the NAFEMS target on this
        mesh, and the convergence study shows the displacement settling about
        1 % above it as the mesh is refined. The drilling rotation of each
        facet's membrane is the in-plane rotation about the smooth surface's
        normal; held by a fictitious spring instead, it stiffened the bending
        of neighbouring facets more the finer the mesh, and the result drifted
        below the target.</p>`,
  references: [REF.nafems, REF.batoz, REF.felippa2003],
};
