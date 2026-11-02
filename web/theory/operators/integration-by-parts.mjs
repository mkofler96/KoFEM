// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { tex } from "../../../examples/validation/lib/tex.mjs";
import { equation } from "./math.mjs";

export default {
  slug: "operators/integration-by-parts",
  description:
    "Worked volume and surface integrals, the divergence theorem and component-level integration by parts explain how equilibrium becomes elastic virtual work.",
  sections: [
    ["volume-and-surface", "Integrate over a body or its boundary"],
    ["divergence-theorem", "Divergence becomes boundary flux"],
    ["integration-by-parts", "Move a derivative"],
    ["weak-form", "From equilibrium to virtual work"],
    ["references", "Sources and further reading"],
  ],
  body: `
    <p class="lede">Why can equilibrium be expressed using first derivatives of displacement?</p>
    <p><a href="/theory/notation/#integral">Integration</a> adds contributions
      over a region. Integration by parts
      then moves a derivative from one factor to another, producing a boundary
      term. This is the bridge from pointwise force balance to the elastic
      weak form. We first use smooth fields on a piecewise smooth boundary;
      the final weak form needs less regularity.</p>

    <h2 id="volume-and-surface">Integrate over a body or its boundary</h2>
    <p>The body occupies <a href="/theory/notation/#domain">Ω</a>, with
      <a href="/theory/notation/#boundary">boundary Γ</a>.
      A volume integral uses dV (mm³); a surface integral uses dS (mm²).
      A scalar field integrates to a scalar and a 3-vector field to a
      3-vector, component by component. Units multiply by the measure.</p>
    ${equation("F = \\int_Γ t\\,dS.", "Integrating traction over a surface gives the resultant force vector")}
    <p>For uniform traction t = (2, 0, 0) N/mm² on a 3 mm by 4 mm face,
      F = (24, 0, 0) N. Uniform body force b = (0, 0, −5) N/mm³ on a
      2 mm by 3 mm by 4 mm block instead gives (0, 0, −120) N.
      A total force and a force density are different inputs.</p>
    <p>For the same face, a uniform test displacement w = (0.1, 0, 0) mm
      gives ${tex("\\int_Γ w\\cdot t\\,dS = 0.1 × 2 × 12 = 2.4\\text{ N·mm}")}.
      This scalar is external virtual work. FEM weights a traction by each
      shape function to distribute it into nodal load contributions,
      ${tex("f_{ai} = \\int_Γ N_a t_i\\,dS")}, which have units N.</p>

    <h2 id="divergence-theorem">Divergence becomes boundary flux</h2>
    <p>For a 3-vector field v, the divergence theorem equates the scalar
      sum of local sources inside a body to the outward flux across its boundary:</p>
    ${equation("\\int_Ω ∇\\cdot v\\,dV = \\int_Γ v\\cdot n\\,dS.", "The volume integral of divergence equals outward boundary flux")}
    <p>Here <a href="/theory/notation/#normal">n</a> is the outward unit normal.
      On the dimensionless unit cube 0 ≤ x, y, z ≤ 1, choose v = (x, 0, 0)ᵀ.
      The divergence is 1, so the volume integral is 1.
      On x = 1, v·n = 1 over unit area; on x = 0 it is zero;
      on the other four faces v·n = 0. Boundary flux is therefore also 1.</p>
    <p>The outward sign matters. With traction t = σn, tensile stress
      pulls outward on opposite faces in opposite directions. A common
      constant vector need not represent both face tractions.</p>

    <h2 id="integration-by-parts">Move a derivative</h2>
    <p>For each force component i, apply the theorem to the product wᵢσᵢⱼ
      with flux index j. Sum over i and j, using the
      <a href="/theory/operators/gradient-divergence/#stress-divergence">row-wise stress divergence</a>:</p>
    ${equation("\\frac{∂(w_i σ_{ij})}{∂x_j} = \\frac{∂w_i}{∂x_j}σ_{ij} + w_i\\frac{∂σ_{ij}}{∂x_j}.", "Component product rule for test displacement times stress")}
    ${equation("\\int_Ω w\\cdot(∇\\cdot σ)\\,dV = \\int_Γ w\\cdot(σn)\\,dS - \\int_Ω ∇w:σ\\,dV.", "Integration by parts moves the stress derivative to the test displacement and adds boundary work")}
    <p>Two fields, a 3-vector w and a 3 × 3 tensor σ, enter this identity;
      each integrated term is a scalar. The derivative moves from stress to w,
      the new volume term has a minus sign, and the boundary term remains.</p>
    <p>A one-dimensional check on 0 ≤ x ≤ 1 makes all signs visible.
      Take w = x and σ = x², both dimensionless. The left side is
      ∫₀¹ x(2x) dx = 2/3. On the right,
      [wσ]₀¹ − ∫₀¹ w′σ dx = 1 − 1/3 = 2/3.
      Dropping the boundary term would give −1/3.</p>

    <h2 id="weak-form">From equilibrium to virtual work</h2>
    <p>For a static classical solid, div σ + b = 0, with symmetric stress.
      Multiply by the <a href="/theory/notation/#test-function">test displacement w</a>,
      integrate, and substitute the identity above. On Γ<sub>D</sub>, the
      test displacement is zero; on Γ<sub>N</sub>, σn equals the prescribed
      traction t. The result is:</p>
    ${equation("\\int_Ω ε(w):σ\\,dV = \\int_Ω w\\cdot b\\,dV + \\int_{Γ_N} w\\cdot t\\,dS.", "Internal virtual work equals body-force work plus prescribed-traction work")}
    <p>Stress symmetry allows ∇w:σ = ε(w):σ: the antisymmetric part of ∇w
      has zero contraction with a symmetric tensor. All terms have units N·mm.
      This equation must hold for every admissible w. Prescribed displacements
      restrict u itself; a zero test field on Γ<sub>D</sub> does not imply
      that the prescribed displacement must be zero.</p>
    <p>With a small-strain linear-elastic law, σ depends on first derivatives
      of u. The weak form therefore uses only first derivatives of u and w.
      Continuous displacement shape functions can have different slopes on
      neighbouring elements. Their stresses need not have a classical
      derivative at the shared face. Substitution of those shape functions
      into the weak form produces element
      <a href="/theory/numerical-methods/elements-and-quadrature/#element-stiffness">stiffness and load integrals</a>.</p>
    <p>The boundary term vanishes only where w is zero or the relevant traction
      work is zero. The identity does not justify removing loads, assuming
      rigid-body stability, or claiming that a computed solution is accurate.
      Singular loads, nonsmooth fields and interfaces require their appropriate
      weak interpretation. A full elastic problem and its boundary choices
      are developed in the later solid-mechanics chapter.</p>

    <h2 id="references">Sources and further reading</h2>
    <ol class="refs">
      <li><a href="https://ocw.mit.edu/courses/18-02sc-multivariable-calculus-fall-2010/">MIT OpenCourseWare: Multivariable Calculus</a>,
        surface integrals and the divergence theorem.</li>
      <li><a href="https://jsdokken.com/dolfinx-tutorial/chapter2/linearelasticity.html">DOLFINx tutorial: The equations of linear elasticity</a>,
        equilibrium, integration by parts and the variational problem.</li>
      <li>Bathe, <cite>Finite Element Procedures</cite> (1996),
        principle of virtual displacements and displacement-based finite elements.</li>
    </ol>`,
};
