// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Page text: NAFEMS LE4, the hyperbolic shell under internal pressure.

import { meridianFigure } from "../lib/figures.mjs";
import { REF } from "./refs.mjs";

export default {
  description:
    "NAFEMS benchmark LE4: a hyperbolic shell of revolution under internal pressure, the membrane stresses at its waist against KoFEM's curved shells.",
  searchTitle: "NAFEMS LE4 hyperbolic shell under pressure",
  figure: () =>
    meridianFigure({
      start: [1, 0],
      segments: Array.from({ length: 8 }, (_, k) => {
        const z = (k + 1) / 8;
        return { type: "line", to: [Math.sqrt(1 + z * z), z] };
      }),
      closed: false,
      points: { K: [1, 0], A: [Math.SQRT2, 1] },
      name: "hyperboloid-diagram",
      label:
        "Meridian of the hyperbolic shell r² − z² = 1 m², from its waist K up to the free edge A",
      note: "internal pressure; waist z = 0 a symmetry plane",
    }),
  intro: ({ tex, n, row }) => `
        <p>A shell of revolution shaped like a cooling tower, its meridian the
        hyperbola ${tex("r^{2} - z^{2} = a^{2}")}, under internal pressure. At
        the waist K the pressure pulls the shell into compression along the
        meridian and tension around it. NAFEMS gives
        ${tex(`σ_{φφ} = ${n(row.reference)}\\text{ MPa}`)} along the meridian
        and the same magnitude, in tension, around it.</p>`,
  theory: ({ tex, texBlock }) => `
        <p>Membrane theory settles both: the free top edge carries no
        meridional force, and the axial equilibrium of the shell above any
        circle fixes the meridional force there. At the waist, where the
        meridian is vertical,</p>
        ${texBlock("N_{φ} = -\\frac{p}{2 a}\\left(r_{A}^{2} - a^{2}\\right), \\qquad σ_{φφ} = \\frac{N_{φ}}{t}.")}`,
  model: ({ inp, row }) => `
        <p>A quarter of the shell's upper half: the cut meridians held by
        symmetry and the waist <i>z</i>&nbsp;=&nbsp;0 a symmetry plane; the top
        edge is free. It is imported as a ${inp("t")}&nbsp;mm solid and
        marked Shell, the pressure of ${inp("p")}&nbsp;MPa on its outer face
        pulling outward. At K the meridian is vertical, so the meridional
        stress is <i>σzz</i>, read on the middle surface.</p>
        <p>${row.mesh.elements.toLocaleString("en-US")} flat triangles.</p>`,
  discussion: ({ row, pct }) => `
        <p>KoFEM reads ${pct(row.errPct)} from the NAFEMS target, and the
        convergence study shows both the meridional and, beside it, the hoop
        stress settling onto ±50&nbsp;MPa as the mesh is refined.</p>`,
  references: [REF.nafems, REF.timoshenkoGoodier],
};
