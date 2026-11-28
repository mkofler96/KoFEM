// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Page text: the Scordelis–Lo roof, from the shell obstacle course.

import { scordelisRoofFigure } from "../lib/figures.mjs";
import { REF } from "./refs.mjs";

/** The finest mesh of the page's convergence study. */
const finest = (study) => study.series[0].points.at(-1);

export default {
  description:
    "The Scordelis–Lo roof from the shell obstacle course: a cylindrical roof between rigid diaphragms under its own weight, the free-edge deflection against KoFEM's curved shells.",
  searchTitle: "Scordelis–Lo roof shell benchmark",
  figure: () => scordelisRoofFigure(),
  intro: ({ tex, n, row }) => `
        <p>A barrel-vault roof: a cylindrical shell spanning 80°, carried at
        both ends by rigid diaphragms and free along its two straight edges,
        sagging under its own weight. It is the first problem of the shell
        "obstacle course" of MacNeal and Harder and of Belytschko et al.: the
        roof carries its weight by stretching and bending together, so an
        element must get both right. The vertical displacement at the middle
        of a free edge converges to
        ${tex(`u = ${n(row.reference)}\\text{ mm}`)}.</p>`,
  theory: ({ tex, texBlock, inp }) => `
        <p>A thin shell strains through its thickness as its mid-surface
        stretches and bends:</p>
        ${texBlock("ε(z) = ε_{m} + z κ, \\quad -\\frac{t}{2} \\le z \\le \\frac{t}{2}.")}
        <p>Its membrane stiffness grows with ${tex("t")}, its bending
        stiffness with ${tex("t^{3}")}. The roof is thin
        (${tex(`R / t = ${inp("R") / inp("t")}`)}) and shallow enough that both carry a large
        share of the weight. Scordelis and Lo's series solution of deep-shell
        theory gives 0.3086 for the benchmark's numbers; MacNeal and Harder
        normalise by 0.3024 instead, the value converged finite element
        solutions approach, and so does this page.</p>
        <p>The benchmark gives its numbers in consistent units: R = 25,
        L = 50, t = 0.25, E = 4.32·10⁸, ν = 0 and a weight of 90 per unit
        area. Read as metres and pascals they are the inputs above in
        millimetres and megapascals, and the displacement 0.3024 is 302.4&nbsp;mm.</p>`,
  model: ({ inp, row, tex, n }) => `
        <p>A quarter of the roof, as in the obstacle course: the crown and
        the mid-span plane are symmetry planes, held in the displacement
        normal to them and in the two rotations about the axes in them. The
        quarter is imported as a ${inp("t")}&nbsp;mm solid and marked Shell.
        The diaphragm edge is held in both directions of its own plane and
        free along the roof and in every rotation. The weight is a force of
        ${tex(`q R φ L / 2 = ${n((inp("q") * inp("R") * inp("φ") * Math.PI * inp("L")) / 360)}\\text{ N}`)} on the roof face, which the app spreads as a uniform
        traction. The roof's vertical axis is the model's <i>x</i> axis.</p>
        <p>${row.mesh.elements.toLocaleString("en-US")} flat triangles, each an
        OPT drilling membrane with a DKT plate-bending element.</p>`,
  discussion: ({ row, pct, study, url }) => `
        <p>KoFEM reads ${pct(row.errPct)} from the reference on this mesh.
        The convergence study approaches it from below and settles at
        ${pct(finest(study).errPct)} on ${finest(study).elements.toLocaleString("en-US")}
        triangles: the converged value of flat triangles that stand in for
        the curved roof, within the spread of published converged results
        (0.3006 to 0.3024).</p>
        <p>The other two problems of the obstacle course's shell set are the
        <a href="${url("pinched-cylinder")}">pinched cylinder</a> and the
        pinched hemisphere, which is <a href="${url("nafems-le3")}">NAFEMS
        LE3</a>.</p>`,
  references: [
    REF.macnealHarder,
    REF.belytschko1985,
    REF.scordelisLo,
    REF.batoz,
    REF.felippa2003,
  ],
};
