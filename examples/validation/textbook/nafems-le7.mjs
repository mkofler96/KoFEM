// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Page text: NAFEMS LE7, the cylinder with a hemispherical cap.

import { meridianFigure } from "../lib/figures.mjs";
import { REF } from "./refs.mjs";

export default {
  description:
    "NAFEMS benchmark LE7: a thin cylindrical pressure vessel with a hemispherical cap, the axial stress near the junction against KoFEM's curved shells.",
  searchTitle: "NAFEMS LE7 pressure vessel benchmark",
  figure: () =>
    meridianFigure({
      start: [1, 0],
      segments: [
        { type: "line", to: [1, 1.5] },
        { type: "arc", to: [0, 2.5], center: [0, 1.5], ccw: true },
      ],
      closed: false,
      points: { F: [1, 0], D: [1, 1.4034], C: [1, 1.5], A: [0, 2.5] },
      name: "pressure-vessel-diagram",
      label:
        "Meridian of the vessel: a cylinder of radius 1 m from F up to the junction C, a hemispherical cap up to the pole A; D lies on the cylinder just below the junction",
      note: "internal pressure; F held axially",
    }),
  intro: ({ tex, n, row }) => `
        <p>A thin cylinder closed by a hemispherical cap, under internal
        pressure. Away from the junction the cylinder carries the membrane
        stresses ${tex("p r / t")} around and ${tex("p r / 2t")} along it,
        and the hemisphere ${tex("p r / 2t")} in every direction; the two
        would expand by different amounts, so the junction bends. NAFEMS
        reads the axial stress on the outer surface just below the junction,
        ${tex(`σ_{zz} = ${n(row.reference)}\\text{ MPa}`)} at D.</p>`,
  theory: ({ tex, texBlock }) => `
        <p>Away from the junction both parts carry the pressure as membranes:</p>
        ${texBlock("\\text{cylinder: } σ_{θθ} = \\frac{p r}{t}, \\quad σ_{zz} = \\frac{p r}{2 t}; \\quad \\text{sphere: } σ = \\frac{p r}{2 t}.")}
        <p>The cylinder's hoop strain is larger than the sphere's, so the two
        would separate at the junction; bending closes the gap and decays
        over a length of about ${tex("\\sqrt{r t}")}. At D, inside that
        length, the outer surface carries the membrane stress plus that
        bending.</p>`,
  model: ({ inp, row }) => `
        <p>A quarter of the vessel, its cut meridians held by symmetry,
        imported as a ${inp("t")}&nbsp;mm solid and marked Shell: the app
        collapses the cylinder and the cap to one welded mid-surface. The
        bottom edge F is held axially only. The pressure of
        ${inp("p")}&nbsp;MPa acts on the outer face, pulling outward, and
        the outer surface is the shell's top surface, where the probe reads
        <i>σzz</i> at D.</p>
        <p>${row.mesh.elements.toLocaleString("en-US")} flat triangles.</p>`,
  discussion: ({ row, pct }) => `
        <p>KoFEM reads ${pct(row.errPct)} from the NAFEMS target. The
        convergence study shows the bending at the junction resolved once a
        few elements span its decay length.</p>`,
  references: [REF.nafems, REF.timoshenkoGoodier],
};
