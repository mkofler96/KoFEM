// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Page text: axial bar in tension, loaded as the app loads a face.

import { barFigure } from "../lib/figures.mjs";
import { REF } from "./refs.mjs";

export default {
  description:
    "A steel bar in uniaxial tension, δ = PL/(EA): derivation, how a face load becomes nodal forces, and KoFEM's result against the closed-form solution.",
  figure: ({ page }) => barFigure({ load: "traction", div: page.grid }),
  intro: () => `
        <p>A straight bar pulled along its axis is the simplest problem in
        solid mechanics, so it is the first thing a solver has to get right.
        The answer involves only the load, the length, the cross-section and
        Young's modulus. If a solver gets this one wrong, the fault is in its
        bookkeeping (units, material, supports or how the load reaches the
        nodes), not in the finite element approximation.</p>`,
  theory: ({ tex, texBlock, n, inp }) => {
    const [W, H] = inp("W × H");
    const A = W * H;
    return `
        <p>Cut the bar at a section ${tex("x")}. Equilibrium of the part to the
        right of the cut needs an internal axial force ${tex("N(x) = P")}, the
        same at every section, because nothing loads the bar between its ends.
        Assume that this force is carried by a normal stress that is uniform
        over the cross-section ${tex("A = W H")}:</p>
        ${texBlock("σ = \\frac{N}{A} = \\frac{P}{A}.")}
        <p>Hooke's law relates the stress to the axial strain, and the strain is
        the rate of change of the axial displacement ${tex("u(x)")}:</p>
        ${texBlock("ε = \\frac{σ}{E}, \\quad ε = \\frac{\\mathrm{d}u}{\\mathrm{d}x}.")}
        <p>With the clamp, ${tex("u(0) = 0")}, the displacement grows linearly
        along the bar,</p>
        ${texBlock("u(x) = \\frac{P x}{E A},")}
        <p>and the loaded end moves by</p>
        ${texBlock("δ = u(L) = \\frac{P L}{E A}.")}
        <p>With the inputs above, ${tex(`A = ${n(A)}\\text{ mm}^2`)}, the stress is
        ${tex(`σ = ${n(inp("P") / A)}\\text{ MPa}`)} and
        ${tex(`δ = ${n((inp("P") * inp("L")) / (inp("E") * A))}\\text{ mm}`)}.</p>
        <p>Two simplifications hide in this one-dimensional model. The stress
        is uniform over every section, and the lateral (Poisson) contraction is
        free everywhere. A 3-D solid meets neither exactly near its ends: the
        clamp prevents the contraction at ${tex("x = 0")}, and at the loaded
        face the stress follows however the load is applied. By Saint-Venant's
        principle these disturbances die out within about one section width, so
        in a bar ten times longer than it is wide they change ${tex("δ")} only
        slightly.</p>`;
  },
  model: ({ tex, texBlock, page }) => `
        <p>The force is applied the way the app applies a force to a face: as
        a uniform traction ${tex("t = P / A")}, integrated over the
        ${page.grid[1] * page.grid[2]} element faces of the end face. In the
        finite element method a traction enters through the work it does, so
        the force on node ${tex("i")} is</p>
        ${texBlock("f_{i} = \\int_{Γ} N_{i}\\, t \\;\\mathrm{d}S,")}
        <p>where ${tex("N_{i}")} is the shape function of that node. On linear
        quadrilateral faces of size ${tex("h × h")}, a node collects
        ${tex("t h^2 / 4")} from each face it touches: an interior node of the
        end face gets ${tex("t h^2")}, an edge node ${tex("t h^2 / 2")} and a
        corner node ${tex("t h^2 / 4")}. The forces add up to
        ${tex("t A = P")}. Splitting ${tex("P")} equally over the nodes instead
        would get the total right but overload the edges and corners.</p>`,
  discussion: ({ row, rowOf, pct, tex, url }) => `
        <p>KoFEM's extension differs from ${tex("P L / (E A)")} by
        ${pct(row.errPct)}. Linear elements represent a linearly varying
        displacement exactly, so the uniform state inside the bar carries no
        discretisation error. What remains is the clamp. The x = 0 face is
        fully fixed, so near it the bar cannot contract sideways. That
        material is in a multiaxial state and stiffer than the 1-D model
        assumes, so the end moves slightly less. It is a difference between
        the 3-D body and the 1-D theory, so a finer mesh does not remove
        it.</p>
        <p>The <a href="${url("surface-pressure")}">same bar under an end
        pressure</a> comes out ${pct(rowOf("surface-pressure").errPct)}: the
        pressure path builds the same load vector.</p>`,
  references: [REF.gere, REF.timoshenkoGoodier, REF.hughes],
};
