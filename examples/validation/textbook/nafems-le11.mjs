// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Page text: NAFEMS LE11, the solid of revolution under a temperature field.

import { meridianFigure } from "../lib/figures.mjs";
import { REF } from "./refs.mjs";

const s45 = Math.SQRT1_2;
const D = [Math.sqrt(1.4 ** 2 - 0.7 ** 2), 0.7];

export default {
  description:
    "NAFEMS benchmark LE11: a solid cylinder, taper and sphere heated by a linear temperature field, σzz at A against KoFEM's thermal load.",
  searchTitle: "NAFEMS LE11 thermal stress benchmark",
  figure: () =>
    meridianFigure({
      start: [1, 0],
      segments: [
        { type: "line", to: [1.4, 0] },
        { type: "arc", to: D, center: [0, 0], ccw: true },
        { type: "line", to: [1, 1.39] },
        { type: "line", to: [1, 1.79] },
        { type: "line", to: [s45, 1.79] },
        { type: "line", to: [s45, s45] },
        { type: "arc", to: [1, 0], center: [0, 0], ccw: false },
      ],
      closed: true,
      points: { A: [1, 0], B: [1.4, 0], D, E: [s45, s45], G: [1, 1.39] },
      name: "solid-of-revolution-diagram",
      label:
        "Meridian section of the solid of revolution: a spherical segment between radii 1 and 1.4 m, a taper and a cylinder up to z = 1.79 m; A is the inner corner on the base",
      note: "ΔT = r + z (°C, r and z in m)",
    }),
  intro: ({ tex, n, row }) => `
        <p>A solid of revolution, heated so that the temperature rises
        linearly with the radius and the height. The parts that would
        expand most are held back by the rest, and the bottom and top are
        held in ${tex("z")}. NAFEMS gives
        ${tex(`σ_{zz} = ${n(row.reference)}\\text{ MPa}`)} at A, the inner
        corner of the base.</p>`,
  theory: ({ tex, texBlock }) => `
        <p>A temperature change ${tex("ΔT")} would stretch a free material by
        ${tex("α ΔT")} in every direction. Where it cannot, the stress is set
        by the strain that is left:</p>
        ${texBlock("σ = D \\, (ε - α \\, ΔT \\, I).")}
        <p>The solve takes the free thermal strain as a load,
        ${tex("f = \\int B^{T} D \\, α ΔT \\, I \; dV")}, and the stress is
        recovered with it removed.</p>`,
  model: ({ inp, row }) => `
        <p>A 90° sector of the solid, with its cut faces held by symmetry,
        is the whole of it: the temperature and the supports are
        axisymmetric. The material carries the expansion coefficient
        ${inp("α")}&nbsp;/°C, and the temperature change is entered as a
        formula in <i>x</i>, <i>y</i> and <i>z</i>, in millimetres:
        ΔT = (√(x² + y²) + z) / 1000. The solve evaluates it at every
        node.</p>
        <p>${row.mesh.elements.toLocaleString("en-US")} quadratic tetrahedra:
        the linear temperature field gives a linear thermal strain, which a
        linear tetrahedron's constant strain cannot follow.</p>`,
  discussion: ({ row, pct }) => `
        <p>KoFEM reads ${pct(row.errPct)} from the NAFEMS target, and the
        convergence study shows the read-out approaching it from below as
        the mesh is refined.</p>`,
  references: [REF.nafems],
};
