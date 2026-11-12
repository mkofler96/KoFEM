// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Page text: the cantilever that opens ready to run, quadratic tetrahedra at
// 25 mm (cases/cantilever-beam.mjs).

import { cantileverFigure } from "../lib/figures.mjs";
import { REF } from "./refs.mjs";
import { acrossDepth, beam, beamTheory } from "./cantilever.mjs";

export default {
  description:
    "A cantilever that opens ready to run: a STEP block, a Netgen mesh of quadratic tetrahedra, a support and a tip load on CAD faces, and a hand check against δ = PL³/(3EI).",
  opens: "Opens the model in the app, ready to solve.",
  figure: () => cantileverFigure({ div: null }),
  intro: ({ url }) => `
        <p>The <a href="${url("cantilever")}">cantilever</a> again, set up
        and ready to run: a STEP block, meshed, with one end face fixed and
        the other loaded. Press Run, and the Results panel compares the tip
        deflection with the hand formula.</p>`,
  theory: beamTheory,
  model: ({ row, rowOf, pctAbs, tex, inp, url }) => {
    const p1 = rowOf("cantilever");
    return `
        <p>Netgen meshes the block with a ${row.mesh.maxElementSize}&nbsp;mm
        maximum element size, about ${acrossDepth(inp, row.mesh.maxElementSize)}
        elements through the depth. The elements are quadratic, because
        linear tetrahedra lock in bending: the
        <a href="${url("cantilever")}">linear-element cantilever</a> needs a
        ${p1.mesh.maxElementSize}&nbsp;mm mesh to come within
        ${pctAbs(p1.errPct)}. The support and the load are each one CAD
        face, picked with one click, so they stay on the model when you
        change the element size and mesh it again. The deflection is the
        mean ${tex("u_{y}")} of the loaded face, which is what the app's hand
        check reads.</p>`;
  },
  discussion: ({ row, rowOf, pct, tex, inp, url }) => {
    const k = beam(inp);
    const p2 = rowOf("cantilever-p2");
    return `
        <p>KoFEM's tip deflection differs from ${tex("P L^3 / (3 E I)")} by
        ${pct(row.errPct)}. The beam-theory value is not the whole story:
        the shear deformation it leaves out would add
        ${pct((k.shear / k.bending) * 100)}, while the fully clamped end face
        of the solid is stiffer than a beam's clamp. The
        <a href="${url("cantilever")}#convergence">cantilever's convergence
        study</a> shows the net effect on finer meshes.</p>
        <p>The <a href="${url("cantilever-p2")}">quadratic tetrahedra</a> on
        a ${p2.mesh.maxElementSize}&nbsp;mm mesh come out ${pct(p2.errPct)}.
        Both show the same thing: in bending, second-order elements are
        accurate on meshes coarse enough to solve in seconds.</p>`;
  },
  references: [REF.gere, REF.timoshenkoShear, REF.schoeberl, REF.cmpw],
};
