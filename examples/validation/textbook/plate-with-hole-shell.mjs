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
        <p>The app builds the shell from the CAD geometry: it pairs the
        plate's two faces, ${inp("t")}&nbsp;mm apart, and meshes the surface
        halfway between them. The faces through the wall, the cut edges and
        the hole, become the edges of the shell, so each support and the load
        is picked as an Edge. The peak sits on the hole, so the hole face gets
        its own element size, an eighth of the plate's: the hole edge is
        meshed at 0.125&nbsp;mm and the rest of the plate grades out to
        1&nbsp;mm.</p>
        <p>Each of the ${row.mesh.elements.toLocaleString("en-US")} triangles
        combines Felippa's OPT membrane, whose corner rotations are the
        in-plane rotations of the field, and a DKT plate-bending element; in
        this load case only the membrane part works. Shell nodes carry six degrees of freedom. The
        symmetry edges fix the displacement across the cut and the rotations a
        mirror plane forbids, plus ${tex("u_{z}")}, which only stops the plate
        floating: an in-plane load never moves it out of its plane.</p>`,
  discussion: ({ row, rowOf, pct, pctAbs, tex, url, study }) => {
    const errs = shellErrors(study);
    const settles = errs.every(
      (err, k) => err < 0 && (k === 0 || Math.abs(err) <= Math.abs(errs[k - 1])),
    );
    if (!settles)
      throw new Error(
        "plate-with-hole-shell: the page says the study rises towards 3.14 from below on every finer mesh; it does not",
      );
    return `
        <p>KoFEM's ${tex("K_{\\mathrm{t}}")} is ${pct(row.errPct)} from
        3.14, read as the Results panel reads it: the largest nodal von Mises
        stress. The <a href="${url("plate-with-hole")}">solid page</a>, with
        quadratic tetrahedra, comes out
        ${pct(rowOf("plate-with-hole").errPct)}.</p>
        <p>A shell triangle reports one stress, at its centroid, and the
        nodal value at A averages the one or two triangles that meet there:
        a stress a fraction of an element inside the plate, where it has
        started to fall. So the read-out is low, by an amount set by the
        triangles at the hole. In the mesh study above the plate and its hole
        edge are refined together, the hole edge always at an eighth of the
        plate's size, and ${tex("K_{\\mathrm{t}}")} rises towards 3.14 on
        every finer mesh, from ${pctAbs(errs[0], 1)} below to
        ${pctAbs(errs.at(-1), 2)} below. Without the face size on the hole the
        1&nbsp;mm mesh reads about 9&nbsp;% low.</p>
        <p>For a peak stress, refine where the stress peaks: an element size
        on the face that carries the peak moves the reading far more than a
        finer mesh everywhere. Shells pay off when a thin wall bends: one
        layer of shell elements bends by construction, while solid elements
        need several layers or quadratic elements to do the same (see the
        <a href="${url("cantilever-beam")}">cantilever</a>).</p>`;
  },
  references: [REF.kirsch, REF.howland, REF.peterson, REF.batoz, REF.felippa2003, REF.cmpw],
};
