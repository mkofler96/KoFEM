// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Case page text: torsion of a hollow circular shaft.

import { hollowShaftFigure } from "../lib/figures.mjs";
import { REF } from "./refs.mjs";

/** Polar moment of a regular n-gon inscribed in a circle of radius r. */
const polygonJ = (r, n) => {
  const a = (2 * Math.PI) / n;
  return ((n * r ** 4) / 12) * Math.sin(a) * (2 + Math.cos(a));
};

export default {
  description:
    "Torsion of a hollow circular shaft, θ = TL/(GJ): derivation, and how the polygonal mesh of a circle explains almost all of KoFEM's error.",
  figure: ({ page }) => hollowShaftFigure({ div: page.grid }),
  intro: () => `
        <p>Torsion of a circular tube is the shaft problem from every
        mechanics-of-materials course. Unlike the
        <a href="/validation/beam-torsion/">square bar</a>, a circular section
        does not warp, so the 1-D theory is exact for the 3-D body away from
        the loaded end. That makes the case a clean test of how well a mesh
        represents a curved boundary.</p>`,
  theory: ({ tex, texBlock, n, row, inp }) => {
    const ri = inp("rᵢ"),
      ro = inp("rₒ"),
      E = inp("E"),
      nu = inp("ν"),
      T = inp("T");
    const J = (Math.PI * (ro ** 4 - ri ** 4)) / 2;
    const G = E / (2 * (1 + nu));
    return `
        <p>By symmetry, each section of a circular shaft stays plane and turns
        as a rigid disc. If the angle of twist grows at the rate ${tex("θ'")}
        along the axis, the material at radius ${tex("r")} is sheared by</p>
        ${texBlock("γ = r θ', \\quad τ = G γ = G r θ'.")}
        <p>The shear stress grows linearly from the inner to the outer
        surface. Its moment about the axis balances the applied torque,</p>
        ${texBlock("T = \\int_{A} τ r \\,\\mathrm{d}A = G θ' \\int_{A} r^2 \\,\\mathrm{d}A = G J θ',")}
        <p>with the polar moment of the annulus</p>
        ${texBlock("J = \\frac{π}{2}\\left(r_{\\mathrm{o}}^4 - r_{\\mathrm{i}}^4\\right).")}
        <p>Over the length ${tex("L")} the free end turns by</p>
        ${texBlock("θ = \\frac{T L}{G J}.")}
        <p>Here ${tex(`J = ${n(J)}\\text{ m}^4`)},
        ${tex(`G = ${n(G / 1e9)}\\text{ GPa}`)} and
        ${tex(`θ = ${n(row.reference)}\\text{ rad}`)}. The largest shear stress,
        at the outer surface, is
        ${tex(`τ_{\\mathrm{max}} = T r_{\\mathrm{o}} / J = ${n((T * ro) / J / 1e6)}\\text{ MPa}`)}.</p>`;
  },
  model: ({ tex, page }) => {
    const [nr, nth, nz] = page.grid;
    return `
        <p>The tube is meshed with ${nr} elements through the wall,
        ${nth} around and ${nz} along the axis. The nodes lie on the true
        circles, but the element edges between them are straight. The torque
        is applied as tangential nodal forces on the end ring, proportional to
        the radius ${tex("r")} (the ${tex("τ ∝ r")} distribution of the exact
        solution) and scaled so the moment is ${tex("T")}. The twist is the
        mean rotation of the end-ring nodes.</p>`;
  },
  discussion: ({ row, pct, tex, texBlock, study, studyDef, inp }) => {
    const ri = inp("rᵢ"),
      ro = inp("rₒ");
    const J = (Math.PI * (ro ** 4 - ri ** 4)) / 2;
    const levels = studyDef.series[0].levels;
    const rows = study.series[0].points
      .map((p, i) => {
        const nth = levels[i][1]; // [radial, around, axial]
        const geom = (J / (polygonJ(ro, nth) - polygonJ(ri, nth)) - 1) * 100;
        return `
              <tr${p.ci ? ' class="ci"' : ""}>
                <td class="num">${nth}</td>
                <td class="num">${pct(geom)}</td>
                <td class="num">${pct(p.errPct)}</td>
              </tr>`;
      })
      .join("");
    return `
        <p>KoFEM's twist differs from the reference by ${pct(row.errPct)}, and almost
        all of it is geometry. With straight element edges, the section of the
        mesh is the ring between two regular polygons inscribed in the true
        circles. Its polar moment is smaller than ${tex("J")}, so it twists
        more. The polar moment of a regular ${tex("n")}-gon inscribed in a
        circle of radius ${tex("r")} is</p>
        ${texBlock("J_{n} = \\frac{n r^4}{12}\\sin\\frac{2π}{n}\\left(2 + \\cos\\frac{2π}{n}\\right),")}
        <p>which tends to ${tex("π r^4 / 2")} as ${tex("n")} grows. The twist
        the polygon alone predicts, ${tex("J / J_{n} - 1")}, matches KoFEM's
        error on every mesh of the convergence study:</p>
        <div class="table-wrap">
          <table class="data">
            <thead>
              <tr>
                <th scope="col" class="num">Segments</th>
                <th scope="col" class="num">Polygon alone</th>
                <th scope="col" class="num">KoFEM</th>
              </tr>
            </thead>
            <tbody>${rows}
            </tbody>
          </table>
        </div>
        <p>What the elements add on top is under a tenth of a percent. The
        geometric error falls with the square of the segment angle, which is
        the factor of four per refinement in the convergence plot. More
        segments, or curved higher-order elements, remove it. The same holds
        for any curved surface in a model: the mesh replaces it with facets,
        and stiffness follows the facets.</p>`;
  },
  references: [REF.gere, REF.timoshenkoGoodier],
};
