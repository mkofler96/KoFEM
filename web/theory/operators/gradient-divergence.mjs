// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { tex } from "../../../examples/validation/lib/tex.mjs";
import { equation, matrixEquation } from "./math.mjs";

export default {
  slug: "operators/gradient-divergence",
  description:
    "Worked component examples of scalar and vector gradients, small strain and divergence, with explicit tensor conventions and connections to elasticity.",
  sections: [
    ["scalar-gradient", "Gradient of a scalar"],
    ["vector-gradient", "Gradient of a vector"],
    ["symmetric-gradient", "Small strain and shear"],
    ["vector-divergence", "Divergence of a vector"],
    ["stress-divergence", "Divergence of stress"],
    ["references", "Sources and further reading"],
  ],
  body: `
    <p class="lede">How do derivatives connect displacement, strain, stress and equilibrium?</p>
    <p>A field varies from point to point. A gradient records that variation;
      a divergence measures its net outward flow. We use a fixed Cartesian
      basis with x₁ = x, x₂ = y and x₃ = z, following the
      <a href="/theory/notation/#reading-notation">index convention</a>.
      The polynomial examples below use dimensionless coordinates and values
      unless units are shown. They illustrate operators, not solved models.</p>

    <h2 id="scalar-gradient">Gradient of a scalar</h2>
    <p>The <a href="/theory/notation/#gradient">gradient</a> turns a
      scalar field q into a 3-vector of slopes. A component gives the change
      per unit distance along that coordinate axis:</p>
    ${equation("(∇q)_i = \\frac{∂q}{∂x_i}, \\quad ∇q = (∂q/∂x, ∂q/∂y, ∂q/∂z)^T.", "A scalar field maps to three spatial derivatives")}
    <p>For q = x² + 3y, the derivatives are (2x, 3, 0). At (2, 1, 0),
      q = 7 and ∇q = (4, 3, 0)ᵀ. A small step h along x changes q by
      approximately 4h; a step along z does not change it. The gradient points
      toward the steepest local increase.</p>
    <p>Units divide by length: a pressure gradient has units MPa/mm.
      In FEM, the gradient of a dimensionless
      <a href="/theory/notation/#shape-functions">shape function Nₐ</a>
      has units 1/mm. These derivatives turn nodal displacements into strain.</p>

    <h2 id="vector-gradient">Gradient of a vector</h2>
    <p>A 3-vector field v has three slopes for each of its three components.
      Its gradient is a 3 × 3 tensor. <strong>Row i identifies the vector
      component; column j identifies the differentiation direction.</strong></p>
    ${equation("(∇v)_{ij} = \\frac{∂v_i}{∂x_j}.", "Vector gradient: component i differentiated with respect to coordinate j")}
    <p>For the displacement field u = (0.001x + 0.002y,
      −0.004x + 0.003y, 0.005z)ᵀ, with coordinates and displacement both
      measured in mm, the dimensionless gradient is constant:</p>
    ${matrixEquation(
      "∇u =",
      [
        ["0.001", "0.002", "0"],
        ["-0.004", "0.003", "0"],
        ["0", "0", "0.005"],
      ],
      "Displacement gradient: rows are displacement components, columns are x, y and z derivatives",
    )}
    <p>The xy entry is ∂uₓ/∂y = 0.002; the yx entry is ∂uᵧ/∂x = −0.004.
      Some texts transpose this convention. Check the component definition
      before transferring a formula. In an element, differentiating
      ${tex("u_i^h = \\sum_a N_a d_{ai}")} gives
      ${tex("(∇u^h)_{ij} = \\sum_a d_{ai} ∂N_a/∂x_j")}:
      each nodal coefficient multiplies a shape-function slope.</p>

    <h2 id="symmetric-gradient">Small strain and shear</h2>
    <p>The gradient includes both deformation and local rotation. Its
      <a href="/theory/notation/#symmetric-gradient">symmetric part</a>
      gives the infinitesimal strain tensor, a symmetric 3 × 3 output:</p>
    ${equation("ε_{ij}(u) = \\frac{1}{2}((∇u)_{ij} + (∇u)_{ji}).", "Small strain averages each gradient component with its transposed component")}
    ${matrixEquation(
      "ε(u) =",
      [
        ["0.001", "-0.001", "0"],
        ["-0.001", "0.003", "0"],
        ["0", "0", "0.005"],
      ],
      "Strain for the displacement example, including xy shear of minus 0.001",
    )}
    <p>Here εₓᵧ = (0.002 − 0.004)/2 = −0.001.
      The <a href="/theory/notation/#engineering-shear">engineering shear</a>
      is γₓᵧ = 2εₓᵧ = −0.002. With shear modulus μ = 80000 MPa,
      σₓᵧ = 2μεₓᵧ = μγₓᵧ = −160 MPa. See
      <a href="/theory/operators/tensor-products/#double-contraction">why shear appears twice in tensor work</a>.</p>
    <p>As a check, u = (−θy, θx, 0)ᵀ has opposite xy and yx derivatives,
      so its symmetric gradient is zero. This is an <em>infinitesimal</em>
      rigid rotation. Small-strain kinematics neglect quadratic gradient terms;
      finite rotations need a different strain measure.</p>

    <h2 id="vector-divergence">Divergence of a vector</h2>
    <p>The <a href="/theory/notation/#divergence">divergence</a> maps a
      3-vector field to a scalar by adding its outward directional changes:</p>
    ${equation("∇\\cdot v = \\frac{∂v_x}{∂x} + \\frac{∂v_y}{∂y} + \\frac{∂v_z}{∂z} = \\mathrm{tr}(∇v).", "Vector divergence is the sum of the three diagonal gradient entries")}
    <p>For v = (x², xy, z)ᵀ, div v = 2x + x + 1 = 3x + 1,
      giving 7 at x = 2. Positive divergence means a small region has more
      outgoing than incoming flow. For displacement, div u = tr ε gives
      first-order relative volume change: the example above gives 0.009.</p>

    <h2 id="stress-divergence">Divergence of stress</h2>
    <p>Stress is a tensor field, so its divergence is a 3-vector. Using the
      <a href="/theory/notation/#traction">traction convention tᵢ = σᵢⱼnⱼ</a>,
      differentiate and sum across each row:</p>
    ${equation("(∇\\cdot σ)_i = \\sum_{j=1}^3 \\frac{∂σ_{ij}}{∂x_j}.", "Stress divergence sums derivatives across row i to form force component i")}
    ${matrixEquation(
      "σ =",
      [
        ["x^2", "xy", "0"],
        ["xy", "2y", "0"],
        ["0", "0", "3z"],
      ],
      "Symmetric polynomial stress example in dimensionless coordinates",
    )}
    <p>The x component is 2x + x + 0 = 3x; the y component is y + 2 + 0;
      the z component is 3. At (2, 1, 0), div σ = (6, 3, 3)ᵀ.
      This is different from taking the gradient of tr σ.</p>
    <p>In physical units, differentiating stress (N/mm²) gives N/mm³,
      matching <a href="/theory/notation/#body-force">body force per volume b</a>.
      Static equilibrium is div σ + b = 0. The
      <a href="/theory/operators/integration-by-parts/#weak-form">weak form</a>
      transfers this derivative to a test displacement so neighbouring FEM
      elements need not share a pointwise stress derivative.</p>

    <h2 id="references">Sources and further reading</h2>
    <ol class="refs">
      <li><a href="https://ocw.mit.edu/courses/18-02sc-multivariable-calculus-fall-2010/">MIT OpenCourseWare: Multivariable Calculus</a>,
        gradient, divergence and flux.</li>
      <li><a href="https://ocw.mit.edu/courses/2-080j-structural-mechanics-fall-2013/">MIT OpenCourseWare: Structural Mechanics</a>,
        infinitesimal strain and stress equilibrium.</li>
      <li>KoFEM’s solid recovery at reviewed revision
        <a href="https://github.com/mkofler96/KoFEM/blob/77ff67ed76c724924decc8c2691f0f5fbd4aea5b/engine/cpp/solve_mfem.cpp#L127">77ff67e (2 November 2026)</a>
        obtains a displacement gradient, symmetrises it and applies the Lamé
        material law. The explicit
        <a href="https://github.com/mkofler96/KoFEM/blob/77ff67ed76c724924decc8c2691f0f5fbd4aea5b/engine/cpp/tet_element.cpp#L139">coupled-solid gradient</a>
        uses the same component convention. The calculations here verify the
        operators, not a full solver or shell formulation.</li>
    </ol>`,
};
