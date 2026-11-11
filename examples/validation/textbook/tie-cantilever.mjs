// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Page text: the quadratic cantilever, cut at mid-span and tied.

import { tieCantileverFigure } from "../lib/figures.mjs";
import { REF } from "./refs.mjs";
import { beamTheory } from "./cantilever.mjs";

// "5 × 2 × 2 and 5 × 3 × 3 grids, tied" → the two side-view grids [nx, ny].
const grids = (page) =>
  page.mesh
    .split(" and ")
    .map((grid) => grid.split(" × ").map((part) => parseInt(part, 10)));

export default {
  description:
    "A cantilever cut at mid-span into two differently meshed bodies of quadratic elements and joined by a tie: tip deflection against beam theory and against the uncut beam.",
  figure: ({ page }) => {
    const [divA, divB] = grids(page);
    return tieCantileverFigure({
      divA: divA.slice(0, 2),
      divB: divB.slice(0, 2),
    });
  },
  intro: ({ url, page }) => {
    const [divA, divB] = grids(page);
    return `
        <p>The <a href="${url("cantilever-p2")}">quadratic cantilever</a>,
        cut at mid-span into two bodies that are meshed separately, with
        ${divA[1]} × ${divA[2]} elements across on the clamped half and
        ${divB[1]} × ${divB[2]} on the loaded half. A tie joins them. Unlike the
        <a href="${url("tie-patch-test")}">patch test</a>, bending is not a
        linear field: the tie has to carry a shear force and a bending moment
        between faces whose nodes do not match.</p>`;
  },
  theory: beamTheory,
  model: ({ url }) => `
        <p>Each node of the finer face is tied to the face it projects onto,
        and follows that face's quadratic displacement field there. The
        nodes in the middle of the edges of a tied face follow its corners. This is the node-to-surface
        tie: KoFEM's mortar tie is implemented for linear elements, and
        quadratic faces fall back to projection. Projection fails the patch test on non-matching
        meshes (see the <a href="${url("tie-patch-test")}">tie patch test</a>), so this case
        measures how much that matters in bending.</p>`,
  discussion: ({ row, rowOf, pct, pctAbs, url }) => {
    const uncut = rowOf("cantilever-p2").errPct;
    return `
        <p>The tied beam deflects ${pct(row.errPct)} from the
        Euler–Bernoulli value; the
        <a href="${url("cantilever-p2")}">uncut beam</a> on a similar mesh
        deflects ${pct(uncut)}. The uncut beam's difference is the model, not
        the tie: shear deformation, which Euler–Bernoulli theory leaves out,
        and the 3-D stress state at the clamp and the loaded end. Cutting the
        beam and tying it adds ${pctAbs(row.errPct - uncut)} of the
        reference deflection.</p>
        <p>A deflection averages over the whole beam. Expect the stress right
        at a quadratic tie to be less accurate than this, until the mortar
        tie covers quadratic elements too.</p>`;
  },
  references: [REF.gere, REF.timoshenkoShear, REF.puso2004],
};
