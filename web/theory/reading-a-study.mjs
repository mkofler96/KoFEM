// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { equation, tex } from "./operators/math.mjs";

export default {
  slug: "foundations/reading-a-study",
  description:
    "Follow an axial bar from physical assumptions and coherent units through the elastic equations, loads, FEM discretisation, linear solve and verified displacement and stress results.",
  sections: [
    ["question", "Start with a question"],
    ["model", "Choose the physical model"],
    ["equations", "Connect displacement to equilibrium"],
    ["discretization", "Build and solve a discrete study"],
    ["results", "Check the answer"],
    ["reading-path", "Follow the connected guide"],
  ],
  body: `
    <p class="lede">How do geometry, materials, constraints, loads, the FEM discretisation, and results form one study?</p>
    <p>Follow a bar pulled along its length. Each modelling choice becomes an
      input to the equations; each numerical result needs a defined comparison.
      The <a href="/theory/verification/axial-bar/">axial-bar verification</a>
      provides the runnable model, measured values and source references for this path.</p>

    <h2 id="question">Start with a question</h2>
    <p>How far does the loaded end extend, and does the stress in the middle
      match uniform tension? These are two different quantities. Define them
      before viewing a contour: mean axial displacement on the end face, and
      unsmoothed element-centre von Mises stress in a fixed middle region.</p>

    <h2 id="model">Choose the physical model</h2>
    <p>Use a straight, 1000 mm long bar with a 100 mm square section. Treat it
      as a static, small-strain, homogeneous isotropic elastic solid, with
      Young’s modulus 210000 MPa and Poisson’s ratio 0.3. Fix all translations
      on one end and pull the other with a total axial force of 1000000 N.
      The remaining faces are traction-free. Ignore gravity, inertia,
      plasticity and thermal effects.</p>
    <p>The numbers use N, mm and MPa. The
      <a href="/theory/foundations/model-and-units/">model introduction</a>
      explains assumptions; the <a href="/theory/foundations/consistent-units/">unit reference</a>
      explains how coherent systems differ. KoFEM does not convert an inconsistent set of inputs.</p>

    <h2 id="equations">Connect displacement to equilibrium</h2>
    <p><a href="/theory/notation/#displacement">Displacement ${tex("\\mathbf{u}")}</a>
      gives <a href="/theory/notation/#strain">small strain ${tex("\\mathbf{ε}")}</a>
      through the symmetric gradient. The isotropic law gives
      <a href="/theory/notation/#stress">stress ${tex("\\mathbf{σ}")}</a>:</p>
    ${equation("\\mathbf{ε} = \\frac{1}{2}(∇\\mathbf{u} + (∇\\mathbf{u})^T), \\quad \\mathbf{σ} = λ\\mathrm{tr}(\\mathbf{ε})\\mathbf{I} + 2μ\\mathbf{ε}.", "Small strain is the symmetric displacement gradient; isotropic stress is lambda times strain trace times identity plus twice mu times strain")}
    <p>The <a href="/theory/notation/#lame-parameters">Lamé constants ${tex("λ, μ")}</a>
      follow from the modulus and Poisson’s ratio; ${tex("\\mathbf{I}")} is the
      identity tensor. Strain is dimensionless and stress is in MPa.
      <a href="/theory/operators/gradient-divergence/">Gradient and divergence</a>
      explains the derivatives; <a href="/theory/operators/tensor-products/">tensor products</a>
      explains the trace and contractions.</p>
    <p>Static equilibrium requires ${tex("∇\\cdot\\mathbf{σ} = 0")} here,
      since there is no body force. A fixed end prescribes displacement; the
      loaded end prescribes traction. Multiplying equilibrium by a test
      displacement and <a href="/theory/operators/integration-by-parts/#weak-form">integrating by parts</a>
      gives the weak form: internal virtual work equals applied virtual work.
      <a href="/theory/solid-mechanics/linear-elasticity/">Linear elasticity</a> and
      <a href="/theory/solid-mechanics/equilibrium-and-weak-form/">Equilibrium and weak form</a>
      develop both steps in full.</p>

    <h2 id="discretization">Build and solve a discrete study</h2>
    <p>Split the volume into hexahedra and approximate displacement with
      continuous shape functions. The <a href="/theory/operators/reference-mapping/">reference mapping</a>
      transfers derivatives and integrals to each physical element.
      <a href="/theory/numerical-methods/elements-and-quadrature/">Elements and quadrature</a>
      explains the approximation; <a href="/theory/numerical-methods/assembly/">assembly</a>
      adds element stiffnesses into the global matrix.</p>
    <p>The <a href="/theory/numerical-methods/loads-and-constraints/">load and constraint rules</a>
      integrate a uniform end traction into work-equivalent nodal forces and
      eliminate prescribed translations. The <a href="/theory/numerical-methods/linear-solve/">linear solver</a>
      then computes displacement coefficients. Its residual tests the discrete
      equations; it does not measure the physical prediction error.</p>

    <h2 id="results">Check the answer</h2>
    <p>For uniform one-dimensional tension, the extension is
      ${tex("δ = PL/(EA)")} and axial stress is ${tex("σ_{xx} = P/A")}, where
      ${tex("P")} is total force, ${tex("L")} length, ${tex("E")} Young’s modulus
      and ${tex("A")} section area. These give approximately 0.476190 mm and
      100 MPa. The fully fixed 3D end suppresses Poisson contraction, so its
      extension need not equal the one-dimensional answer exactly.</p>
    <p><a href="/theory/results/displacement-and-stress/">Displacement and stress</a>
      distinguishes solver samples from displayed averages.
      <a href="/theory/results/interpretation-and-convergence/">Interpretation and convergence</a>
      explains what to compare. The
      <a href="/theory/verification/axial-bar/#comparison">measured refinement table</a>
      checks both quantities and explains the remaining discrepancy.</p>

    <h2 id="reading-path">Follow the connected guide</h2>
    <p>Use the links above to follow assumptions → equations → boundary
      conditions → discretization → solve → interpretation → verification.
      Open the <a href="/examples/axial-bar/">public axial-bar example</a> to
      inspect or solve it yourself. The <a href="/theory/verification/strategy/">verification strategy</a>
      explains which claims this evidence supports and when another benchmark
      or a physical experiment is needed.</p>`,
};
