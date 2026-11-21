// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { equation, matrixEquation, tex } from "../operators/math.mjs";
import { codeSource } from "./sources.mjs";
import { figure } from "../figures/index.mjs";

export default {
  slug: "numerical-methods/linear-solve",
  description:
    "How conjugate gradients with multigrid or Gauss–Seidel preconditioning solves the constrained solid system, what KoFEM's residual and tolerance measure, and how conditioning, rigid modes and iteration limits affect convergence.",
  sections: [
    ["system", "The system after constraints"],
    ["method", "Conjugate gradients and preconditioning"],
    ["residual", "Which residual does the solver measure?"],
    ["stopping", "Tolerances and stopping"],
    ["worked-example", "Worked example: two free bar DOFs"],
    ["conditioning", "Conditioning, scaling and rigid modes"],
    ["failure", "Iteration budgets and failure"],
    ["accuracy", "Three different accuracy questions"],
    ["implementation", "KoFEM implementation"],
    ["decision", "Why KoFEM uses this method"],
    ["references", "Sources and further reading"],
  ],
  body: `
    <p class="lede">How is the linear system solved, and what do tolerance and non-convergence mean?</p>
    <p>An iterative solver improves a displacement estimate until an algebraic
      imbalance is small enough. That establishes how closely it solves the
      assembled equations. Mesh refinement and comparison with physical evidence
      answer separate questions. This page covers static, small-strain,
      isotropic linear-elastic solids; the implementation details refer to
      KoFEM’s ordinary solid solve. Shell, coupled and optimization solvers have
      their own settings.</p>

    <h2 id="system">The system after constraints</h2>
    <p><a href="/theory/numerical-methods/assembly/">Assembly</a> collects the
      element equations. <a href="/theory/numerical-methods/loads-and-constraints/#elimination">Displacement constraints</a>
      then move known values to the right-hand side. Write the resulting system as:</p>
    ${equation("\\mathbf{A}\\mathbf{x} = \\mathbf{b}.", "The constrained system matrix A times the displacement coefficient vector x equals the modified load vector b")}
    <p>Here ${tex("\\mathbf{A}")} is the constrained
      <a href="/theory/notation/#stiffness">stiffness matrix</a>,
      ${tex("\\mathbf{x}")} contains the
      <a href="/theory/notation/#discrete-displacement">displacement coefficients</a>,
      and ${tex("\\mathbf{b}")} is the modified
      <a href="/theory/notation/#load-vector">load vector</a>, including prescribed-displacement
      contributions. This local ${tex("\\mathbf{b}")} is a discrete vector, not the
      continuum body-force field. In the N–mm system, their units are N/mm, mm
      and N. KoFEM keeps each constrained row as an identity row that restates
      its prescribed value; the free rows express force balance.</p>

    <h2 id="method">Conjugate gradients and preconditioning</h2>
    <p>Conjugate gradients (CG) uses sparse matrix–vector products and a few
      vectors instead of forming a dense inverse. It chooses successive search
      directions that are orthogonal in the stiffness inner product. In exact
      arithmetic, CG solves a positive-definite system in at most as many steps
      as there are unknowns. Rounding and poor conditioning make that bound an
      impractical iteration budget.</p>
    ${figure("cg-convergence", "Conjugate gradients on the plane-elasticity system of a small triangular mesh, clamped at one end and loaded at the other. Symmetric Gauss–Seidel preconditioning, one of KoFEM’s two choices, reaches a 10<sup>−6</sup> relative tolerance in far fewer iterations. Computed for this figure; the plotted residual is the preconditioned norm relative to its initial value.")}
    <p>CG assumes a <strong>symmetric positive-definite</strong> matrix:
      ${tex("\\mathbf{v}^{T}\\mathbf{A}\\mathbf{v} > 0")} for every nonzero vector ${tex("\\mathbf{v}")}.
      For elastic solids this means every admissible nonzero deformation costs
      positive strain energy. It requires stable material properties, valid
      elements and enough constraints on every connected part to remove rigid
      motions. Merely adding one support does not establish these conditions.</p>
    <p>A <strong>preconditioner</strong> cheaply approximates the inverse action
      of ${tex("\\mathbf{A}")}. Call its matrix ${tex("\\mathbf{M}")}; applying it means
      solving approximately with ${tex("\\mathbf{M}")}, not explicitly inverting it.
      Preconditioned CG also requires a fixed, symmetric positive-definite
      preconditioner. The Solve panel offers two:</p>
    <ul>
      <li><strong>AMG multigrid</strong> (the default): smoothed-aggregation
        algebraic multigrid. It groups neighbouring nodes into aggregates,
        builds coarser versions of the system that still contain the six
        rigid-body motions, and applies one V-cycle per CG step, with a
        forward Gauss–Seidel sweep before and a backward sweep after each
        coarse correction. The coarsest level is solved directly when it
        is small enough.</li>
      <li><strong>Gauss–Seidel</strong>: one symmetric Gauss–Seidel sweep,
        a forward and a backward pass, per application. These local sweeps
        reduce error cheaply but remove long-range, slowly varying errors
        poorly, so they need many more iterations on large or thin-walled
        models.</li>
    </ul>

    <h2 id="residual">Which residual does the solver measure?</h2>
    <p id="algebraic-residual">At iteration ${tex("k")}, the estimate ${tex("\\mathbf{x}_k")}
      has algebraic residual ${tex("\\mathbf{r}_k")}:</p>
    ${equation("\\mathbf{r}_k = \\mathbf{b} - \\mathbf{A}\\mathbf{x}_k.", "The residual is the modified load vector minus the constrained stiffness matrix times the current displacement estimate")}
    <p>On free solid rows this is the remaining nodal force imbalance, in N.
      Constrained rows enforce prescribed values; their residual is not a
      support reaction. KoFEM measures the Euclidean norm of the residual
      relative to the load:</p>
    ${equation("ρ_k = \\frac{|\\mathbf{r}_k|_2}{|\\mathbf{b}|_2}.", "The relative residual rho is the Euclidean norm of the residual divided by the Euclidean norm of the modified load vector")}
    <p>The solve log calls ${tex("ρ_k")} the force residual. It is
      dimensionless and means the same accuracy whichever preconditioner is
      chosen. It is the ratio of two vector norms, not the largest nodal
      force imbalance. Constrained rows, which hold prescribed values, enter
      both norms; for fixed supports they are zero. CG updates the residual
      recursively during the iteration; the solve does not independently
      recompute the final force imbalance or estimate a condition number.</p>

    <h2 id="stopping">Tolerances and stopping</h2>
    <p>The relative tolerance ${tex("τ_{\\mathrm{rel}}")} asks for a reduction of
      the residual relative to the load. KoFEM tests the squared quantities
      after every step:</p>
    ${equation("|\\mathbf{r}_k|_2^2 ≤ τ_{\\mathrm{rel}}^2 |\\mathbf{b}|_2^2.", "Stop when the squared residual norm is no greater than the relative tolerance squared times the squared load norm")}
    <p>A relative tolerance of ${tex("10^{-6}")} asks for a residual a million
      times smaller than the load, or a factor of ${tex("10^{-12}")} in the
      squared test. It does not promise six correct digits of displacement or
      stress. There is no absolute tolerance.</p>
    <div class="table-wrap" tabindex="0" role="region" aria-label="Solid solver settings and user controls; scroll horizontally if needed">
      <table>
        <caption>Ordinary solid solve in KoFEM</caption>
        <thead><tr><th scope="col">Setting</th><th scope="col">Value</th><th scope="col">Control</th></tr></thead>
        <tbody>
          <tr><th scope="row">Preconditioner</th><td>AMG multigrid or Gauss–Seidel</td><td>“Solver” on the Solve panel; AMG is the default</td></tr>
          <tr><th scope="row">Relative tolerance</th><td><code>1e-6</code></td><td>Fixed internally</td></tr>
          <tr><th scope="row">Stopping measure</th><td>${tex("|\\mathbf{r}_k|_2/|\\mathbf{b}|_2")}</td><td>Fixed internally</td></tr>
          <tr><th scope="row">Initial budget</th><td>5000 iterations</td><td>Internal default; callers can supply <code>cgIterationLimit</code>, not an ordinary solver-settings input</td></tr>
          <tr><th scope="row">Additional budget</th><td>1–1 000 000 per continuation</td><td>User enters “Extra iterations” in “Keep solving?”</td></tr>
        </tbody>
      </table>
    </div>
    <p>The app exposes the preconditioner and continuation, not a solid
      tolerance control. Optimization tolerance inputs belong to another
      solver path. With no load and nothing prescribed,
      ${tex("\\mathbf{b} = \\mathbf{0}")}: the solution is exactly zero and the
      solve accepts it before the first step.</p>

    <h2 id="worked-example">Worked example: two free bar DOFs</h2>
    <p>Take two axial bar elements of stiffness 1 N/mm each. Fix the left node
      and apply 1 N to each of the other two nodes. Their free displacements are
      ${tex("x_1")} and ${tex("x_2")}, in mm. The reduced system is:</p>
    ${matrixEquation(
      "\\mathbf{A} =",
      [
        ["2", "-1"],
        ["-1", "1"],
      ],
      "Two-by-two free bar stiffness matrix in newtons per millimetre: two, minus one; minus one, one",
    )}
    <p>${tex("\\mathbf{b} = (1, 1)^{T}\\text{ N}")}. Equilibrium gives
      ${tex("\\mathbf{x} = (2, 3)^{T}\\text{ mm}")}: the first element carries 2 N,
      the second 1 N. Start CG at zero. For the forward/backward Gauss–Seidel
      pair, the inverse action is:</p>
    ${matrixEquation(
      "\\mathbf{M}^{-1} =",
      [
        ["3/4", "1/2"],
        ["1/2", "1"],
      ],
      "Inverse symmetric Gauss–Seidel preconditioner in millimetres per newton: three quarters, one half; one half, one",
    )}
    <p>Initially ${tex("\\mathbf{M}^{-1}\\mathbf{r}_0 = (5/4, 3/2)^{T}\\text{ mm}")}
      and ${tex("\\mathbf{r}_0^{T}\\mathbf{M}^{-1}\\mathbf{r}_0 = 11/4\\text{ N·mm}")}. CG uses this
      preconditioned product for its step lengths; the first is
      ${tex("22/13")}. The stopping test uses the plain residual norm. The
      resulting iterates are:</p>
    <div class="table-wrap" tabindex="0" role="region" aria-label="Two-DOF bar residual and stopping calculation; scroll horizontally if needed">
      <table>
        <caption>Exact arithmetic, symmetric Gauss–Seidel preconditioning</caption>
        <thead><tr><th scope="col">Iteration</th><th scope="col">Displacement (mm)</th><th scope="col">Residual (N)</th><th scope="col">${tex("\\mathbf{r}^{T}\\mathbf{M}^{-1}\\mathbf{r}")} (N·mm)</th><th scope="col">Relative residual</th></tr></thead>
        <tbody>
          <tr><th scope="row">0</th><td>${tex("(0, 0)")}</td><td>${tex("(1, 1)")}</td><td>${tex("11/4")}</td><td>1</td></tr>
          <tr><th scope="row">1</th><td>${tex("(55/26, 33/13)")}</td><td>${tex("(-9/13, 15/26)")}</td><td>${tex("99/338")}</td><td>0.637232</td></tr>
          <tr><th scope="row">2</th><td>${tex("(2, 3)")}</td><td>${tex("(0, 0)")}</td><td>0</td><td>0</td></tr>
        </tbody>
      </table>
    </div>
    <p>At iteration 1, ${tex("|\\mathbf{r}_1|_2^2 = 549/676\\text{ N}^2")} and
      ${tex("|\\mathbf{b}|_2^2 = 2\\text{ N}^2")}, so
      ${tex("ρ_1 = \\sqrt{549/1352} \\approx 0.637232")}. The current
      ${tex("10^{-6}")} target requires the second step, and a one-step
      budget fails to converge. For illustration, a looser relative tolerance
      of 0.7 would accept step 1; that tolerance is not an app setting. The
      linked calculation below reproduces the steps in floating point, where
      roundoff can leave a small nonzero final residual.</p>

    <h2 id="conditioning">Conditioning, scaling and rigid modes</h2>
    <p><strong>Conditioning</strong> describes how strongly a solution responds
      to perturbations. For a symmetric positive-definite matrix, the spectral
      condition number ${tex("κ_2(\\mathbf{A})")} is the largest eigenvalue divided
      by the smallest. Widely separated stiffness scales make this ratio large.
      CG depends on the spectrum after preconditioning; a good preconditioner
      clusters those scales.</p>
    <p>Residual size alone cannot bound displacement error without information
      about the inverse stiffness. Let ${tex("\\mathbf{x}")} denote the exact
      solution of these discrete equations and ${tex("\\mathbf{e}_k = \\mathbf{x} - \\mathbf{x}_k")}
      the algebraic error. Then ${tex("\\mathbf{A}\\mathbf{e}_k = \\mathbf{r}_k")}. For nonzero
      load and solution, ordinary Euclidean norms satisfy:</p>
    ${equation("\\frac{|\\mathbf{e}_k|_2}{|\\mathbf{x}|_2} ≤ κ_2(\\mathbf{A}) \\frac{|\\mathbf{r}_k|_2}{|\\mathbf{b}|_2}.", "Relative displacement error in the Euclidean norm is bounded by the condition number times the Euclidean residual divided by the load norm")}
    <p>The right-hand factor is the reported ${tex("ρ_k")}, but the condition
      number of a real stiffness matrix is large and unknown, so the bound
      gives no useful error estimate. In practice:</p>
    <ul>
      <li><strong>Rigid modes:</strong> missing supports or disconnected bodies
        make the matrix singular. Even a zero residual cannot establish
        uniqueness: two free nodes joined by a spring with balanced loads have
        the same residual after any common translation. See
        <a href="/theory/numerical-methods/loads-and-constraints/#rigid-body-modes">Rigid-body modes</a>.</li>
      <li><strong>Near mechanisms and constraints:</strong> a weak connection
        or poorly placed supports leave a very soft motion. Extra constraints
        can remove it but also change the physical problem and make the answer
        too stiff. Support placement is a modelling choice.</li>
      <li><strong>Material contrast:</strong> very stiff and very soft regions
        create separated scales. Poisson’s ratio near 0.5 makes the volumetric
        stiffness large and can also cause displacement-element locking; a
        tighter solve does not remove that discretisation error.</li>
      <li><strong>Mesh quality and size:</strong> distorted elements, small
        features and large size transitions can worsen conditioning. Refining
        adds unknowns and can increase the iteration count. Correct poor
        elements first; refinement alone is not a solver repair.</li>
      <li><strong>Scaling:</strong> consistent units and suitable variable
        scaling keep magnitudes manageable. Coherent unit conversion preserves
        the physical solution; changing only the modulus or coordinates changes
        the model. Multiplying a matrix by one scalar does not change its
        condition number. KoFEM’s solid solve adds no separate equilibration
        step beyond preconditioning.</li>
    </ul>

    <h2 id="failure">Iteration budgets and failure</h2>
    <p>A budget limits work; it is not a convergence criterion. At the initial
      5000-step solid budget, KoFEM can pause at <strong>Keep solving?</strong>
      when a recent residual window shows progress. The policy checks both
      window endpoints and the geometric means of its two halves; it tolerates
      oscillations but requires improvement beyond roundoff. The window is
      half the initial budget, at most 100 iterations. This heuristic predicts
      neither eventual convergence nor the validity of the model.</p>
    <p><strong>Continue</strong> adds the requested number of iterations to the
      live loop. It preserves the iterate, residual, search direction,
      preconditioner and original convergence target. The prompt may recur.
      <strong>Stop</strong>, including Escape, raises an explicit error and
      discards the partial result. When the residual no longer falls, the
      budget ends the solve with an error.</p>
    <p>That error reports the relative residual, iteration count and
      <code>target 1e-6</code>, with “The partial result was discarded”.
      Two other errors stop a solve early and say the model is probably not
      fully constrained: a multigrid setup whose coarsest system is singular,
      and a CG breakdown, where a search direction meets zero or negative
      stiffness. A non-convergence message alone does not diagnose
      singularity; a constrained but poorly conditioned model can also fail.</p>
    <p>Check body connectivity and supports first, then material values and
      <a href="/theory/foundations/consistent-units/">units</a>, element quality
      and stiffness contrasts. Inspect the displacement pattern and residual
      history if available. A falling residual may justify more iterations;
      a plateau calls for investigating conditioning. Although the current
      error suggests refining the mesh, refinement can make convergence harder.</p>

    <h2 id="accuracy">Three different accuracy questions</h2>
    <div class="table-wrap" tabindex="0" role="region" aria-label="Linear solver convergence versus mesh convergence and physical accuracy; scroll horizontally if needed">
      <table>
        <caption>What each check establishes</caption>
        <thead><tr><th scope="col">Question</th><th scope="col">Evidence</th><th scope="col">Remaining uncertainty</th></tr></thead>
        <tbody>
          <tr><th scope="row">Linear-solver convergence</th><td>Residual meets the algebraic stopping test for one assembled system</td><td>Displacement error depends on conditioning; mesh and model errors remain</td></tr>
          <tr><th scope="row">Mesh convergence</th><td>A chosen quantity stabilizes under suitable refinement or higher order, with adequate linear solves</td><td>Singular peak stress may never stabilize; modelling assumptions remain</td></tr>
          <tr><th scope="row">Physical model accuracy</th><td>Suitable assumptions, loads, supports and materials; comparison with analysis, experiments or trusted references</td><td>Small strain and linear elasticity may fail even on a fine mesh with a tiny residual</td></tr>
        </tbody>
      </table>
    </div>
    <p>Judge the displacement or stress quantity needed for the engineering
      decision. The <a href="/examples/axial-bar/">axial-bar benchmark</a> checks
      extension against a known solution. A single passing benchmark does not
      validate all meshes or boundary conditions. The
      <a href="/theory/results/interpretation-and-convergence/">result interpretation chapter</a>
      develops these checks further.</p>

    <h2 id="implementation">KoFEM implementation</h2>
    <p>KoFEM’s solid solve runs in its Rust finite-element module.</p>
    <ul>
      <li>${codeSource("crates/kofem-fem/src/static_solve.rs", 104, "prepare_static")}
        eliminates the constraints and builds the chosen preconditioner;
        ${codeSource("crates/kofem-fem/src/amg.rs", 4, "the multigrid")} and
        ${codeSource("crates/kofem-fem/src/amg.rs", 87, "the Gauss–Seidel sweep")}
        apply them.</li>
      <li>${codeSource("crates/kofem-fem/src/cg.rs", 129, "Preconditioned CG")}
        runs in resumable steps and tests the
        ${codeSource("crates/kofem-fem/src/cg.rs", 26, "residual-norm stopping rule")}.
        ${codeSource("web/src/lib/solve/amg.ts", 184, "amg.ts")} sets the tolerance
        and the default budget.</li>
      <li>${codeSource("web/src/lib/solve/cgRun.ts", 42, "iterateToConvergence")}
        logs progress every ten iterations and owns the budgets; the
        ${codeSource("crates/kofem-fem/src/cg.rs", 218, "progress policy")}
        decides whether to offer more.
        ${codeSource("web/src/workers/solver.worker.ts", 90, "The worker")}
        and ${codeSource("web/src/components/CgContinuationDialog.tsx", 48, "continuation dialog")}
        connect it to the app. The worker
        ${codeSource("web/src/workers/solver.worker.ts", 1131, "returns errors to the caller")}
        rather than returning a partial field.</li>
    </ul>
    <p>The worked example above was checked independently of the
      production solver; it illustrates the equations, not KoFEM’s code path.
      KoFEM’s automated tests drive the real solid solver through
      successful continuation, Stop and an exhausted iteration budget, and check that a
      continued solve gives the same final field as an uninterrupted one.</p>

    <h2 id="decision">Why KoFEM uses this method</h2>
    <p><strong>Choice and rationale.</strong> Sparse CG suits a constrained,
      positive-definite elastic system and keeps storage and per-step work
      modest in the browser. Smoothed-aggregation multigrid uses the six
      rigid-body motions to correct the long-range errors that local sweeps
      leave, so it needs far fewer iterations on large and thin-walled
      models. Gauss–Seidel remains as the simpler choice. The implementation
      has a fixed accuracy target, checks convergence and lets a progressing
      solve continue without restarting.</p>
    <p><strong>Tradeoff and alternatives.</strong> Multigrid costs a setup
      step and extra memory for its coarse levels, and an under-constrained
      model fails already in that setup. Geometric multigrid and other
      algebraic multigrid variants are alternatives. Sparse direct
      factorization is another general option, with fill-in and memory
      costs; the current solid path does not select it as a fallback.</p>
    <p><strong>Limits.</strong> A correctly constrained but very large or
      poorly conditioned model may still stagnate or need many extensions.
      Continuation cannot repair a rigid mode or make a wrong physical model
      accurate.</p>

    <h2 id="references">Sources and further reading</h2>
    <ol class="refs">
      <li>Vaněk, Mandel and Brezina, “Algebraic multigrid by smoothed
        aggregation for second and fourth order elliptic problems”,
        <cite>Computing</cite> 56 (1996), the multigrid preconditioner.</li>
      <li><a href="https://www.cs.cmu.edu/~quake-papers/painless-conjugate-gradient.pdf">Shewchuk,
        <cite>An Introduction to the Conjugate Gradient Method Without the Agonizing Pain</cite></a>
        (1994), conjugacy, conditioning and preconditioning.</li>
      <li>Saad, <cite>Iterative Methods for Sparse Linear Systems</cite>, second
        edition (2003), preconditioned CG and stopping criteria.</li>
    </ol>`,
};
