// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Page text: axial bar compressed by an end pressure.

import { barFigure } from "../lib/figures.mjs";
import { REF } from "./refs.mjs";

export default {
  description:
    "A bar compressed by a uniform end pressure, u = −pL/E: the sign and area scaling of pressure loads, checked against KoFEM.",
  figure: ({ page }) => barFigure({ load: "pressure", div: page.grid }),
  intro: ({ url }) => `
        <p>The <a href="${url("axial-bar")}">axial bar</a> again, now
        compressed by a uniform pressure on its end face. Pressure pushes along
        the inward normal, so a positive pressure must shorten the bar. The
        example checks the sign of pressure loads and that a pressure is
        treated as a force per area, not as a total force.</p>`,
  theory: ({ tex, texBlock, n, row, inp, url }) => `
        <p>On the end face the outward normal is ${tex("n = e_{x}")}, so the
        traction is ${tex("t = -p n = -p e_{x}")}. The bar carries an axial
        force ${tex("N = -p A")} and a uniform compressive stress
        ${tex("σ_{xx} = -p")}. Following the
        <a href="${url("axial-bar")}">axial bar derivation</a>,</p>
        ${texBlock("u(L) = \\frac{N L}{E A} = -\\frac{p L}{E}.")}
        <p>The cross-section cancels: an end pressure shortens a bar by the
        same amount whatever its size. With
        ${tex(`p = ${n(inp("p"))}\\text{ MPa}`)}, the tip moves by
        ${tex(`u(L) = ${n(row.reference)}\\text{ mm}`)}.</p>`,
  model: ({ tex, url }) => `
        <p>The pressure is integrated over the end face with the same
        boundary integrator as the
        <a href="${url("axial-bar")}">axial bar's</a> force, with the traction
        ${tex("t = -p n")} built from each face's normal.</p>`,
  discussion: ({ row, rowOf, pct, tex, n, inp, inpOf }) => {
    const [W, H] = inp("W × H");
    return `
        <p>The difference, ${pct(row.errPct)}, matches the axial bar in tension
        (${pct(rowOf("axial-bar").errPct)}). That is what linearity predicts:
        the resultant here is ${tex(`p A = ${n((inp("p") * W * H) / 1e3)}\\text{ kN}`)}
        instead of ${tex(`P = ${n(inpOf("axial-bar", "P") / 1e3)}\\text{ kN}`)}, and every displacement scales with the load. An
        identical relative difference shows that the pressure path builds the
        same load vector as the force path with ${tex("t = -p n")}, so both
        its sign and its area scaling are right.</p>
        <p>The two ways this could go wrong are easy to spot. A flipped sign
        would stretch the bar instead (about −200&nbsp;%). Treating
        ${tex("p")} as a total force instead of a force per area would be off
        by a factor of ${tex(`A = ${n(W * H)}\\text{ mm}^2`)}.</p>`;
  },
  references: [REF.gere],
};
