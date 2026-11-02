// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { tex } from "../../../examples/validation/lib/tex.mjs";
import { equation, matrixEquation } from "./math.mjs";

export default {
  slug: "operators/tensor-products",
  description:
    "Small worked examples distinguish dot and outer products, transpose, trace and double contraction, including the engineering-shear factors in elastic work.",
  sections: [
    ["dot-product", "Dot product: a scalar"],
    ["outer-product", "Outer product: a tensor"],
    ["transpose", "Transpose: swap indices"],
    ["trace", "Trace: add the diagonal"],
    ["double-contraction", "Double contraction and shear"],
    ["references", "Sources and further reading"],
  ],
  body: `
    <p class="lede">Which products keep directions, and which reduce them to a scalar?</p>
    <p>Use a fixed Cartesian basis and the
      <a href="/theory/notation/#reading-notation">shared index convention</a>:
      repeated spatial indices are summed. The small arrays below are
      dimensionless unless units are shown. Their sizes describe the input
      and output shapes; units follow the individual physical quantities.</p>

    <h2 id="dot-product">Dot product: a scalar</h2>
    <p>The <a href="/theory/notation/#dot-product">dot product</a> takes two
      3-vectors to one scalar. It measures their alignment, weighted by length:</p>
    ${equation("a\\cdot b = \\sum_{i=1}^3 a_i b_i.", "Dot product sums matching vector components")}
    <p>For a = (1, 2, 0)ᵀ and b = (3, −1, 4)ᵀ,
      a·b = 1 × 3 + 2 × (−1) + 0 × 4 = 1.
      The result has no direction. Orthogonal vectors have zero dot product.</p>
    <p>In virtual work, a force dotted with a test displacement has units
      N·mm. A force (10, 0, 0) N and displacement (0, 2, 0) mm give zero work;
      only displacement along the force contributes. Distributed loads use
      the same product inside a volume or surface integral.</p>

    <h2 id="outer-product">Outer product: a tensor</h2>
    <p>The <a href="/theory/notation/#outer-product">outer (tensor) product</a>
      keeps both component directions. Two
      3-vectors produce a 3 × 3 tensor:</p>
    ${equation("(a⊗b)_{ij} = a_i b_j.", "Outer product multiplies component i of the first vector by component j of the second")}
    ${matrixEquation(
      "a⊗b =",
      [
        ["3", "-1", "4"],
        ["6", "-2", "8"],
        ["0", "0", "0"],
      ],
      "Outer product of vectors one two zero and three minus one four",
    )}
    <p>The xy entry is 1 × (−1) = −1, whereas the yx entry is 2 × 3 = 6.
      The product is generally not symmetric. Units multiply, just as for a
      dot product, but the output retains two indices.</p>
    <p>In displacement interpolation,
      ${tex("∇u^h = \\sum_a d_a ⊗ ∇N_a")}:
      the nodal displacement dₐ (a 3-vector, mm) and shape-function gradient
      (a 3-vector, 1/mm) form a dimensionless tensor. This agrees with the
      <a href="/theory/operators/gradient-divergence/#vector-gradient">row-component gradient convention</a>.</p>

    <h2 id="transpose">Transpose: swap indices</h2>
    <p>A <a href="/theory/notation/#transpose">transpose</a> exchanges rows
      and columns: (Aᵀ)ᵢⱼ = Aⱼᵢ. An m × n input becomes n × m;
      units stay the same. For a rectangular example:</p>
    ${matrixEquation(
      "A =",
      [
        ["1", "2", "3"],
        ["4", "5", "6"],
      ],
      "A two by three matrix",
    )}
    ${matrixEquation(
      "A^T =",
      [
        ["1", "4"],
        ["2", "5"],
        ["3", "6"],
      ],
      "Its three by two transpose",
    )}
    <p>Thus (Aᵀ)₂₁ = A₁₂ = 2. A symmetric tensor equals its transpose.
      Averaging ∇u and (∇u)ᵀ gives small strain. In stiffness assembly,
      BᵀCB has compatible shapes: if B maps n element DOFs to six engineering
      strain components, then B is 6 × n, C is 6 × 6 and BᵀCB is n × n.</p>

    <h2 id="trace">Trace: add the diagonal</h2>
    <p>The <a href="/theory/notation/#trace">trace</a> maps a square tensor
      to a scalar by adding its diagonal. It preserves units:</p>
    ${equation("\\mathrm{tr}(A) = \\sum_{i=1}^3 A_{ii}.", "Trace sums the three diagonal components")}
    ${matrixEquation(
      "A =",
      [
        ["1", "2", "0"],
        ["3", "4", "0"],
        ["0", "0", "5"],
      ],
      "Trace example with diagonal entries one four five",
    )}
    <p>Here tr A = 1 + 4 + 5 = 10; the off-diagonal entries do not enter.
      For infinitesimal strain, tr ε is first-order relative volume change.
      In the isotropic law σ = λ tr(ε)I + 2με, the identity I is a 3 × 3
      tensor with ones on the diagonal. The trace term therefore adds equal
      normal stress in all three directions. See
      <a href="/theory/notation/#lame-parameters">Lamé parameters</a>.</p>

    <h2 id="double-contraction">Double contraction and shear</h2>
    <p>The <a href="/theory/notation/#double-contraction">double contraction</a>
      takes two tensors of the same shape to a scalar, multiplying and summing
      every matching component. For 3 × 3 tensors:</p>
    ${equation("A:B = \\sum_{i=1}^3 \\sum_{j=1}^3 A_{ij}B_{ij} = \\mathrm{tr}(A^T B).", "Double contraction sums all nine matching products")}
    <p>This is not ordinary matrix multiplication. For symmetric stress and
      strain, both xy and yx entries contribute the same product:</p>
    ${equation("σ:ε = σ_{xx}ε_{xx} + σ_{yy}ε_{yy} + σ_{zz}ε_{zz} + 2σ_{yz}ε_{yz} + 2σ_{xz}ε_{xz} + 2σ_{xy}ε_{xy}.", "Symmetric stress strain contraction counts each off-diagonal shear pair twice")}
    <p>Take pure shear εₓᵧ = εᵧₓ = 0.001, all other strains zero, and
      σₓᵧ = σᵧₓ = 160 MPa, all other stresses zero. Then
      σ:ε = 160 × 0.001 + 160 × 0.001 = 0.32 MPa.
      The six-component engineering strain vector has γₓᵧ = 0.002, so its
      pairing with the undoubled shear stress gives the same 160 × 0.002.</p>
    <p>The shared order is xx, yy, zz, yz, xz, xy:
      <a href="/theory/notation/#engineering-shear">double the strain shear entries, not the stresses</a>.
      In proportional linear elasticity from zero stress, stored energy density
      is ½σ:ε = 0.16 N/mm², equivalently 0.16 N·mm/mm³.
      A virtual-work integrand instead uses σ:ε(w) without that half.
      Using tensor shear in a six-component engineering pairing would miss
      half the shear contribution.</p>

    <h2 id="references">Sources and further reading</h2>
    <ol class="refs">
      <li><a href="https://ocw.mit.edu/courses/18-02sc-multivariable-calculus-fall-2010/">MIT OpenCourseWare: Multivariable Calculus</a>,
        vector products and their geometric meaning.</li>
      <li><a href="https://ocw.mit.edu/courses/2-080j-structural-mechanics-fall-2013/">MIT OpenCourseWare: Structural Mechanics</a>,
        tensor components, strain and elastic energy.</li>
      <li>Bathe, <cite>Finite Element Procedures</cite> (1996),
        displacement-based elasticity and engineering-strain matrices.</li>
    </ol>`,
};
