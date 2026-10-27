// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Case page text: axial bar loaded by a uniform surface traction.

import { barFigure } from "../lib/figures.mjs";
import { REF } from "./refs.mjs";

export default {
  description:
    "An axial bar loaded by a uniform surface traction: consistent nodal loads, δ = PL/(EA), and KoFEM's result. The model behind the in-app reproduction.",
  figure: ({ page }) => barFigure({ load: "traction", div: page.grid }),
  intro: () => `
        <p>The <a href="/validation/axial-bar/">axial bar</a> again, loaded the
        way the KoFEM app loads a face: as a uniform traction integrated over
        the element faces into work-equivalent nodal forces. It is the model
        behind the axial-bar gallery example, which you can open and solve in
        the app.</p>`,
  theory: ({ tex, texBlock, n, row }) => `
        <p>The analytical answer is the axial bar's
        (<a href="/validation/axial-bar/">derivation</a>):</p>
        ${texBlock(`δ = \\frac{P L}{E A} = ${n(row.reference)}\\text{ m}.`)}
        <p>What this case adds is the load vector. In the finite element
        method a traction ${tex("t")} on a surface ${tex("Γ")} enters through
        the work it does, so the force on node ${tex("i")} is</p>
        ${texBlock("f_{i} = \\int_{Γ} N_{i}\\, t \\;\\mathrm{d}S,")}
        <p>where ${tex("N_{i}")} is the shape function of that node. On
        linear quadrilateral faces of size ${tex("h × h")} under a uniform
        traction, a node collects ${tex("t h^2 / 4")} from each face it
        touches. An interior node of the end face gets ${tex("t h^2")}, an
        edge node ${tex("t h^2 / 2")} and a corner node ${tex("t h^2 / 4")}.
        The forces add up to ${tex("t A = P")}, and they do the same work as
        the distributed traction on every displacement the elements can
        represent. Splitting ${tex("P")} equally over the nodes, as the
        axial bar case does, gets the total right but not the
        distribution.</p>`,
  model: ({ page }) => `
        <p>KoFEM integrates the traction with MFEM's boundary integrator over
        the ${page.grid[1] * page.grid[2]} quadrilateral element faces of the
        end face. The app does the same when
        a force is applied to a face, which is why this case and the in-app
        reproduction agree.</p>`,
  discussion: ({ row, rowOf, pct, tex }) => `
        <p>The extension differs from ${tex("P L / (E A)")} by
        ${pct(row.errPct)}. With a consistent load, what remains is the clamp.
        The x = 0 face is fully fixed, so near it the bar cannot contract
        sideways. That material is in a multiaxial state and stiffer than the
        1-D model assumes, so the end moves slightly less. It is a difference
        between the 3-D body and the 1-D theory, not discretisation error, so
        it does not go away with a finer mesh.</p>
        <p>The <a href="/validation/axial-bar/">axial bar</a> case, with the
        equal nodal split, comes out ${pct(rowOf("axial-bar").errPct)}:
        there the uneven load distribution pushes the result the other way.
        The <a href="/validation/surface-pressure/">surface pressure</a> case
        reuses this load path with a pressure.</p>`,
  references: [REF.gere, REF.hughes],
};
