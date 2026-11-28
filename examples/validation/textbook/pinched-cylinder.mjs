// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Page text: the pinched cylinder with end diaphragms, from the shell
// obstacle course.

import { pinchedCylinderFigure } from "../lib/figures.mjs";
import { REF } from "./refs.mjs";

/** The finest mesh of the page's convergence study. */
const finest = (study) => study.series[0].points.at(-1);

export default {
  description:
    "The pinched cylinder from the shell obstacle course: a thin cylinder between rigid diaphragms pinched by two point loads, the displacement under the load against KoFEM's curved shells.",
  searchTitle: "Pinched cylinder shell benchmark",
  figure: () => pinchedCylinderFigure(),
  intro: ({ tex, n, row }) => `
        <p>A thin cylinder closed at both ends by rigid diaphragms, pinched
        at mid-length by two opposite point loads. It is one of the three
        shell problems of the "obstacle course" of Belytschko et al.: the
        cylinder flattens into an oval almost without stretching, so an
        element that cannot bend without stretching locks and moves far too
        little. The displacement under each load converges to
        ${tex(`u = ${n(row.reference)}\\text{ mm}`)}.</p>`,
  theory: ({ tex, texBlock, inp }) => `
        <p>A thin shell strains through its thickness as its mid-surface
        stretches and bends:</p>
        ${texBlock("ε(z) = ε_{m} + z κ, \\quad -\\frac{t}{2} \\le z \\le \\frac{t}{2}.")}
        <p>The cylinder is very thin (${tex(`R / t = ${inp("R") / inp("t")}`)}),
        and the loads pinch it into an oval that is nearly inextensional:
        almost all the work goes into bending. An element that stores
        membrane energy where there is none locks. Belytschko et al. give
        the converged displacement under the load from a series solution.</p>
        <p>The benchmark gives its numbers in consistent units: R = 300,
        L = 600, t = 3, E = 3·10⁶, ν = 0.3 and P = 1. KoFEM reads them as
        millimetres, newtons and megapascals, so the displacement is in
        millimetres.</p>`,
  model: ({ inp, row }) => `
        <p>An octant of the cylinder, as Belytschko et al. model it: the
        planes through the axis at the load and across it, and the
        mid-length plane, are symmetry planes, held in the displacement
        normal to them and in the two rotations about the axes in them. The
        octant is imported as a ${inp("t")}&nbsp;mm solid and marked Shell.
        The diaphragm edge is held in both directions of its own plane and
        free along the axis and in every rotation. The octant carries a
        quarter of ${inp("P")}&nbsp;N, on a 1&nbsp;mm piece of the
        mid-length edge split off at the load point: every load in KoFEM sits
        on whole CAD faces. Pieces of 1, 2 and 4&nbsp;mm read within 0.7
        points of each other on this mesh.</p>
        <p>${row.mesh.elements.toLocaleString("en-US")} flat triangles, each an
        OPT drilling membrane with a DKT plate-bending element.</p>`,
  discussion: ({ row, pct, study, url }) => `
        <p>KoFEM reads ${pct(row.errPct)} from the reference on this mesh.
        The convergence study approaches it from below on coarse meshes,
        overshoots slightly and settles at ${pct(finest(study).errPct)} on
        ${finest(study).elements.toLocaleString("en-US")} triangles: the
        elements do not lock, even though the shell is a hundred times
        thinner than its radius.</p>
        <p>The other two problems of the obstacle course's shell set are the
        <a href="${url("scordelis-lo-roof")}">Scordelis–Lo roof</a> and the
        pinched hemisphere, which is <a href="${url("nafems-le3")}">NAFEMS
        LE3</a>.</p>`,
  references: [REF.belytschko1985, REF.macnealHarder, REF.batoz, REF.felippa2003],
};
