// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Page text: the patch test across a constraint tie between non-matching
// meshes (cases/tie-patch-test.mjs).

import { tiePatchFigure } from "../lib/figures.mjs";
import { REF } from "./refs.mjs";

export default {
  description:
    "The patch test across a tie between non-matching meshes: uniform tension through two separately meshed bodies, why node-to-surface ties fail it and mortar ties pass it.",
  figure: () => tiePatchFigure(),
  intro: () => `
        <p>Parts of an assembly are often meshed on their own, so where they
        are joined the nodes on the two sides do not line up. A <em>tie</em>
        joins such surfaces without moving them. The first thing a tie has to
        get right is the simplest load there is: a uniform stress must pass
        through it unchanged. This is the patch test, applied across the
        tie.</p>`,
  theory: ({ tex, texBlock }) => `
        <p>Pull a block with a uniform traction ${tex("σ")} on one end and
        let it slide freely on symmetry planes on the other three sides.
        Every point is then in the same state of uniaxial stress,</p>
        ${texBlock("σ_{xx} = σ, \\quad σ_{yy} = σ_{zz} = σ_{xy} = σ_{yz} = σ_{zx} = 0,")}
        <p>and the displacement is linear in the coordinates. Cut the block in
        two, pull the parts a gap ${tex("g")} apart and tie them: the tie
        bridges the gap rigidly, so the gap carries no strain, and the stress
        state is the same in both parts. Linear elements represent a linear field exactly, so a correct
        model reproduces ${tex("σ")} to round-off, whatever the mesh. Any
        stress variation in the result is an error of the tie.</p>`,
  model: ({ tex, texBlock, row }) => `
        <p>The two blocks are separate solids in one STEP file. Netgen meshes
        each on its own with linear tetrahedra and a
        ${row.mesh.maxElementSize}&nbsp;mm maximum element size. The edges of
        the two facing squares are divided alike, but the nodes inside them
        do not match. The tie makes each node of one face (the
        <em>slave</em> side) follow the other (<em>master</em>) face,</p>
        ${texBlock("u_{j} = \\sum_{k} w_{jk}\\, u_{k},")}
        <p>and the solver eliminates the slave unknowns from the system. How
        the weights ${tex("w_{jk}")} are chosen decides whether the test is
        passed.</p>
        <p>A <em>node-to-surface</em> tie takes them from the point the slave
        node projects onto. The node then follows the master face exactly,
        but between slave nodes the two faces interpolate differently, so the
        traction does different work on the two sides and a constant stress
        does not cross the tie exactly.</p>
        <p>KoFEM's tie uses the <em>dual mortar</em> method on linear
        elements. It imposes the tie in the integral sense,</p>
        ${texBlock("\\int_{Γ} ψ_{j} \\left(u_{\\mathrm{slave}} - u_{\\mathrm{master}}\\right) \\mathrm{d}Γ = 0,")}
        <p>with multiplier functions ${tex("ψ_{j}")} on the slave face that
        are dual to its shape functions, so each equation still gives one
        slave node in terms of master nodes. The functions ${tex("ψ_{j}")} sum
        to one, so the equations add up to
        ${tex("\\int_{Γ} (u_{\\mathrm{slave}} - u_{\\mathrm{master}})\\, \\mathrm{d}Γ = 0")}:
        a constant traction is transferred exactly. The integrals are taken
        over the exact overlap of every slave face with every master face
        (polygon clipping), so no quadrature error is left.</p>`,
  discussion: ({ row, tex, n, inp, url }) => `
        <p>KoFEM's largest von Mises stress is
        ${tex(`${n(row.fe)}\\text{ MPa}`)} for the applied
        ${tex(`${n(inp("σ"))}\\text{ MPa}`)}. The difference is the solver's
        convergence tolerance: the test is passed, across the tie as
        everywhere else. A tie that fails it shows stress jumps at the
        interface that do not go away under mesh refinement. That is why
        node-to-surface ties are known for noisy stresses along mismatched
        interfaces, and why the mortar method became the standard for tying
        non-matching meshes (Puso 2004).</p>
        <p>KoFEM uses node-to-surface only on quadratic elements, where its
        mortar integrals are not implemented yet; there the tied nodes follow
        the master face's quadratic field. See the
        <a href="${url("tie-cantilever")}">tied cantilever</a>, and the
        <a href="${url("tie-lame-cylinder")}">tied cylinder</a> for a curved
        interface.</p>`,
  references: [REF.irons, REF.wohlmuth, REF.puso2004, REF.pusoLaursen],
};
