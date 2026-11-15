// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Page text: the solid page's strip with a hole, as a shell mid-surface.

import { quarterPlateFigure } from "../lib/figures.mjs";
import { REF } from "./refs.mjs";

/** The shell series of the page's convergence study (errors in %). */
function shellErrors(study) {
  if (!study)
    throw new Error("plate-with-hole-shell: the page needs its study");
  const [series] = study.series;
  if (!series) throw new Error("plate-with-hole-shell: the study is empty");
  return series.points.map((p) => p.errPct);
}

export default {
  description:
    "The strip from the solid plate-with-hole page, meshed as a shell: KoFEM's linear shell triangles against Howland's Kt = 3.14, beside the solid page's quadratic tetrahedra.",
  figure: () => quarterPlateFigure(),
  intro: ({ tex, url }) => `
        <p>The same strip as on the
        <a href="${url("plate-with-hole")}">solid plate with a hole</a>
        page, modelled as a thin-walled part usually is: one layer of shell
        triangles on the mid-surface, with the thickness as a property.
        Same plate, same load, same reference,
        ${tex("K_{\\mathrm{t}} = 3.14")}. The two pages show what each element
        type does with a stress peak.</p>`,
  theory: ({ tex, url }) => `
        <p>The derivation is on the
        <a href="${url("plate-with-hole")}#theory">solid plate's page</a>. On
        the edge of the hole the hoop stress peaks at the points A across the
        load. In a strip with ${tex("2a / W = 0.2")}, Howland's solution puts
        that peak at ${tex("K_{\\mathrm{t}} = 3.14")} times the stress
        ${tex("σ")} at the ends. It is a plane-stress solution, which is
        exactly the state of a flat shell loaded in its own plane.</p>`,
  model: ({ row, tex, inp }) => `
        <p>The strip is symmetric about ${tex("x = 0")} and ${tex("y = 0")},
        so the model keeps the quarter ${tex("x, y ≥ 0")}. Unlike the solid
        model it keeps the whole ${inp("t")}&nbsp;mm thickness: a shell is
        its mid-surface, so there is no mid-plane to cut at. The edge
        ${tex("x = L")} is pulled with ${tex("σ b t")}, spread as a uniform
        line load ${tex("q = σ t")}.</p>
        <p>The app builds the shell from a solid mesh: Netgen fills the
        ${inp("t")}&nbsp;mm wall with tetrahedra, and the app replaces the
        wall by its mid-surface. The faces through the wall, the cut edges and
        the hole, become the edges of the shell, so each support and the load
        is picked as an Edge. Netgen puts at least two elements along every
        edge, so next to the ${inp("t")}&nbsp;mm cut edge the triangle at A
        stays about 0.6&nbsp;mm on every mesh: a smaller maximum element size
        refines the rest of the hole but not the peak.</p>
        <p>Each of the ${row.mesh.elements.toLocaleString("en-US")} triangles
        combines a CST membrane, with one constant strain and stress per
        triangle, and a DKT plate-bending element; in this load case only the
        membrane part works. Shell nodes carry six degrees of freedom. The
        symmetry edges fix the displacement across the cut and the rotations a
        mirror plane forbids, plus ${tex("u_{z}")}, which only stops the plate
        floating: an in-plane load never moves it out of its plane.</p>`,
  discussion: ({ row, rowOf, pct, pctAbs, tex, url, study }) => {
    const errs = shellErrors(study);
    const lo = Math.min(...errs),
      hi = Math.max(...errs);
    if (!(lo < 0 && hi > 0))
      throw new Error(
        "plate-with-hole-shell: the page says the study scatters on both sides of 3.14; it does not",
      );
    return `
        <p>KoFEM's ${tex("K_{\\mathrm{t}}")} is ${pct(row.errPct)} from
        3.14, read as the Results panel reads it: the largest nodal von Mises
        stress. The <a href="${url("plate-with-hole")}">solid page</a>, with
        quadratic tetrahedra, comes out
        ${pct(rowOf("plate-with-hole").errPct)}.</p>
        <p>The difference is in the elements. A quadratic tetrahedron's stress
        varies inside it, so it follows the steep drop away from the hole, and
        the solid model reads the peak slightly low on every mesh. A linear
        triangle has one stress. At A only one or two triangles meet, so the
        nodal value is their stress, and it lands above or below 3.14
        depending on how the mesher cuts that corner; on the finest meshes the
        peak moves to the next node along the hole. Over the mesh study above
        it ranges from ${pctAbs(lo, 1)} below to ${pctAbs(hi, 1)} above,
        without settling, which is why the band is
        ±${row.tolPct}&nbsp;%.</p>
        <p>For a peak stress in a flat part loaded in its plane, use solid
        quadratic elements, or check that the shell peak stops changing on
        finer meshes. Shells pay off when a thin wall bends: one layer of
        shell elements bends by construction, while solid elements need
        several layers or quadratic elements to do the same (see the
        <a href="${url("cantilever-beam")}">cantilever</a>).</p>`;
  },
  references: [REF.kirsch, REF.howland, REF.peterson, REF.batoz, REF.cmpw],
};
