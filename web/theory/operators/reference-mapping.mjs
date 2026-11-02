// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { tex } from "../../../examples/validation/lib/tex.mjs";
import { equation, matrixEquation } from "./math.mjs";

export default {
  slug: "operators/reference-mapping",
  description:
    "An affine tetrahedron example explains reference-to-physical mappings, Jacobian determinants, inverse-transpose gradients and their role in FEM quadrature.",
  sections: [
    ["element-map", "Map one reference element"],
    ["jacobian", "Jacobian: local directions and scale"],
    ["gradient-transform", "Transform a shape-function gradient"],
    ["integration-transform", "Transform an integral"],
    ["mapping-limits", "Check the mapping"],
    ["references", "Sources and further reading"],
  ],
  body: `
    <p class="lede">How can the same shape functions and integration points work on different elements?</p>
    <p>Define them once on a simple reference element, then map them to each
      physical element. The Jacobian converts directions, derivatives and
      integration weights. This page considers three-dimensional volume
      elements; surface and shell mappings need surface measures instead.</p>

    <h2 id="element-map">Map one reference element</h2>
    <p>Let ξ = (ξ, η, ζ)ᵀ be dimensionless
      <a href="/theory/notation/#reference-coordinates">reference coordinates</a>. The map
      x = F(ξ) takes a reference point (3-vector) to a physical position
      (3-vector, mm). For an isoparametric element,</p>
    ${equation("x_i = F_i(ξ) = \\sum_a N_a^r(ξ) x_{ai}.", "Physical position interpolates nodal positions using reference shape functions")}
    <p>Here xₐ is physical node a’s position and Nₐʳ is its reference
      <a href="/theory/notation/#shape-functions">shape function</a>.
      The superscript r labels a reference quantity; it is not a power.
      For a linear reference tetrahedron, ξ, η, ζ ≥ 0 and ξ + η + ζ ≤ 1;
      its shape functions are 1 − ξ − η − ζ, ξ, η and ζ.</p>
    <p>Use an affine map x = 10 + 2ξ + η, y = 20 + 3η,
      z = 30 + 4ζ, with physical lengths in mm. It maps the reference origin
      to (10, 20, 30) mm and the three other vertices to (12, 20, 30),
      (11, 23, 30) and (10, 20, 34) mm.
      At ξ = η = ζ = 1/4, the physical point is (10.75, 20.75, 31) mm.</p>

    <h2 id="jacobian">Jacobian: local directions and scale</h2>
    <p>The <a href="/theory/notation/#jacobian">Jacobian J</a> is the 3 × 3
      derivative of F. Its row is the physical
      component and its column the reference direction:</p>
    ${equation("J_{ij} = \\frac{∂x_i}{∂ξ_j}, \\quad dx_i = J_{ij}\\,dξ_j.", "Jacobian maps a small reference step into a physical step")}
    ${matrixEquation(
      "J =",
      [
        ["2", "1", "0"],
        ["0", "3", "0"],
        ["0", "0", "4"],
      ],
      "Affine element Jacobian in millimetres, with a skew term in the xy position",
    )}
    <p>Each column is a mapped reference-axis direction, in mm. A small
      step h in η moves the physical point by (h, 3h, 0) mm.
      The determinant is 2 × 3 × 4 = 24 mm³: it scales volume, while its
      sign records orientation. The translation (10, 20, 30) does not affect J.</p>

    <h2 id="gradient-transform">Transform a shape-function gradient</h2>
    <p>The chain rule for a scalar q gives
      ${tex("∂q^r/∂ξ_j = (∂q/∂x_i)J_{ij}")},
      where qʳ(ξ) = q(F(ξ)). In particular, the physical shape function is
      Nₐ(x) = Nₐʳ(F⁻¹(x)). With gradients stored as column 3-vectors,
      this means ∇<sub>ξ</sub>qʳ = Jᵀ∇<sub>x</sub>q, hence:</p>
    ${equation("∇_x N_a = J^{-T} ∇_ξ N_a^r.", "The physical shape-function gradient is the inverse transpose Jacobian times the reference gradient")}
    <p>J⁻ᵀ means (J⁻¹)ᵀ. The output is a 3-vector with units 1/mm,
      since Nₐ is dimensionless. For N₂ʳ = η, its reference gradient is
      (0, 1, 0)ᵀ. The inverse transpose is:</p>
    ${matrixEquation(
      "J^{-T} =",
      [
        ["1/2", "0", "0"],
        ["-1/6", "1/3", "0"],
        ["0", "0", "1/4"],
      ],
      "Inverse transpose Jacobian in inverse millimetres",
    )}
    <p>Thus ∇<sub>x</sub>N₂ = (0, 1/3, 0)ᵀ mm⁻¹. Independently,
      η = (y − 20)/3, giving the same derivative. Multiplying by J⁻¹
      instead would incorrectly give (−1/6, 1/3, 0)ᵀ.
      The skew in this example makes the transpose matter.</p>
    <p>A nonzero gradient in x is visible for N₁ʳ = ξ:
      ξ = (x − 10)/2 − (y − 20)/6, so
      ∇<sub>x</sub>N₁ = (1/2, −1/6, 0)ᵀ mm⁻¹.
      These transformed gradients enter the
      <a href="/theory/operators/gradient-divergence/#vector-gradient">displacement gradient</a>
      and the <a href="/theory/notation/#strain-displacement">B matrix</a>.</p>

    <h2 id="integration-transform">Transform an integral</h2>
    <p>Changing variables converts a physical volume integral into a reference
      integral. For a scalar integrand g, both sides are scalars:</p>
    ${equation("\\int_{Ω_e} g(x)\\,dV = \\int_{Ω^r} g(F(ξ))\\,|\\mathrm{det} J(ξ)|\\,dξ\\,dη\\,dζ.", "Physical integration uses the mapped integrand times the absolute Jacobian determinant")}
    <p>Ω<sub>e</sub> is the physical element and Ωʳ its reference tetrahedron.
      Integrating g = 1 checks the volume. The reference tetrahedron has
      volume 1/6; our constant determinant therefore gives 24/6 = 4 mm³.</p>
    <p>Numerical quadrature replaces the reference integral by a weighted sum,
      ${tex("\\sum_q g(F(ξ_q))|\\mathrm{det}J(ξ_q)|ω_q")},
      with dimensionless reference points ξ<sub>q</sub> and weights ω<sub>q</sub>.
      For this constant integrand, a centroid point with weight 1/6 gives
      the exact volume. This does not make one-point quadrature exact for
      general element stiffness or load integrands.</p>
    <p>Element stiffness uses transformed shape-function derivatives and the
      volume factor together, for example
      ${tex("K^{(e)} = \\int_{Ω_e} B^T C B\\,dV")}.
      Here B maps displacement coefficients to engineering strain, and C maps
      engineering strain to stress. B has units 1/mm and C has units N/mm²,
      so a solid translational stiffness entry has units N/mm.</p>

    <h2 id="mapping-limits">Check the mapping</h2>
    <p>A zero determinant means the local volume has collapsed and J cannot
      be inverted. A small volume scale or highly stretched directions can
      amplify derivative errors. A negative determinant records a reversed
      orientation; the absolute value in the change-of-variables identity is
      not permission to accept an inverted FEM element. Valid orientation and
      connectivity must be checked using the element’s convention.</p>
    <p>Affine elements have constant J. Curved or higher-order maps generally
      require J at each quadrature point, and a map that folds over itself is
      invalid even if a few sampled determinants are nonzero. Surface elements
      use tangent vectors and an area factor, not this 3D volume determinant.
      Integration order, element quality and solver conditioning remain
      separate questions.</p>

    <h2 id="references">Sources and further reading</h2>
    <ol class="refs">
      <li><a href="https://mfem.org/integration/">MFEM: Integration</a>,
        reference integration points, element transformations and Jacobians.</li>
      <li><a href="https://ocw.mit.edu/courses/18-02sc-multivariable-calculus-fall-2010/">MIT OpenCourseWare: Multivariable Calculus</a>,
        the chain rule and change of variables.</li>
      <li>Bathe, <cite>Finite Element Procedures</cite> (1996),
        isoparametric interpolation and numerical integration.</li>
    </ol>`,
};
