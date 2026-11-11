// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Page text: the patch test across a constraint tie between non-matching meshes.

import { tiePatchFigure } from "../lib/figures.mjs";
import { REF } from "./refs.mjs";

// "4 × 3 × 3 and 5 × 4 × 4 grids, tied" → the two side-view grids [nx, ny].
const grids = (page) =>
  page.mesh
    .split(" and ")
    .map((grid) => grid.split(" × ").map((part) => parseInt(part, 10)));

export default {
  description:
    "The patch test across a tie between non-matching meshes: uniform tension through two differently meshed bodies, why node-to-surface ties fail it and mortar ties pass it.",
  figure: ({ page }) => {
    const [divA, divB] = grids(page);
    return tiePatchFigure({ divA: divA.slice(0, 2), divB: divB.slice(0, 2) });
  },
  intro: () => `
        <p>Parts of an assembly are often meshed separately, so where they
        are joined the nodes on the two sides do not line up. A <em>tie</em>
        joins such surfaces without moving them. The first thing a tie has
        to get right is the simplest load there is: a uniform stress must
        pass through it unchanged. This is the patch test, applied across the
        tie.</p>`,
  theory: ({ tex, texBlock }) => `
        <p>Pull a block with a uniform traction ${tex("σ")} on one end and
        let it slide freely on symmetry planes at the other three sides.
        Every point is then in the same state of uniaxial stress,</p>
        ${texBlock("σ_{xx} = σ, \\quad σ_{yy} = σ_{zz} = σ_{xy} = σ_{yz} = σ_{zx} = 0,")}
        <p>and the displacement is linear in the coordinates,</p>
        ${texBlock("u = \\frac{σ}{E}\\left(x,\; -ν y,\; -ν z\\right).")}
        <p>Linear elements represent a linear field exactly, so a correct
        finite element model reproduces this state to round-off, whatever the
        mesh. Cutting the block in two and tying the halves changes nothing
        about the exact solution. Any stress variation in the result is an
        error of the tie.</p>`,
  model: ({ tex, texBlock, page }) => {
    const [divA, divB] = grids(page);
    return `
        <p>The two bodies share no node: one is meshed ${divA[1]} × ${divA[2]}
        across, the other ${divB[1]} × ${divB[2]}, so only the corners of the
        interface coincide. The finer face is
        the <em>slave</em> side; each of its nodes is constrained to the other
        (<em>master</em>) face,</p>
        ${texBlock("u_{j} = \\sum_{k} w_{jk}\\, u_{k},")}
        <p>and the engine eliminates the slave unknowns from the system. How
        the weights ${tex("w_{jk}")} are chosen decides whether the test is
        passed.</p>
        <p>A <em>node-to-surface</em> tie takes them from the point the slave
        node projects onto. The node then follows the master face exactly,
        but between slave nodes the two faces interpolate differently, so the
        traction does different work on the two sides and a constant stress
        does not cross the tie exactly.</p>
        <p>KoFEM's tie uses the <em>dual mortar</em> method on linear elements.
        It imposes the tie in the integral sense,</p>
        ${texBlock("\\int_{Γ} ψ_{j} \\left(u_{\\mathrm{slave}} - u_{\\mathrm{master}}\\right) \\mathrm{d}Γ = 0,")}
        <p>with multiplier functions ${tex("ψ_{j}")} on the slave face that are
        dual to its shape functions, so each equation still gives one slave
        node in terms of master nodes. The functions ${tex("ψ_{j}")} sum to one,
        so the equations add up to ${tex("\\int_{Γ} (u_{\\mathrm{slave}} - u_{\\mathrm{master}})\\, \\mathrm{d}Γ = 0")}:
        a constant traction is transferred exactly. The integrals are taken
        over the exact overlap of every slave face with every master face
        (polygon clipping), so no quadrature error is left.</p>`;
  },
  discussion: ({ row, n, tex, pctAbs, inp, url }) => {
    const x = row.extras;
    return `
        <p>KoFEM's element stresses differ from the applied
        ${tex(`${n(inp("σ"))}\\text{ MPa}`)} by at most
        ${tex(`${n(Math.max(x.stressMax - inp("σ"), inp("σ") - x.stressMin))}\\text{ MPa}`)},
        and no node is further than
        ${pctAbs(x.displacementErrPct, 5)} of the largest displacement from the
        exact field. That is the solver's convergence tolerance: the test is
        passed, across the tie as everywhere else.</p>
        <p>The same model tied node-to-surface gives stresses from
        ${tex(`${n(x.projectionStressMin)}`)} to
        ${tex(`${n(x.projectionStressMax)}\\text{ MPa}`)}. That error sits at the tie and does not go
        away under mesh refinement. It is why node-to-surface ties are known
        for noisy stresses along mismatched interfaces, and why the mortar
        method became the standard for tying non-matching meshes (Puso 2004).
        KoFEM uses node-to-surface only for quadratic elements, where its
        mortar integrals are not implemented yet; see the
        <a href="${url("tie-cantilever")}">tied quadratic cantilever</a>.</p>`;
  },
  references: [REF.irons, REF.wohlmuth, REF.puso2004, REF.pusoLaursen],
};
