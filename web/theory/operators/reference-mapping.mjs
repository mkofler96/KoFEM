// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { equation, matrixEquation, tex } from "./math.mjs";
import { figure } from "../figures/index.mjs";

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
    <p>Let ${tex("ξ = (ξ, η, ζ)^T")} be dimensionless
      <a href="/theory/notation/#reference-coordinates">reference coordinates</a>. The map
      ${tex("x = F(ξ)")} takes a reference point (3-vector) to a physical position
      (3-vector, mm). For an isoparametric element,</p>
    ${figure("reference-mapping", "One map takes the reference square to a physical quadrilateral. Lines of constant ξ and η (dashed) become the mapped grid; the arrows are the columns of the Jacobian, the mapped ξ and η directions. Shown in two dimensions for clarity.")}
    ${equation("x_i = F_i(ξ) = \\sum_a N_a^{\\mathrm{r}}(ξ) x_{ai}.", "Physical position interpolates nodal positions using reference shape functions")}
    <p>Here ${tex("x_a")} is physical node ${tex("a")}’s position and ${tex("N_a^{\\mathrm{r}}")} is its reference
      <a href="/theory/notation/#shape-functions">shape function</a>.
      The upright superscript ${tex("\\mathrm{r}")} labels a reference quantity; it is not a power.
      For a linear reference tetrahedron, ${tex("ξ, η, ζ ≥ 0")} and ${tex("ξ + η + ζ ≤ 1")};
      its shape functions are ${tex("1 - ξ - η - ζ")}, ${tex("ξ")}, ${tex("η")} and ${tex("ζ")}.</p>
    <p>Use an affine map ${tex("x = 10 + 2ξ + η")}, ${tex("y = 20 + 3η")},
      ${tex("z = 30 + 4ζ")}, with physical lengths in mm. It maps the reference origin
      to ${tex("(10, 20, 30)\\text{ mm}")} and the three other vertices to ${tex("(12, 20, 30)")},
      ${tex("(11, 23, 30)")} and ${tex("(10, 20, 34)\\text{ mm}")}.
      At ${tex("ξ = η = ζ = 1/4")}, the physical point is ${tex("(10.75, 20.75, 31)\\text{ mm}")}.</p>

    <h2 id="jacobian">Jacobian: local directions and scale</h2>
    <p>The <a href="/theory/notation/#jacobian">Jacobian ${tex("J")}</a> is the 3 × 3
      derivative of ${tex("F")}. Its row is the physical
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
      step ${tex("h")} in ${tex("η")} moves the physical point by ${tex("(h, 3h, 0)\\text{ mm}")}.
      The determinant is ${tex("2 × 3 × 4 = 24\\text{ mm}^3")}: it scales volume, while its
      sign records orientation. The translation ${tex("(10, 20, 30)")} does not affect ${tex("J")}.</p>

    <h2 id="gradient-transform">Transform a shape-function gradient</h2>
    <p>The chain rule for a scalar ${tex("q")} gives
      ${tex("∂q^{\\mathrm{r}}/∂ξ_j = (∂q/∂x_i)J_{ij}")},
      where ${tex("q^{\\mathrm{r}}(ξ) = q(F(ξ))")}. In particular, the physical shape function is
      ${tex("N_a(x) = N_a^{\\mathrm{r}}(F^{-1}(x))")}. With gradients stored as column 3-vectors,
      this means ${tex("∇_ξq^{\\mathrm{r}} = J^T∇_xq")}, hence:</p>
    ${equation("∇_x N_a = J^{-T} ∇_ξ N_a^{\\mathrm{r}}.", "The physical shape-function gradient is the inverse transpose Jacobian times the reference gradient")}
    <p>${tex("J^{-T}")} means ${tex("(J^{-1})^T")}. The output is a 3-vector with units 1/mm,
      since ${tex("N_a")} is dimensionless. For ${tex("N_2^{\\mathrm{r}} = η")}, its reference gradient is
      ${tex("(0, 1, 0)^T")}. The inverse transpose is:</p>
    ${matrixEquation(
      "J^{-T} =",
      [
        ["1/2", "0", "0"],
        ["-1/6", "1/3", "0"],
        ["0", "0", "1/4"],
      ],
      "Inverse transpose Jacobian in inverse millimetres",
    )}
    <p>Thus ${tex("∇_xN_2 = (0, 1/3, 0)^T\\text{ mm}^{-1}")}. Independently,
      ${tex("η = (y - 20)/3")}, giving the same derivative. Multiplying by ${tex("J^{-1}")}
      instead would incorrectly give ${tex("(-1/6, 1/3, 0)^T")}.
      The skew in this example makes the transpose matter.</p>
    <p>A nonzero gradient in ${tex("x")} is visible for ${tex("N_1^{\\mathrm{r}} = ξ")}:
      ${tex("ξ = (x - 10)/2 - (y - 20)/6")}, so
      ${tex("∇_xN_1 = (1/2, -1/6, 0)^T\\text{ mm}^{-1}")}.
      These transformed gradients enter the
      <a href="/theory/operators/gradient-divergence/#vector-gradient">displacement gradient</a>
      and the <a href="/theory/notation/#strain-displacement">${tex("B")} matrix</a>.</p>

    <h2 id="integration-transform">Transform an integral</h2>
    <p>Changing variables converts a physical volume integral into a reference
      integral. For a scalar integrand ${tex("g")}, both sides are scalars:</p>
    ${equation("\\int_{Ω_e} g(x)\\,dV = \\int_{Ω^{\\mathrm{r}}} g(F(ξ))\\,|\\mathrm{det} J(ξ)|\\,dξ\\,dη\\,dζ.", "Physical integration uses the mapped integrand times the absolute Jacobian determinant")}
    <p>${tex("Ω_e")} is the physical element and ${tex("Ω^{\\mathrm{r}}")} its reference tetrahedron.
      Integrating ${tex("g = 1")} checks the volume. The reference tetrahedron has
      volume 1/6; our constant determinant therefore gives ${tex("24/6 = 4\\text{ mm}^3")}.</p>
    <p>Numerical quadrature replaces the reference integral by a weighted sum,
      ${tex("\\sum_q g(F(ξ_q))|\\mathrm{det}J(ξ_q)|ω_q")},
      with dimensionless reference points ${tex("ξ_q")} and weights ${tex("ω_q")}.
      For this constant integrand, a centroid point with weight 1/6 gives
      the exact volume. This does not make one-point quadrature exact for
      general element stiffness or load integrands.</p>
    <p>Element stiffness uses transformed shape-function derivatives and the
      volume factor together, for example
      ${tex("K^{(e)} = \\int_{Ω_e} B^T C B\\,dV")}.
      Here ${tex("B")} maps displacement coefficients to engineering strain, and ${tex("C")} maps
      engineering strain to stress. ${tex("B")} has units 1/mm and ${tex("C")} has units N/mm²,
      so a solid translational stiffness entry has units N/mm.
      <a href="/theory/numerical-methods/elements-and-quadrature/#worked-element">Elements and quadrature</a>
      evaluates this integral for one tetrahedron and explains the choice of rule.</p>

    <h2 id="mapping-limits">Check the mapping</h2>
    <p>A zero determinant means the local volume has collapsed and ${tex("J")} cannot
      be inverted. A small volume scale or highly stretched directions can
      amplify derivative errors. A negative determinant records a reversed
      orientation; the absolute value in the change-of-variables identity is
      not permission to accept an inverted FEM element. Valid orientation and
      connectivity must be checked using the element’s convention.</p>
    <p>Affine elements have constant ${tex("J")}. Curved or higher-order maps generally
      require ${tex("J")} at each quadrature point, and a map that folds over itself is
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
