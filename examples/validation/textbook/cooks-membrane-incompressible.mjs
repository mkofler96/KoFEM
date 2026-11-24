// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Page text: Cook's membrane, nearly incompressible (KOF-400). A limitation:
// linear tetrahedra lock.

import { cookFigure } from "../lib/figures.mjs";
import { REF } from "./refs.mjs";

const THEORY =
  "/theory/numerical-methods/elements-and-quadrature/#incompressible";

export default {
  searchTitle: "Volumetric locking in linear tetrahedra",
  description:
    "Linear tetrahedra lock for nearly incompressible materials. Cook's membrane at ν = 0.4999: linear vs. quadratic tetrahedra against the published reference.",
  figure: () => cookFigure({ at: "C" }),
  // The limitation notice under the title (lib/page.mjs).
  limitation: ({ row, pct }) => `
        This example shows a limitation. With ν close to ½, as for rubber,
        linear tetrahedra come out far too stiff: here ${pct(row.expectedFailure.errPct)}
        from the reference. Use quadratic tetrahedra for nearly incompressible
        materials. <a href="${THEORY}">Why linear tetrahedra lock</a>.`,
  intro: ({ url }) => `
        <p>The <a href="${url("cooks-membrane")}">Cook's membrane</a> panel
        again, now in plane strain and made of a nearly incompressible
        material, ν = 0.4999. It is the standard test for volumetric locking:
        an element that cannot deform without changing volume makes a rubber
        part far too stiff.</p>`,
  theory: ({ tex }) => `
        <p>The panel is the quadrilateral with corners (0, 0), (48, 44),
        (48, 60) and (0, 44), clamped on the left edge, in plane strain, with
        a uniform shear traction ${tex("q = 6.25")} N/mm on the right edge, a
        total force ${tex("F = 100")} N. The material has
        ${tex("E = 240.565")} MPa and ${tex("ν = 0.4999")}, so its Lamé
        constants are ${tex("λ ≈ 400\\,890")} MPa and ${tex("μ ≈ 80.19")} MPa:
        compressing it is 5000 times stiffer than shearing it.</p>
        <p>There is no closed-form solution. The reference is the converged
        vertical displacement of the top corner C, 8.075 mm, reported by
        Casquero and Golestanian (2024) for exactly these values.</p>
        <p>With ${tex("λ")} so much larger than ${tex("μ")}, the solution is almost free of volume
        change: ${tex("\\nabla \\cdot \\mathbf{u} \\approx 0")} everywhere. A
        linear tetrahedron has one constant strain, so each element must keep
        its own volume. A mesh has roughly as many elements as unknowns, so
        these constraints leave almost no displacement field free, and the
        few that remain are far stiffer than the real one. That is volumetric
        locking. Quadratic tetrahedra have more unknowns per element and a
        strain that varies inside it; they are not free of locking in theory,
        but at ν = 0.4999 they come close to the answer.</p>`,
  theoryTitle: "Reference and locking",
  model: ({ tex }) => `
        <p>KoFEM is a 3-D solver, so the panel is a slab of thickness
        ${tex("t = 1")}, clamped over the whole ${tex("x = 0")} face. Plane
        strain means no displacement through the thickness: both
        ${tex("z")} faces are held in ${tex("z")} only, free to slide in
        their plane. The load is one force on the ${tex("x = 48")} face,
        integrated as a uniform traction. The result is the vertical
        displacement of the node at C on the ${tex("z = 0")} face, a corner
        of the geometry and so a node of every mesh.</p>
        <p>The page's model and 3D view use quadratic tetrahedra. The same
        model with linear tetrahedra, on the same 2 mm element size, is
        solved on every CI run as an expected failure: CI fails if its
        error moves away from the recorded value, whether locking gets worse
        or goes away unnoticed.</p>`,
  discussion: ({ row, pct, study, num }) => {
    const xf = row.expectedFailure;
    const p1 = study.series.find((s) => s.order === 1).points;
    const p2 = study.series.find((s) => s.order === 2).points;
    const f1 = p1[p1.length - 1],
      c2 = p2[0];
    return `
        <p>Quadratic tetrahedra give ${num(row.fe)} mm, ${pct(row.errPct)}
        from 8.075 mm. Linear tetrahedra on the same element size give
        ${num(xf.fe)} mm, ${pct(xf.errPct)}: the panel bends less than half
        as far as it should. Refining helps only slowly. At ${f1.mesh},
        with ${Math.round(f1.dofs / c2.dofs)} times the unknowns of the
        coarsest quadratic mesh, linear tetrahedra are still ${pct(f1.errPct)}
        off; quadratic ones at ${c2.mesh} are ${pct(c2.errPct)}.</p>
        <p>The displacement is not the only thing that suffers. A locked mesh
        also gets the pressure wrong, which shows as checkerboard noise in
        the stresses.</p>
        <p>What to do in KoFEM: for rubber and other materials with ν above
        about 0.45, mesh with quadratic elements and compare two element
        sizes. KoFEM has no mixed or B-bar elements, which remove locking at
        the root. The Solve panel warns when a solid body with ν above 0.45
        is meshed with linear elements.</p>`;
  },
  references: [REF.casquero2024, REF.cook1974, REF.hughes2000],
};
