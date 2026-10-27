// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Case page text: axial bar (equal nodal point loads).

import { barFigure } from "../lib/figures.mjs";
import { REF } from "./refs.mjs";

export default {
  description:
    "A bar in uniaxial tension, δ = PL/(EA): derivation, finite element model and KoFEM's result against the closed-form solution.",
  figure: ({ page }) => barFigure({ load: "nodal", div: page.grid }),
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
        <p>With the inputs above, ${tex(`A = ${n(A)}\\text{ m}^2`)}, the stress is
        ${tex(`σ = ${n(inp("P") / A / 1e6)}\\text{ MPa}`)} and
        ${tex(`δ = ${n((inp("P") * inp("L")) / (inp("E") * A))}\\text{ m}`)}.</p>
        <p>Two simplifications hide in this one-dimensional model. The stress
        is uniform over every section, and the lateral (Poisson) contraction is
        free everywhere. A 3-D solid meets neither exactly near its ends: the
        clamp prevents the contraction at ${tex("x = 0")}, and at the loaded
        face the stress follows however the load is applied. By Saint-Venant's
        principle these disturbances die out within about one section width, so
        in a bar ten times longer than it is wide they change ${tex("δ")} only
        slightly.</p>`;
  },
  model: ({ tex, page }) => {
    const [, ny, nz] = page.grid;
    const nodes = (ny + 1) * (nz + 1);
    return `
        <p>The force is applied as equal nodal forces: ${tex("P")} divided by
        the ${nodes} nodes of the end face. That is not the work-equivalent
        load of a uniform stress, which gives a corner node a quarter and an
        edge node half the share of an interior node. The
        <a href="/validation/surface-traction/">surface traction case</a>
        loads the same bar that way.</p>`;
  },
  discussion: ({ row, rowOf, pct, tex }) => `
        <p>KoFEM's extension differs from ${tex("P L / (E A)")} by
        ${pct(row.errPct)}.
        Linear elements represent a linearly varying displacement exactly, so
        the uniform state inside the bar carries no discretisation error; the
        difference comes from the ends.</p>
        <p>The equal nodal split puts as much force on a corner node as on an
        interior node, although the corner node represents a quarter of the
        area. The extra local deformation at the edges of the loaded face
        raises the mean end-face displacement, which is the measured quantity.
        The clamp acts the other way: it stiffens the bar slightly. With a
        consistent load, only the clamp effect is left, and the same bar
        comes out ${pct(rowOf("surface-traction").errPct)}
        (<a href="/validation/surface-traction/">surface traction</a>).</p>
        <p>Both effects are properties of the 3-D model against the 1-D theory,
        so refining the mesh does not remove them.</p>`,
  references: [REF.gere, REF.timoshenkoGoodier],
};
