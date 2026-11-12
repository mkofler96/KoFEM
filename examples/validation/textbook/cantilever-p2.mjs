// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Page text: the cantilever on a coarse mesh of quadratic tetrahedra.

import { cantileverFigure } from "../lib/figures.mjs";
import { REF } from "./refs.mjs";
import {
  acrossDepth,
  beamTheory,
  studyPoint,
  studySeries,
} from "./cantilever.mjs";

export default {
  description:
    "The tip-loaded cantilever on a coarse mesh of quadratic (P2) tetrahedra: why second-order elements do not shear-lock, with KoFEM's result against beam theory.",
  opens: "Opens the model in the app, ready to solve.",
  figure: () => cantileverFigure({ div: null }),
  intro: ({ row, rowOf, inp, url }) => `
        <p>The <a href="${url("cantilever")}">cantilever</a> again, on a mesh
        ${row.mesh.maxElementSize / rowOf("cantilever").mesh.maxElementSize}
        times coarser (about ${acrossDepth(inp, row.mesh.maxElementSize)}
        elements through the depth), with quadratic elements instead of
        linear ones. The case checks KoFEM's second-order element path and
        shows why element order matters in bending.</p>`,
  theory: beamTheory,
  model: ({ tex, row, rowOf }) => {
    const p1 = rowOf("cantilever").mesh;
    return `
        <p>A quadratic tetrahedron has 10 nodes: four at its corners and six
        at its edge midpoints. The displacement varies quadratically along
        each edge, so an element can curve and its strain can vary inside
        it. Clamping the ${tex("x = 0")} face fixes all of its nodes,
        including the mid-edge ones. The
        ${row.mesh.elements.toLocaleString("en-US")} elements have
        ${row.mesh.nodes.toLocaleString("en-US")} nodes and
        ${row.mesh.dofs.toLocaleString("en-US")} unknowns, against
        ${p1.dofs.toLocaleString("en-US")} for the linear mesh. The tip load
        is a force on the end face, integrated with the quadratic shape
        functions, so the mid-edge nodes carry their share.</p>`;
  },
  discussion: ({ row, pct, pctAbs, study }) => {
    const p1 = studySeries(study, 1);
    const p2 = studySeries(study, 2);
    const size = row.mesh.maxElementSize;
    return `
        <p>On this coarse mesh the deflection differs from the
        Euler–Bernoulli value by ${pct(row.errPct)}; the finest quadratic
        mesh in the study gives ${pct(p2[p2.length - 1].errPct)}. A
        quadratic element can represent a linearly varying bending strain
        exactly: its edges curve, so it bends without parasitic shear and
        does not lock.</p>
        <p>Linear elements on meshes this coarse lock badly. In the
        convergence study above, linear tetrahedra on the same
        ${size}&nbsp;mm mesh give ${pct(studyPoint(p1, size).errPct)},
        and still ${pct(studyPoint(p1, size / 2).errPct)} at
        ${size / 2}&nbsp;mm; the quadratic series is within
        ${pctAbs(Math.max(...p2.map((p) => Math.abs(p.errPct))))} on every
        mesh. For bending-dominated parts, quadratic elements give
        more accuracy per unknown.</p>`;
  },
  references: [REF.gere, REF.timoshenkoShear, REF.cmpw, REF.hughes],
};
