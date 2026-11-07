// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { equation, tex } from "../operators/math.mjs";
import { source, mfemSource } from "./sources.mjs";
import { figure } from "../figures/index.mjs";

export default {
  slug: "solid-mechanics/equilibrium-and-weak-form",
  description:
    "Static equilibrium and displacement and traction boundary conditions for a linear-elastic solid, the derivation of its weak form, the bilinear and linear forms KoFEM assembles, a two-material bar check, and why the displacement formulation was chosen.",
  sections: [
    ["equilibrium", "Equilibrium inside the body"],
    ["boundary-conditions", "Boundary conditions and signs"],
    ["strong-form", "The complete boundary-value problem"],
    ["why-weak", "Why not solve equilibrium pointwise?"],
    ["derivation", "Derive the weak form"],
    ["forms", "Bilinear and linear forms"],
    ["energy", "Uniqueness and minimum potential energy"],
    ["bar-check", "Worked check: a two-material bar"],
    ["implementation", "KoFEM implementation"],
    ["decision", "Decision: a displacement formulation"],
    ["limitations", "Limitations and practical consequences"],
    ["references", "Sources and further reading"],
  ],
  body: `
    <p class="lede">Why does KoFEM solve the weak form instead of pointwise equilibrium?</p>
    <p><a href="/theory/solid-mechanics/linear-elasticity/">Linear elasticity</a>
      links displacement, strain and stress. Two ingredients remain: force
      balance, and the conditions on the body’s surface. Together they form a
      boundary-value problem. This page states it, then rewrites it as the
      weak form that the finite element method discretises. The same static,
      small-strain, isotropic assumptions apply. Units are N, mm and MPa.</p>

    <h2 id="equilibrium">Equilibrium inside the body</h2>
    <p>Take any piece ${tex("V")} of the body, with boundary ${tex("∂V")} and outward normal
      <a href="/theory/notation/#normal">${tex("\\mathbf{n}")}</a>. In a static state, the
      <a href="/theory/notation/#traction">tractions</a> on its surface and the
      <a href="/theory/notation/#body-force">body force</a> ${tex("\\mathbf{b}")} (N/mm³) inside it must add to zero:</p>
    ${equation("\\int_{∂V} \\mathbf{σ}\\mathbf{n}\\,dS + \\int_V \\mathbf{b}\\,dV = \\mathbf{0}.", "Force balance on any piece of the body: surface traction integrated over its boundary plus body force integrated over its volume equals zero")}
    <p>The <a href="/theory/operators/integration-by-parts/#divergence-theorem">divergence theorem</a>
      turns the surface integral into ${tex("\\int_V ∇\\cdot\\mathbf{σ}\\,dV")}. Because the balance holds for
      every piece, however small, the integrand itself must vanish wherever
      the stress is smooth:</p>
    ${equation("∇\\cdot\\mathbf{σ} + \\mathbf{b} = \\mathbf{0} \\text{ in } Ω, \\quad \\frac{∂σ_{ij}}{∂x_j} + b_i = 0.", "Pointwise equilibrium: the divergence of stress plus body force is zero in the domain; in components, the derivative of sigma i j with respect to x j plus b i is zero")}
    <p>Each of the three equations has units MPa/mm = N/mm³. The
      <a href="/theory/operators/gradient-divergence/#stress-divergence">stress divergence</a>
      takes the divergence of each row of ${tex("\\mathbf{σ}")}. Balance of moments adds the
      symmetry ${tex("σ_{ij} = σ_{ji}")} already used on the previous page.</p>

    <h2 id="boundary-conditions">Boundary conditions and signs</h2>
    <p>Equilibrium alone has infinitely many solutions; the surface fixes
      which one applies. At every boundary point and in each direction, exactly
      one of two quantities is prescribed. The
      <a href="/theory/notation/#boundary">boundary</a> ${tex("Γ")} splits accordingly:</p>
    ${equation("\\mathbf{u} = \\mathbf{u}_D \\text{ on } Γ_D, \\quad \\mathbf{σ}\\mathbf{n} = \\mathbf{t} \\text{ on } Γ_N.", "Displacement u equals the prescribed u D on the Dirichlet boundary; stress times normal equals the prescribed traction t on the Neumann boundary")}
    <ul>
      <li><strong>Displacement (Dirichlet, essential)</strong> on ${tex("Γ_D")}: a fixed support is
        ${tex("\\mathbf{u}_D = \\mathbf{0}")}; a prescribed displacement is a nonzero ${tex("\\mathbf{u}_D")} in mm.</li>
      <li><strong>Traction (Neumann, natural)</strong> on ${tex("Γ_N")}: ${tex("\\mathbf{t}")} in MPa.
        A free surface is ${tex("\\mathbf{t} = \\mathbf{0}")}; it is the default wherever nothing is applied.</li>
      <li><strong>Mixed by component:</strong> a frictionless roller on a face with normal ${tex("z")}
        prescribes ${tex("u_z = 0")} and zero traction in ${tex("x")} and ${tex("y")}.</li>
    </ul>
    <p>The sign follows the outward normal. A positive ${tex("t_x")} on a face whose outward
      normal is ${tex("+x")} pulls the body outward. A
      <a href="/theory/notation/#pressure">pressure</a> ${tex("p_{\\mathrm{load}}")} is positive when it
      pushes into the surface, so ${tex("\\mathbf{t} = -p_{\\mathrm{load}}\\mathbf{n}")}. A total
      face force ${tex("\\mathbf{F}")} becomes the uniform traction ${tex("\\mathbf{F}/A")} over the
      face area ${tex("A")}; <a href="/theory/numerical-methods/loads-and-constraints/#force-to-traction">Loads and constraints</a>
      works through that conversion.</p>
    ${figure("boundary-value-problem", "A body Ω with a prescribed displacement on Γ<sub>D</sub>, a traction t on Γ<sub>N</sub>, a body force b and the outward normal n. Every boundary point belongs to Γ<sub>D</sub> or Γ<sub>N</sub> for each displacement component.")}

    <h2 id="strong-form">The complete boundary-value problem</h2>
    <p>Collecting the pieces gives the <em>strong form</em>: find a
      displacement ${tex("\\mathbf{u}")} such that</p>
    ${equation("∇\\cdot\\mathbf{σ}(\\mathbf{u}) + \\mathbf{b} = \\mathbf{0} \\text{ in } Ω, \\quad \\mathbf{u} = \\mathbf{u}_D \\text{ on } Γ_D, \\quad \\mathbf{σ}(\\mathbf{u})\\mathbf{n} = \\mathbf{t} \\text{ on } Γ_N,", "Strong form: divergence of stress of u plus body force is zero in the domain, u equals u D on the Dirichlet boundary, stress times normal equals t on the Neumann boundary")}
    <p>where ${tex("\\mathbf{σ}(\\mathbf{u}) = λ(∇\\cdot\\mathbf{u})\\mathbf{I} + 2μ\\mathbf{ε}(\\mathbf{u})")} is the
      isotropic law applied to the strain of ${tex("\\mathbf{u}")}. Substituting it shows the
      cost: equilibrium contains <em>second</em> derivatives of displacement.</p>
    <p>The uniform bar of the previous page satisfies every line. Its stress is
      constant, so ${tex("∇\\cdot\\mathbf{σ} = \\mathbf{0}")}. On the loaded end ${tex("\\mathbf{n} = (1, 0, 0)")}
      and ${tex("\\mathbf{σ}\\mathbf{n} = (100, 0, 0)")} MPa, the applied ${tex("P/A")}. The sides have
      ${tex("σ_{yy} = σ_{zz} = 0")}, so they are traction-free. Only a fully clamped end breaks
      this: it forbids the lateral contraction the uniform solution needs,
      so near that end the true 3D field is not uniform.</p>

    <h2 id="why-weak">Why not solve equilibrium pointwise?</h2>
    <p>The finite element method approximates ${tex("\\mathbf{u}")} with
      <a href="/theory/numerical-methods/elements-and-quadrature/#shape-functions">shape functions</a>
      that are continuous across elements but whose slopes jump at shared
      faces. Such a field has no second derivative there, so the strong form
      cannot even be evaluated. Real models have the same difficulty:</p>
    <ul>
      <li>where two bodies with different materials meet, strain, and hence
        some stress components, jump; only the traction ${tex("\\mathbf{σ}\\mathbf{n}")} across the interface is continuous;</li>
      <li>at re-entrant corners and under concentrated loads, stress is unbounded; and</li>
      <li>traction boundary conditions would have to be imposed as separate
        equations on derivatives at surface points.</li>
    </ul>
    <p>The weak form avoids all three. It needs only first derivatives, it
      handles material interfaces without extra conditions, and traction
      conditions enter automatically as work terms. When the solution is
      smooth, it is equivalent to the strong form.</p>

    <h2 id="derivation">Derive the weak form</h2>
    <p>Choose a <a href="/theory/notation/#test-function">test displacement</a> ${tex("\\mathbf{w}")} (mm):
      any sufficiently regular field that is zero on ${tex("Γ_D")}. Think of it as a
      virtual displacement compatible with the supports. Take the
      <a href="/theory/notation/#dot-product">dot product</a> of equilibrium with ${tex("\\mathbf{w}")} and
      integrate over the body:</p>
    ${equation("\\int_Ω \\mathbf{w}\\cdot(∇\\cdot\\mathbf{σ})\\,dV + \\int_Ω \\mathbf{w}\\cdot\\mathbf{b}\\,dV = 0.", "Step 1: the integral of w dotted with stress divergence plus the integral of w dotted with body force is zero")}
    <p><a href="/theory/operators/integration-by-parts/#integration-by-parts">Integration by parts</a>
      moves the derivative from ${tex("\\mathbf{σ}")} to ${tex("\\mathbf{w}")} and produces a boundary term:</p>
    ${equation("\\int_Ω \\mathbf{w}\\cdot(∇\\cdot\\mathbf{σ})\\,dV = \\int_Γ \\mathbf{w}\\cdot(\\mathbf{σ}\\mathbf{n})\\,dS - \\int_Ω ∇\\mathbf{w}:\\mathbf{σ}\\,dV.", "Step 2: integration by parts turns the stress-divergence term into boundary work minus the volume integral of the gradient of w contracted with stress")}
    <p>Now apply the boundary conditions. On ${tex("Γ_D")} the test displacement is zero,
      so that part of the boundary integral drops out. On ${tex("Γ_N")} replace ${tex("\\mathbf{σ}\\mathbf{n}")}
      by the prescribed ${tex("\\mathbf{t}")}. Because ${tex("\\mathbf{σ}")} is symmetric,
      ${tex("∇\\mathbf{w}:\\mathbf{σ} = \\mathbf{ε}(\\mathbf{w}):\\mathbf{σ}")}. The result is the
      principle of virtual work:</p>
    ${equation("\\int_Ω \\mathbf{ε}(\\mathbf{w}):\\mathbf{σ}(\\mathbf{u})\\,dV = \\int_Ω \\mathbf{w}\\cdot\\mathbf{b}\\,dV + \\int_{Γ_N} \\mathbf{w}\\cdot\\mathbf{t}\\,dS.", "Principle of virtual work: internal virtual work, strain of w contracted with stress of u, equals body-force work plus traction work on the Neumann boundary")}
    <p>Every term is work, in N·mm. The traction condition no longer appears as
      a separate equation; it is satisfied <em>naturally</em> by any solution, hence the name.
      The displacement condition is not in the equation at all; it is
      <em>essential</em> and must be built into the space of trial
      displacements. A zero test field on ${tex("Γ_D")} does not make ${tex("\\mathbf{u}_D")} zero.</p>

    <h2 id="forms">Bilinear and linear forms</h2>
    <p>Writing the two sides as separate functions gives the standard
      abstract statement. Define the trial set and the test space</p>
    ${equation("U = \\{\\mathbf{u} : \\mathbf{u} = \\mathbf{u}_D \\text{ on } Γ_D\\}, \\quad W_0 = \\{\\mathbf{w} : \\mathbf{w} = \\mathbf{0} \\text{ on } Γ_D\\},", "The trial set U contains displacements equal to u D on the Dirichlet boundary; the test space W zero contains fields that vanish there")}
    <p>both restricted to fields with finite strain energy (first derivatives
      that are square-integrable). Then find ${tex("\\mathbf{u} ∈ U")} with</p>
    ${equation("a(\\mathbf{u}, \\mathbf{w}) = ℓ(\\mathbf{w}) \\quad \\text{for all } \\mathbf{w} ∈ W_0,", "Weak form: the bilinear form a of u and w equals the linear form ell of w for every test function w in W zero")}
    ${equation("a(\\mathbf{u}, \\mathbf{w}) = \\int_Ω \\left[λ(∇\\cdot\\mathbf{u})(∇\\cdot\\mathbf{w}) + 2μ\\,\\mathbf{ε}(\\mathbf{u}):\\mathbf{ε}(\\mathbf{w})\\right]dV,", "Bilinear form: the integral of lambda times divergence of u times divergence of w, plus two mu times strain of u contracted with strain of w")}
    ${equation("ℓ(\\mathbf{w}) = \\int_Ω \\mathbf{w}\\cdot\\mathbf{b}\\,dV + \\int_{Γ_N} \\mathbf{w}\\cdot\\mathbf{t}\\,dS.", "Linear form: body-force work plus traction work on the Neumann boundary")}
    <p>The bilinear form ${tex("a")} is the isotropic law inserted into internal
      virtual work, using ${tex("\\mathrm{tr}\\,\\mathbf{ε}(\\mathbf{u}) = ∇\\cdot\\mathbf{u}")}. It is linear in each argument and symmetric:
      ${tex("a(\\mathbf{u}, \\mathbf{w}) = a(\\mathbf{w}, \\mathbf{u})")}. The linear form ${tex("ℓ")} collects the loads.
      Replacing ${tex("\\mathbf{u}")} and ${tex("\\mathbf{w}")} by shape-function expansions turns
      ${tex("a")} into the <a href="/theory/numerical-methods/elements-and-quadrature/#element-stiffness">stiffness matrix</a>
      ${tex("\\mathbf{K}")} and ${tex("ℓ")} into the load vector ${tex("\\mathbf{f}")}.
      A concentrated force ${tex("\\mathbf{P}")} applied at a node adds ${tex("\\mathbf{P}\\cdot\\mathbf{w}")}
      at that node. It is admissible only after discretisation: in the continuous
      problem a point force produces infinite displacement beneath it.</p>

    <h2 id="energy">Uniqueness and minimum potential energy</h2>
    <p>Setting ${tex("\\mathbf{w} = \\mathbf{u}")} shows ${tex("a(\\mathbf{u}, \\mathbf{u}) = 2\\int_Ω W\\,dV")}, twice the
      <a href="/theory/solid-mechanics/linear-elasticity/#strain-energy">strain energy</a>.
      It is zero only for rigid-body motions: three translations and three rotations.
      If the displacement conditions exclude those motions, ${tex("a(\\mathbf{w}, \\mathbf{w}) > 0")} for
      every nonzero admissible ${tex("\\mathbf{w}")}. Korn’s inequality turns this into
      a lower bound, and the weak form then has exactly one solution. Without
      enough supports, the discrete matrix is singular;
      <a href="/theory/numerical-methods/loads-and-constraints/#rigid-body-modes">Rigid-body modes</a>
      shows what happens.</p>
    <p>Because ${tex("a")} is symmetric and positive, the weak form is also the
      condition for the minimum of the total potential energy</p>
    ${equation("Π(\\mathbf{u}) = \\frac{1}{2}a(\\mathbf{u}, \\mathbf{u}) - ℓ(\\mathbf{u}).", "Total potential energy: one half of a of u with u, minus ell of u")}
    <p>Of all displacements that satisfy the supports, the elastic solution has
      the least stored energy minus load work. This explains why the discrete
      stiffness matrix is symmetric positive definite and why the
      <a href="/theory/numerical-methods/linear-solve/">conjugate gradient method</a> applies.</p>

    <h2 id="bar-check">Worked check: a two-material bar</h2>
    <p>A one-dimensional bar shows the weak form at work, including a
      material interface. It is 1000 mm long with section ${tex("A = 10^4")} mm²:
      steel (${tex("E_1 = 210000")} MPa) for ${tex("0 ≤ x ≤ 500")} mm, aluminium
      (${tex("E_2 = 70000")} MPa) for ${tex("500 ≤ x ≤ 1000")} mm. The left end is fixed,
      ${tex("u(0) = 0")}; the right end carries ${tex("P = 10^6")} N. There is no body force.
      In one dimension the weak form reads:</p>
    ${equation("\\int_0^L E A\\,u'w'\\,dx = P\\,w(L) \\quad \\text{for all } w \\text{ with } w(0) = 0.", "One-dimensional weak form: the integral of E A times u prime times w prime equals P times w at the loaded end, for every w that is zero at the support")}
    <p>Try a displacement with constant force ${tex("N = EAu'")} in each segment, so
      ${tex("u' = N/(E_1A)")} or ${tex("N/(E_2A)")}. Then the left side is
      ${tex("\\int_0^L N w'\\,dx = N[w(L) - w(0)] = N\\,w(L)")}. The equation holds for every
      admissible ${tex("w")} exactly when ${tex("N = P")}. The weak form imposed the end load
      without any separate boundary equation. It also needed no interface
      condition. The displacement is continuous but has a kink at 500 mm,
      where the strong form has no classical second derivative.</p>
    <div class="table-wrap" tabindex="0" role="region" aria-label="Two-material bar results by segment; scroll horizontally if needed">
      <table>
        <caption>Two-material bar, ${tex("P = 10^6")} N, ${tex("A = 10^4")} mm²</caption>
        <thead><tr><th scope="col">Segment</th><th scope="col">Stress ${tex("σ = P/A")}</th><th scope="col">Strain ${tex("σ/E")}</th><th scope="col">Extension over 500 mm</th></tr></thead>
        <tbody>
          <tr><th scope="row">Steel</th><td>100 MPa</td><td>${tex("1/2100 \\approx 4.762 × 10^{-4}")}</td><td>0.2381 mm</td></tr>
          <tr><th scope="row">Aluminium</th><td>100 MPa</td><td>${tex("1/700 \\approx 1.429 × 10^{-3}")}</td><td>0.7143 mm</td></tr>
        </tbody>
      </table>
    </div>
    <p>The stress is continuous; the strain jumps by a factor of three. The tip
      displacement is ${tex("500/2100 + 500/700 = 20/21 \\approx 0.9524")} mm. Units check:
      ${tex("EA")} is N, ${tex("u'w'")} is 1, ${tex("dx")} is mm, so both sides are N·mm. Order-1
      elements whose nodes include ${tex("x = 500")} mm reproduce this solution exactly,
      because it is piecewise linear. In 3D, a free lateral surface would also contract
      differently in each material near the interface, which this 1D model ignores.</p>

    <h2 id="implementation">KoFEM implementation</h2>
    <p>KoFEM uses MFEM 4.7. The solid solver builds ${tex("a")} and ${tex("ℓ")} directly.</p>
    <ul>
      <li><strong>Bilinear form.</strong> MFEM’s elasticity integrator implements
        exactly ${tex("a(\\mathbf{u}, \\mathbf{w})")} above
        (${mfemSource("fem/bilininteg.hpp", 3009, "MFEM ElasticityIntegrator")}).
        KoFEM passes it piecewise-constant ${tex("λ")} and ${tex("μ")}, one pair per body
        (${source("engine/cpp/solve_mfem.cpp", 227, "solve_mfem.cpp")}). The mixed
        solid–shell solve uses the same integrator for its solid part
        (${source("engine/cpp/solve_coupled.cpp", 72, "solve_coupled.cpp")}).</li>
      <li><strong>Linear form.</strong> Face forces become uniform tractions ${tex("\\mathbf{F}/A")},
        tractions are applied directly, and pressures as ${tex("-p_{\\mathrm{load}}\\mathbf{n}")}
        (${source("engine/cpp/fem_bc_io.cpp", 259, "fem_bc_io.cpp")}). They are integrated
        against the test functions on the selected faces
        (${source("engine/cpp/fem_bc_io.cpp", 340, "fem_bc_io.cpp")}). Nodal forces are added to
        the load vector (${source("engine/cpp/fem_bc_io.cpp", 425, "fem_bc_io.cpp")}).
        There is <strong>no body-force term</strong>: ${tex("\\mathbf{b} = \\mathbf{0}")}, so self-weight is not modelled.</li>
      <li><strong>Essential conditions.</strong> Fixed and prescribed translation
        components are collected
        (${source("engine/cpp/solve_mfem.cpp", 203, "solve_mfem.cpp")}), their values are written
        into the solution, and the constrained equations are eliminated
        (${source("engine/cpp/solve_mfem.cpp", 235, "solve_mfem.cpp")}). This is how ${tex("\\mathbf{u} ∈ U")}
        and ${tex("\\mathbf{w} ∈ W_0")} are enforced.</li>
    </ul>
    <p>The shell path solves a different weak form with rotations; see
      <a href="/theory/shells/formulation/">Shell formulation</a>. The
      <a href="/examples/axial-bar/">axial bar example</a> runs this complete
      solid path in the browser engine.</p>

    <h2 id="decision">Decision: a displacement formulation</h2>
    <ul>
      <li><strong>Choice:</strong> KoFEM solves the weak form for displacement only
        (a primal, or irreducible, Galerkin formulation), with continuous
        shape functions for ${tex("\\mathbf{u}")} and the isotropic law above.</li>
      <li><strong>Alternatives:</strong> collocation or finite differences on the strong
        form; mixed displacement–pressure formulations; stress-based or
        hybrid elements; B-bar and reduced-integration variants; nonlinear
        formulations for large deformation or plasticity.</li>
      <li><strong>Why it fits:</strong> it needs only first derivatives and two material
        constants, imposes tractions and material interfaces naturally, and
        yields a symmetric positive definite system suited to a conjugate
        gradient solve in the browser. MFEM provides it as a standard,
        well-tested integrator.</li>
      <li><strong>Tradeoffs:</strong> stress comes from derivatives of the solution and is
        less accurate than displacement; it is discontinuous between
        elements. Linear tetrahedra can lock in bending and with ${tex("ν")} near ½.</li>
      <li><strong>Revisit when:</strong> nearly incompressible materials, large
        deformation, plasticity or contact become supported features, or when
        stress accuracy in thin sections needs a different element.</li>
    </ul>
    <p>KoFEM’s architecture decision records cover the C++/WASM engine as the
      production pipeline (ADR-0001), not this formulation. It is the standard
      formulation for linear-elastic solid FEM and has no separate record.</p>

    <h2 id="limitations">Limitations and practical consequences</h2>
    <ul>
      <li>The weak form is only as good as the model: it inherits every
        <a href="/theory/solid-mechanics/linear-elasticity/#limitations">linear-elastic limit</a>.</li>
      <li>Point forces and point supports are acceptable only as discrete
        loads. Refining the mesh near them makes local stress grow without bound;
        spread a load over a realistic area.</li>
      <li>A fixed support on a whole face also blocks lateral contraction. It
        adds stiffness and local stress that a real joint may not have.</li>
      <li>Supports that leave a rigid-body motion free make the problem
        unsolvable. Supports that block more than needed change the answer.</li>
      <li>Gravity and other body forces are not available in the current solver.</li>
    </ul>

    <h2 id="references">Sources and further reading</h2>
    <ol class="refs">
      <li>Hughes, <cite>The Finite Element Method: Linear Static and Dynamic
        Finite Element Analysis</cite> (2000), the strong and weak forms of
        elastostatics and their equivalence.</li>
      <li>Bathe, <cite>Finite Element Procedures</cite> (1996), the principle of
        virtual displacements.</li>
      <li>Brenner and Scott, <cite>The Mathematical Theory of Finite Element
        Methods</cite> (3rd ed., 2008), Korn’s inequality and well-posedness of
        linear elasticity.</li>
      <li>Zienkiewicz, Taylor and Zhu, <cite>The Finite Element Method: Its Basis
        and Fundamentals</cite> (7th ed., 2013), minimum potential energy and
        mixed formulations for incompressibility.</li>
      <li><a href="https://mfem.org/bilininteg/">MFEM: Bilinear form integrators</a>,
        the elasticity integrator.</li>
    </ol>
    <p>The worked check uses exact rational arithmetic. Related pages:
      <a href="/theory/operators/integration-by-parts/">Integration and the weak form</a>,
      <a href="/theory/numerical-methods/elements-and-quadrature/">Elements and quadrature</a>
      and <a href="/theory/numerical-methods/loads-and-constraints/">Loads and constraints</a>.</p>`,
};
