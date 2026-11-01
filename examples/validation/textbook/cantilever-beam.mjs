// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Page text: the cantilever built from a STEP file, meshed by Netgen
// (examples/gallery/generate-cantilever.mjs).

import { cantileverFigure } from "../lib/figures.mjs";
import { REF } from "./refs.mjs";
import { beam, beamTheory } from "./cantilever.mjs";

export default {
  description:
    "A cantilever built the way you build a model in KoFEM: a STEP block, a Netgen mesh of quadratic tetrahedra, a support and a tip load on CAD faces. Compared with δ = PL³/(3EI).",
  opens: "Opens the model in the app, ready to solve.",
  figure: () => cantileverFigure({ div: null }),
  intro: ({ url }) => `
        <p>The <a href="${url("cantilever")}">cantilever</a> again, but built
        the way you build a model in the app: import a STEP block, mesh it,
        fix one end face and load the other. The mesh is an unstructured
        Netgen mesh of tetrahedra rather than a hand-made grid. The model
        opens ready to solve, and after the solve the Results panel compares
        the tip deflection with the hand formula.</p>`,
  theory: beamTheory,
  model: ({ row, tex, inp, url }) => `
        <p>Netgen meshes the block with a ${row.mesh.maxElementSize}&nbsp;mm
        maximum element size, about ${inp("b × h")[1] / row.mesh.maxElementSize}
        elements across the section. The
        elements are quadratic: linear tetrahedra lock in bending even more
        than the <a href="${url("cantilever")}">linear hexahedra</a> do. The
        support and the load are each one CAD face, picked with one click, so
        they stay on the model when you change the element size and mesh it
        again. The deflection is the mean ${tex("u_{y}")} of the loaded face,
        which is what the app's hand check reads.</p>`,
  discussion: ({ row, rowOf, pct, inp, tex, url }) => {
    const k = beam(inp);
    const timo = -(k.bending + k.shear);
    return `
        <p>KoFEM's tip deflection differs from ${tex("P L^3 / (3 E I)")} by
        ${pct(row.errPct)}. The beam-theory value is not the whole story:
        the shear deformation it leaves out adds
        ${pct((k.shear / k.bending) * 100)}, so a converged solid model would
        deflect slightly more. Against the Timoshenko value the result
        differs by ${pct(((row.fe - timo) / timo) * 100)}, which is what
        the mesh still leaves out at this element size.</p>
        <p>The <a href="${url("cantilever-p2")}">quadratic hexahedra</a> on a
        coarse grid come out ${pct(rowOf("cantilever-p2").errPct)}. Both show
        the same thing: in bending, second-order elements are accurate on
        meshes coarse enough to solve in a second.</p>`;
  },
  references: [REF.gere, REF.timoshenkoShear, REF.schoeberl, REF.cmpw],
};
