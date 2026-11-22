// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Page text: NAFEMS LE2, the cylindrical shell bending patch test.

import { cylindricalPanelFigure } from "../lib/figures.mjs";
import { REF } from "./refs.mjs";

export default {
  description:
    "NAFEMS benchmark LE2: a cylindrical shell panel bent by an edge moment, the uniform bending stress against KoFEM's curved shells.",
  searchTitle: "NAFEMS LE2 cylindrical shell patch test",
  figure: () => cylindricalPanelFigure(),
  intro: ({ tex, n, row }) => `
        <p>A patch test for curved shells: a 30° panel of a cylinder, clamped
        along one straight edge and bent by a uniform moment along the other.
        It bends into a uniform state, so the stress on its outer surface is
        ${tex(`6 m / t^{2} = ${n(row.reference)}\\text{ MPa}`)} everywhere,
        on any mesh.</p>`,
  theory: ({ tex, texBlock }) => `
        <p>The edge moment ${tex("m")} per unit length is carried unchanged
        around the panel, so every section bends under the same moment. With
        the curved edges held axially, the outer surface carries</p>
        ${texBlock("σ_{θθ} = \\frac{6 m}{t^{2}}, \\qquad σ_{zz} = ν σ_{θθ}, \\qquad τ = 0.")}
        <p>The largest principal stress is therefore ${tex("σ_{θθ}")}, which is
        what the probe reads: the hoop direction at E is no global axis.</p>`,
  model: ({ inp, row }) => `
        <p>The panel is imported as a ${inp("t")}&nbsp;mm thick solid and
        marked Shell: the app collapses the curved wall onto its mid-surface
        and gives every triangle the measured thickness. The outer face is
        the shell's top surface. The moment is entered about the panel's
        axis on its straight edge; that edge lies on the axis, so the app
        applies it as nodal moments shared along the edge by length.</p>
        <p>${row.mesh.elements.toLocaleString("en-US")} flat triangles, each a
        CST membrane with a DKT plate-bending element, model the curved
        panel.</p>`,
  discussion: ({ row, pct }) => `
        <p>KoFEM reads ${pct(row.errPct)} from the uniform bending stress,
        and the convergence study shows the difference staying put as the
        mesh is refined: what remains is the flat facets standing in for the
        curved surface, not the mesh size.</p>`,
  references: [REF.nafems, REF.batoz],
};
