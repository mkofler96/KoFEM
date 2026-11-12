// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Page text: Cook's membrane.

import { cookFigure } from "../lib/figures.mjs";
import { REF } from "./refs.mjs";

export default {
  description:
    "Cook's membrane, the tapered-panel benchmark for skewed elements in bending and shear: setup, reference value, mesh convergence and KoFEM's result.",
  figure: () => cookFigure({ div: null }),
  intro: () => `
        <p>Cook's membrane (1974) is a tapered panel, clamped on one edge and
        sheared on the other. It has no closed-form solution. The finite
        element literature uses it because it combines bending and shear on a
        mesh that cannot be rectangular, which exposes elements that lock or
        lose accuracy when distorted.</p>`,
  theory: ({ tex, url }) => `
        <p>The panel is the quadrilateral with corners (0, 0), (48, 44),
        (48, 60) and (0, 44), of unit thickness, with ${tex("E = 1")} and
        ${tex("ν = 1/3")}, in plane stress. A total shear force
        ${tex("F = 1")} is spread uniformly over the right edge, and the left
        edge is clamped. The benchmark is dimensionless; in KoFEM's units it
        is ${tex("E = 1")} MPa, ${tex("F = 1")} N and lengths in mm, so the
        deflection reads in mm.</p>
        <p>Without an analytical solution, the reference is the converged
        value of very fine plane-stress meshes reported in the literature,
        23.96 (older sources round it to 23.91). It is the vertical deflection
        at M, the middle of the loaded edge. Many descriptions put the point
        at the top corner C instead, but the tables of standard elements
        compared with 23.96 (bilinear quadrilaterals: 18.29, 22.08 and 23.43
        on 4 × 4, 8 × 8 and 16 × 16 meshes) are deflections at M; the corner
        moves more.</p>
        <p>The panel behaves like a short, tapered cantilever: span 48, depth
        tapering from 44 to 16. Linear elements lock in its bending, as in the
        <a href="${url("cantilever")}">cantilever</a>, and every element is
        skewed, so elements whose accuracy depends on rectangular shapes do
        poorly. Coarse meshes of simple elements land far below 23.96.</p>`,
  model: ({ tex }) => `
        <p>KoFEM is a 3-D solver, so the panel is a slab of thickness
        ${tex("t = 1")}, meshed by Netgen with quadratic tetrahedra and clamped
        over the whole ${tex("x = 0")} face. The ${tex("x = 48")} face is split
        at ${tex("y = 52")}, so M is a corner of the geometry and therefore a
        node of every mesh. The load ${tex("F")} is one force on both halves of
        that face, integrated as a uniform traction. The result is the
        vertical displacement of the node at M on the ${tex("z = 0")} face;
        the slab is symmetric about its mid-plane, so the ${tex("z = t")} face
        gives the same value.</p>
        <p>A thin slab with free faces is close to plane stress, but not
        exactly: the clamp also holds the through-thickness contraction at
        ${tex("x = 0")}, which stiffens the slab a little.</p>`,
  discussion: ({ row, pct, study, num }) => {
    const p1 = study.series.find((s) => s.order === 1).points;
    const p2 = study.series.find((s) => s.order === 2).points;
    const l1 = p1[p1.length - 1],
      l2 = p2[p2.length - 1],
      c2 = p2[0];
    // The Result summary's Max Uy, e.g. "2.513e+1 mm": the top corner C.
    const corner = parseFloat(row.readout.value);
    return `
        <p>KoFEM gives ${num(row.fe)} mm at M, ${pct(row.errPct)} from 23.96.
        In the convergence study quadratic tetrahedra level off at
        ${num(l2.fe)} mm (${l2.mesh}, ${pct(l2.errPct)}). That small remaining
        difference is the 3-D slab, which is slightly stiffer than the
        plane-stress panel the reference solves; the mesh no longer changes
        it. Linear tetrahedra lock in the bending and approach from below:
        ${num(l1.fe)} mm at ${l1.mesh} (${pct(l1.errPct)}), no closer than
        quadratic ones at ${c2.mesh} (${pct(c2.errPct)}) with
        ${Math.round(l1.dofs / c2.dofs)} times fewer unknowns. That is why the example uses quadratic elements.</p>
        <p>The largest vertical displacement, at the top corner C, is
        ${num(corner)} mm (Max Uy in the Result summary),
        ${pct(((corner - row.reference) / row.reference) * 100)} from 23.96.
        An earlier version of this page compared C with the reference, so
        refinement moved past it.</p>`;
  },
  references: [REF.cook1974, REF.belytschko, REF.cmpw],
};
