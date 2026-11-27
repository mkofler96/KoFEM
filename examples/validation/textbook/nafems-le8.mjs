// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Page text: NAFEMS LE8, the axisymmetric shell under pressure.

import { meridianFigure } from "../lib/figures.mjs";
import { REF } from "./refs.mjs";

export default {
  description:
    "NAFEMS benchmark LE8: a shell of revolution with a toroidal knuckle and a dished end under internal pressure, the hoop stress at D against KoFEM's curved shells.",
  searchTitle: "NAFEMS LE8 axisymmetric shell under pressure",
  figure: () =>
    meridianFigure({
      start: [0.25, 0],
      segments: [
        { type: "line", to: [0.25, 0.5] },
        { type: "arc", to: [0.15, 0.55], center: [0.1875, 0.5], ccw: true },
        { type: "arc", to: [0, 0.5], center: [0, 0.75], ccw: false },
      ],
      closed: false,
      points: { A: [0.25, 0], B: [0.25, 0.5], D: [0.15, 0.55], E: [0, 0.5] },
      name: "knuckle-shell-diagram",
      label:
        "Meridian of the shell: a cylinder of radius 0.25 m from A to B, a toroidal knuckle of radius 62.5 mm from B to D, and a dished-in spherical end from D to the pole E",
      note: "internal pressure; A held axially",
    }),
  intro: ({ tex, n, row }) => `
        <p>A closed shell of revolution: a cylinder, a tight toroidal knuckle
        and a spherical end dished inward, under internal pressure. Where the
        knuckle meets the end, at D, the shell bends hard. NAFEMS gives the
        hoop stress on the outer surface there,
        ${tex(`σ_{θθ} = ${n(row.reference)}\\text{ MPa}`)}.</p>`,
  theory: ({ tex, texBlock }) => `
        <p>A shell of revolution under pressure carries it as a membrane where
        its curvature changes slowly, with meridional and hoop forces set by
        the two radii of curvature ${tex("r_{1}")} and ${tex("r_{2}")}:</p>
        ${texBlock("\\frac{N_{φ}}{r_{1}} + \\frac{N_{θ}}{r_{2}} = p.")}
        <p>At a knuckle the meridian's radius jumps from the torus to the
        sphere, the membrane forces cannot follow, and the shell bends: the
        stress at D is mostly that bending.</p>`,
  model: ({ row }) => `
        <p>NAFEMS gives the dimensions in a figure: the cylinder radius, the
        height of the pole, the knuckle and end radii and an angle of about
        36°. With the knuckle tangent to the end and the end's centre on the
        axis, the knuckle arc spans 36.87°, which fixes every point. A 90°
        sector, its cut meridians held by symmetry, is imported as a
        10&nbsp;mm solid and marked Shell: the app collapses the cylinder,
        the torus and the sphere to one welded mid-surface, all kept on their
        outer faces. The pressure acts on the outer faces, pulling outward,
        and the probe reads <i>σyy</i>, the hoop stress on the cut
        <i>y</i>&nbsp;=&nbsp;0, on the top surface at D.</p>
        <p>${row.mesh.elements.toLocaleString("en-US")} flat triangles.</p>`,
  discussion: ({ row, pct }) => `
        <p>KoFEM reads ${pct(row.errPct)} from the NAFEMS target, the widest
        difference of the NAFEMS pages, and the band is wide to match. Thin
        shell theory does not reach the target either: an axisymmetric
        Kirchhoff shell solution of this geometry converges about 7&nbsp;%
        below it, and Abaqus' own axisymmetric shell elements read about
        4&nbsp;% below. KoFEM's flat facets approach that thin-shell solution
        from below as the mesh is refined: 2.6&nbsp;% below it on this mesh,
        1.7&nbsp;% on 3&nbsp;mm facets. The tight knuckle, only six
        thicknesses in radius, is what they converge slowly on. The
        difference from the target most likely lies in the geometry, which
        NAFEMS gives only as a figure.</p>`,
  references: [REF.nafems, REF.timoshenkoGoodier],
};
