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
  model: ({ inp, row }) => `
        <p>A quarter of the hemisphere, its cut meridians held by symmetry,
        imported as a ${inp("t")}&nbsp;mm solid and marked Shell. The point
        loads of ${inp("F")}&nbsp;N sit on short pieces split off the equator
        edge at A and C, and a short piece of the hole edge is held in
        <i>z</i> against rigid motion. The result does not depend on the
        length of those pieces.</p>
        <p>${row.mesh.elements.toLocaleString("en-US")} flat triangles, each a
        CST membrane with a DKT plate-bending element.</p>`,
  discussion: ({ row, pct }) => `
        <p>KoFEM reads ${pct(row.errPct)} from the NAFEMS target on this
        mesh. The convergence study shows the displacement falling as the
        mesh is refined, to a few percent below the target: flat facets on
        a doubly curved shell carry a little membrane stiffness into bending.
        The band is wide enough for every mesh of the study; it is the widest
        of the NAFEMS pages, and the reason is this trend, not scatter.</p>`,
  references: [REF.nafems, REF.batoz],
};
