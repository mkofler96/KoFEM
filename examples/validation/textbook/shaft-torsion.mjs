// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Page text: torsion of a hollow circular shaft.

import { hollowShaftFigure } from "../lib/figures.mjs";
import { REF } from "./refs.mjs";

/** The study's series of one element order. */
const seriesOf = (study, order) => {
  const s = study.series.find((x) => x.order === order);
  if (!s) throw new Error(`shaft-torsion study has no order-${order} series`);
  return s;
};

export default {
  description:
    "Torsion of a hollow circular shaft, θ = TL/(GJ): derivation, why linear tetrahedra are too stiff here, and how the polygonal mesh of a circle explains most of KoFEM's error.",
  figure: () => hollowShaftFigure({ div: null }),
  intro: ({ url }) => `
        <p>Torsion of a circular tube is the shaft problem from every
        mechanics-of-materials course. Unlike the
        <a href="${url("beam-torsion")}">square bar</a>, a circular section
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
        <p>Here ${tex(`J = ${n(J)}\\text{ mm}^4`)},
        ${tex(`G = ${n(G / 1e3)}\\text{ GPa}`)} and
        ${tex(`θ = ${n(row.reference)}\\text{ rad}`)}. The largest shear stress,
        at the outer surface, is
        ${tex(`τ_{\\mathrm{max}} = T r_{\\mathrm{o}} / J = ${n((T * ro) / J)}\\text{ MPa}`)}.</p>`;
  },
  model: ({ tex }) => `
        <p>The tube is the STEP file a user imports, meshed by Netgen with
        quadratic tetrahedra. The z = 0 end face is fixed and the moment sits
        on the z = L end face. The app applies a moment to a face as
        tangential forces at the face's nodes, proportional to their distance
        ${tex("r")} from the centre of the face (the ${tex("τ ∝ r")} of the exact solution)
        and scaled so their moment is ${tex("T")}. The twist is the mean
        rotation of the end face's nodes about the axis.</p>
        <p>The mesh nodes lie on the true circles, but the element edges
        between them are straight, so the section of the mesh is the ring
        between two polygons. Quadratic elements are used because linear ones
        are too stiff here; see the discussion.</p>`,
  discussion: ({ row, pct, tex, texBlock, study, studyDef, inp }) => {
    const ri = inp("rᵢ"),
      ro = inp("rₒ");
    const p1 = seriesOf(study, 1).points;
    const p2 = seriesOf(study, 2).points;
    const levels = seriesOf(studyDef, 2).levels;
    if (levels.length !== p2.length)
      throw new Error("shaft-torsion study: P2 levels and points differ");
    const size = row.mesh.maxElementSize;
    const p1Here = p1.find((p) => p.mesh === `${size} mm`);
    if (!p1Here)
      throw new Error(
        `shaft-torsion study: no P1 point at the case's ${size} mm`,
      );
    // Edges of length h on a circle of radius r cut its polar moment by
    // about h²/(3r²), so the ring twists more by h²/(3(rₒ² + rᵢ²)).
    const rows = p2
      .map((p, i) => {
        const geom = (100 * levels[i] ** 2) / (3 * (ro ** 2 + ri ** 2));
        return `
              <tr${p.ci ? ' class="ci"' : ""}>
                <td class="num">${p.mesh}</td>
                <td class="num">${pct(geom)}</td>
                <td class="num">${pct(p.errPct)}</td>
              </tr>`;
      })
      .join("");
    return `
        <p>KoFEM's twist differs from the reference by ${pct(row.errPct)}.
        Most of that is geometry. The polar moment of a regular
        ${tex("n")}-gon inscribed in a circle of radius ${tex("r")} is</p>
        ${texBlock("J_{n} = \\frac{n r^4}{12}\\sin\\frac{2π}{n}\\left(2 + \\cos\\frac{2π}{n}\\right) ≈ \\frac{π r^4}{2}\\left(1 - \\frac{h^2}{3 r^2}\\right),")}
        <p>with the edge length ${tex("h ≈ 2π r / n")}. Netgen makes the edges
        on each circle about as long as the element size, so the ring of
        polygons twists more than the tube by about
        ${tex("h^2 / \\left(3 (r_{\\mathrm{o}}^2 + r_{\\mathrm{i}}^2)\\right)")}:</p>
        <div class="table-wrap">
          <table class="data">
            <thead>
              <tr>
                <th scope="col" class="num">Element size</th>
                <th scope="col" class="num">Polygon alone</th>
                <th scope="col" class="num">KoFEM (P2)</th>
              </tr>
            </thead>
            <tbody>${rows}
            </tbody>
          </table>
        </div>
        <p>The polygon error falls with the square of the element size. The
        rest, about a percent, comes from the loaded end: the moment arrives
        as forces at single nodes, and the twist is read at those same nodes,
        which give a little under them. Away from the end, the twist rate is
        close to what the polygon alone predicts. This end part shrinks too,
        but more slowly than the polygon error.</p>
        <p>Linear tetrahedra behave differently. With two elements through
        the wall they are far too stiff in torsion, and come out
        ${pct(p1Here.errPct)} on the same mesh. They approach the reference
        from below while the polygon pushes the other way, so a linear mesh
        that lands near the reference does so by cancellation, not
        convergence. Quadratic elements converge steadily, which is why this
        example uses them.</p>`;
  },
  references: [REF.gere, REF.timoshenkoGoodier],
};
