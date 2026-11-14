// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Page text: the thick-walled cylinder in two tied rings
// (cases/tie-lame-cylinder.mjs).

import { tieLameFigure } from "../lib/figures.mjs";
import { solidBore, tiedLame } from "../cases/tie-lame-cylinder.mjs";
import { REF } from "./refs.mjs";

export default {
  description:
    "A thick-walled cylinder under internal pressure, built from two rings tied across a gap with non-matching curved meshes, against Lamé's solution for the tied rings.",
  figure: () => tieLameFigure(),
  intro: () => `
        <p>A flat interface is the easy case for a tie. On a curved one the
        two faceted surfaces of a tetrahedral mesh do not even run parallel,
        so every node of one side projects onto the other at a slightly
        different place. This cylinder is built from two rings, meshed on
        their own and tied across a gap, and must still deflect as Lamé's
        theory says.</p>`,
  theory: ({ tex, texBlock, n }) => {
    const { q } = tiedLame();
    return `
        <p>In a long cylinder (plane strain) the radial displacement of a
        ring ${tex("r_{1} ≤ r ≤ r_{2}")} under the pressures ${tex("p_{i}")}
        inside and ${tex("p_{o}")} outside is Lamé's</p>
        ${texBlock("u(r) = \\frac{1+ν}{E}\\left((1-2ν)\\, C_{1} r + \\frac{C_{2}}{r}\\right),\\quad C_{1} = \\frac{p_{i} r_{1}^{2} - p_{o} r_{2}^{2}}{r_{2}^{2} - r_{1}^{2}},\\quad C_{2} = \\frac{(p_{i} - p_{o})\\, r_{1}^{2} r_{2}^{2}}{r_{2}^{2} - r_{1}^{2}}.")}
        <p>The inner ring ${tex("a ≤ r ≤ c")} carries the bore pressure
        ${tex("p")} and a contact pressure ${tex("q")} at ${tex("r = c")}.
        The tie makes the outer ring's bore follow it,
        ${tex("u_{o}(c + g) = u_{i}(c)")}, and passes the radial force on,
        so the outer ring carries ${tex("q\\, c / (c + g)")} at its bore.
        Both displacements are linear in ${tex("q")}, and the condition gives
        ${tex(`q = ${n(q)}\\text{ MPa}`)}. The bore displacement then follows
        from the inner ring. Without the gap this is Lamé's single cylinder,
        ${tex(`u(a) = ${n(solidBore())}\\text{ mm}`)}; the gap, which the tie
        bridges rigidly, makes it slightly larger.</p>`;
  },
  model: ({ row, tex }) => `
        <p>A quarter of the cylinder is modelled, with symmetry supports on
        the two cut faces of each ring and both end faces held along the
        axis, which makes the state plane strain. The two rings are separate
        solids in one STEP file. Netgen meshes each on its own with linear
        tetrahedra and a ${row.mesh.maxElementSize}&nbsp;mm maximum element
        size, so the nodes of the two facing cylinders do not match.</p>
        <p>The tie uses the dual mortar method: each node of one surface
        follows the other in an integral sense, over the exact overlap of
        the faces, which transfers the contact pressure without the noise of
        a node-to-surface tie. The bore displacement is read where the bore
        meets the ${tex("y = 0")} and ${tex("z = 0")} faces, where it is purely
        radial.</p>`,
  discussion: ({ row, pct }) => `
        <p>KoFEM's bore displacement differs from the tied Lamé solution by
        ${pct(row.errPct)}. Most of that is the linear tetrahedra: the
        polygonal bore and outer surfaces, and the constant strain per
        element across the steep radial gradient near the bore, make the
        model a little stiff. The tie itself adds no visible error: the
        contact pressure crosses the curved, non-matching interface as
        through a single body.</p>`,
  references: [REF.timoshenkoGoodier, REF.puso2004, REF.wohlmuth],
};
