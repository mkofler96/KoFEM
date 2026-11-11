// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Page text: Lamé's thick-walled cylinder, built from two tied rings.

import { tieCylinderFigure } from "../lib/figures.mjs";
import { REF } from "./refs.mjs";

// "inner ring 5 × 12, outer ring 5 × 8 (radial × around), 1 through t"
const rings = (page) => {
  const [inner, outer] = [...page.mesh.matchAll(/(\d+) × (\d+)/g)].map((m) => ({
    nr: Number(m[1]),
    nth: Number(m[2]),
  }));
  return { inner, outer };
};

export default {
  description:
    "Lamé's thick-walled cylinder under internal pressure, modelled as two rings tied along a curved interface whose meshes do not match: displacement and interface stress against the exact solution.",
  figure: ({ page }) => tieCylinderFigure(rings(page)),
  intro: () => `
        <p>A thick tube under internal pressure has an exact solution, found
        by Lamé in 1852. Here the tube is modelled as two rings, meshed
        separately with different numbers of elements around and joined by a
        tie. The interface is curved, its nodes do not match, and the two
        faceted surfaces do not even coincide. This is the situation of a pin
        in a bore, where a tie is needed in practice. If the tie is right, the
        two rings behave as one tube.</p>`,
  theory: ({ tex, texBlock, n, inp }) => {
    const a = inp("a"),
      b = inp("b"),
      p = inp("p");
    return `
        <p>In a long tube (plane strain) with bore radius ${tex("a")}, outer
        radius ${tex("b")} and internal pressure ${tex("p")}, the stresses
        depend on the radius only:</p>
        ${texBlock("σ_{r} = \\frac{p a^2}{b^2 - a^2}\\left(1 - \\frac{b^2}{r^2}\\right), \\quad σ_{θ} = \\frac{p a^2}{b^2 - a^2}\\left(1 + \\frac{b^2}{r^2}\\right), \\quad σ_{z} = ν (σ_{r} + σ_{θ}).")}
        <p>The radial displacement is</p>
        ${texBlock("u(r) = \\frac{(1 + ν)\\, p a^2}{E (b^2 - a^2)}\\left((1 - 2ν)\\, r + \\frac{b^2}{r}\\right).")}
        <p>The hoop stress at the bore is
        ${tex(`σ_{θ}(a) = ${n((p * (a * a + b * b)) / (b * b - a * a))}\\text{ MPa}`)},
        the largest in the tube. The solution has no interface: a tie that
        joins the two rings correctly leaves it unchanged.</p>`;
  },
  model: ({ tex, row, url }) => `
        <p>A quarter of the tube is modelled. Its cut faces carry symmetry
        supports, and both end faces are held in ${tex("z")}, which is the
        plane strain of a long tube. The pressure acts on the bore. The inner
        ring has more elements around than the outer one, so the nodes on the
        interface ${tex("r = c")} do not match. Both rings approximate the
        circle by straight-sided elements with different numbers of facets, so
        their surfaces cross each other with small gaps and overlaps. The
        tie is the dual mortar tie of the
        <a href="${url("tie-patch-test")}">tie patch test</a>. Each master face
        is projected along the slave face's normal and clipped against it, so
        the small gaps are bridged without moving a node. The
        ${row.mesh.elements} elements have
        ${row.mesh.dofs.toLocaleString("en-US")} unknowns.</p>`,
  discussion: ({ row, pct, pctAbs }) => {
    const x = row.extras;
    return `
        <p>The bore moves outwards by ${pct(row.errPct)} relative to Lamé's
        value, the accuracy of this mesh of linear elements. The tie adds
        nothing measurable to it.</p>
        <p>A tie that gets the displacements right can still get the stress
        at the interface wrong, so the element stresses are compared with
        Lamé's too. Next to the interface they differ from the exact von Mises
        stress by at most ${pctAbs(x.interfaceStressErrPct)}; in the other
        elements by at most ${pctAbs(x.otherStressErrPct)}. The stress is as
        accurate at the tie as away from it.</p>
        <p>The same model tied node-to-surface moves the bore by
        ${pct(x.projectionBoreErrPct)}, but its stresses next to the
        interface are off by up to ${pctAbs(x.projectionInterfaceStressErrPct)}. The
        displacement alone would not reveal that.</p>`;
  },
  references: [REF.timoshenkoGoodier, REF.wohlmuth, REF.puso2004],
};
