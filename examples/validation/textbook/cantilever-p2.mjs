// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Case page text: the cantilever on a coarse mesh of quadratic elements.

import { cantileverFigure } from "../lib/figures.mjs";
import { REF } from "./refs.mjs";
import { beam, beamTheory, studySeries } from "./cantilever.mjs";

export default {
  description:
    "The tip-loaded cantilever on a coarse mesh of quadratic (P2) hexahedra: why second-order elements do not shear-lock, with KoFEM's result against beam theory.",
  figure: ({ page }) => cantileverFigure({ div: page.grid }),
  intro: ({ page }) => `
        <p>The <a href="/validation/cantilever/">cantilever</a> again, on a mesh
        four times coarser in each direction (${page.grid.join(" × ")}), with
        quadratic elements instead of linear ones. The case checks KoFEM's
        second-order element path and shows why element order matters in
        bending.</p>`,
  theory: beamTheory,
  model: ({ tex, row, rowOf }) => {
    const p1 = rowOf("cantilever").mesh;
    return `
        <p>A quadratic hexahedron has 27 nodes: at its corners, edge
        midpoints, face centres and centre. The displacement varies
        quadratically along each edge, so an element can curve. Clamping
        the ${tex("x = 0")} face fixes all of its nodes, including the
        mid-edge and mid-face ones. The ${row.mesh.elements} elements have
        ${row.mesh.nodes.toLocaleString("en-US")} nodes and
        ${row.mesh.dofs.toLocaleString("en-US")} unknowns, about half the
        ${p1.dofs.toLocaleString("en-US")} of the linear case. The tip load
        is split equally over the element vertices of the end face; its
        mid-side nodes carry no load.</p>`;
  },
  discussion: ({ row, pct, tex, n, study, inp }) => {
    const k = beam(inp);
    const timo = -(k.bending + k.shear);
    const p1 = studySeries(study, 1);
    return `
        <p>On this coarse mesh the deflection differs from the
        Euler–Bernoulli value by ${pct(row.errPct)} and is close to the
        Timoshenko value that includes shear deformation,
        ${tex(`${n(timo)}\\text{ m}`)}. A quadratic element
        can represent a linearly varying bending strain exactly: its edges
        curve, so it bends without parasitic shear and does not lock.</p>
        <p>Linear elements on meshes this coarse lock badly. In the
        convergence study below, the error is ${pct(p1[0].errPct)} with
        ${p1[0].mesh} linear elements and ${pct(p1[1].errPct)} with
        ${p1[1].mesh}; the quadratic series is within a few percent on every mesh. For
        bending-dominated parts, quadratic elements give more accuracy per
        unknown.</p>`;
  },
  references: [REF.gere, REF.timoshenkoShear, REF.cmpw, REF.hughes],
};
