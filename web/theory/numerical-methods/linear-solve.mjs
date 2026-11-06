// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { equation, matrixEquation, tex } from "../operators/math.mjs";
import {
  linearSolveRevision as revision,
  linearSolveSource as source,
  mfemSource,
} from "./sources.mjs";

export default {
  slug: "numerical-methods/linear-solve",
  description:
    "How conjugate gradients solves the constrained solid system, what KoFEM's residual and tolerances measure, and how conditioning, rigid modes and iteration limits affect convergence.",
  sections: [
    ["system", "The system after constraints"],
    ["method", "Conjugate gradients and preconditioning"],
    ["residual", "Which residual does the solver measure?"],
    ["stopping", "Tolerances and stopping"],
    ["worked-example", "Worked example: two free bar DOFs"],
    ["conditioning", "Conditioning, scaling and rigid modes"],
    ["failure", "Iteration budgets and failure"],
    ["accuracy", "Three different accuracy questions"],
    ["implementation", "Implementation and reproducible evidence"],
    ["decision", "Decision: the current solid method"],
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
      and N. MFEM retains constrained rows with their diagonal entries; the
      free rows express force balance.</p>

    <h2 id="method">Conjugate gradients and preconditioning</h2>
    <p>Conjugate gradients (CG) uses sparse matrix–vector products and a few
      vectors instead of forming a dense inverse. It chooses successive search
      directions that are orthogonal in the stiffness inner product. In exact
      arithmetic, CG solves a positive-definite system in at most as many steps
      as there are unknowns. Rounding and poor conditioning make that bound an
      impractical iteration budget.</p>
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
      preconditioner. KoFEM uses MFEM’s symmetric Gauss–Seidel: one forward and
      one backward sweep per application. These local sweeps reduce error
      cheaply but can remove long-range, slowly varying errors poorly.</p>

    <h2 id="residual">Which residual does the solver measure?</h2>
    <p id="algebraic-residual">At iteration ${tex("k")}, the estimate ${tex("\\mathbf{x}_k")}
      has algebraic residual ${tex("\\mathbf{r}_k")}:</p>
    ${equation("\\mathbf{r}_k = \\mathbf{b} - \\mathbf{A}\\mathbf{x}_k.", "The residual is the modified load vector minus the constrained stiffness matrix times the current displacement estimate")}
    <p>On free solid rows this is the remaining nodal force imbalance, in N.
      Constrained rows enforce prescribed values; their residual is not a
      support reaction. The scalar in KoFEM’s solid log and continuation dialog
      uses a <strong>preconditioned norm</strong>:</p>
    ${equation("η_k = \\sqrt{\\mathbf{r}_k^{T}\\mathbf{M}^{-1}\\mathbf{r}_k}, \\quad ρ_k = \\frac{η_k}{η_0}.", "Eta is the square root of residual transpose times the preconditioner inverse times the residual; the reported relative residual rho is eta divided by its initial value")}
    <p>${tex("η_0")} is the norm at the start of this solve, before the first CG
      step. The displayed ${tex("ρ_k")} is dimensionless. It is neither a maximum
      force imbalance nor the ordinary Euclidean residual divided by the load
      norm. With stiffness units for ${tex("\\mathbf{M}")}, ${tex("η_k^2")} has energy
      units, N·mm. MFEM updates the residual recursively during CG; the wrapper
      does not independently recompute the final force imbalance or estimate a
      condition number.</p>

    <h2 id="stopping">Tolerances and stopping</h2>
    <p>The relative tolerance ${tex("τ_{\\mathrm{rel}}")} asks for a reduction from
      the initial norm. The absolute tolerance ${tex("τ_{\\mathrm{abs}}")} sets a
      floor in the same units as ${tex("η_k")}. MFEM tests the squared quantities:</p>
    ${equation("η_k^2 ≤ \\mathrm{max}(τ_{\\mathrm{rel}}^2 η_0^2, τ_{\\mathrm{abs}}^2).", "Stop when the squared preconditioned residual norm is no greater than the larger of relative tolerance squared times the initial squared norm and absolute tolerance squared")}
    <p>Thus either tolerance can allow stopping. A relative tolerance of
      ${tex("10^{-6}")} asks for a millionfold norm reduction, or a factor of
      ${tex("10^{-12}")} in the squared test. It does not promise six correct
      digits of displacement or stress.</p>
    <div class="table-wrap" tabindex="0" role="region" aria-label="Solid solver settings and user controls; scroll horizontally if needed">
      <table>
        <caption>Ordinary solid solve at the reviewed revision</caption>
        <thead><tr><th scope="col">Setting</th><th scope="col">Value</th><th scope="col">Control</th></tr></thead>
        <tbody>
          <tr><th scope="row">Relative tolerance</th><td><code>1e-6</code></td><td>Fixed internally by <code>SetRelTol</code></td></tr>
          <tr><th scope="row">Absolute tolerance</th><td><code>0</code></td><td>Inherited from MFEM; KoFEM does not call <code>SetAbsTol</code></td></tr>
          <tr><th scope="row">Initial budget</th><td>5000 iterations</td><td>Internal default; callers can supply <code>cgIterationLimit</code> (1–1 000 000), not an ordinary solver-settings input</td></tr>
          <tr><th scope="row">Additional budget</th><td>1–1 000 000 per continuation</td><td>User enters “Extra iterations” in “Keep solving?”</td></tr>
        </tbody>
      </table>
    </div>
    <p>The app exposes continuation, not an ordinary solid-tolerance control.
      Optimization tolerance inputs belong to another solver path. With zero
      absolute tolerance, there is no positive absolute stopping floor. If
      ${tex("η_0 = 0")}, MFEM accepts the initial iterate immediately; the ratio
      ${tex("η_k/η_0")} is undefined. The progress monitor substitutes zero in
      that case, while the final MFEM ratio can be non-finite. Treat it as a
      zero-initial-residual edge case, not a numerical accuracy estimate.</p>

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
      and ${tex("η_0^2 = 11/4\\text{ N·mm}")}. The first CG step length is
      ${tex("22/13")}. The resulting iterates are:</p>
    <div class="table-wrap" tabindex="0" role="region" aria-label="Two-DOF bar residual and stopping calculation; scroll horizontally if needed">
      <table>
        <caption>Exact arithmetic, symmetric Gauss–Seidel preconditioning</caption>
        <thead><tr><th scope="col">Iteration</th><th scope="col">Displacement (mm)</th><th scope="col">Residual (N)</th><th scope="col">Squared norm (N·mm)</th><th scope="col">Relative residual</th></tr></thead>
        <tbody>
          <tr><th scope="row">0</th><td>${tex("(0, 0)")}</td><td>${tex("(1, 1)")}</td><td>${tex("11/4")}</td><td>1</td></tr>
          <tr><th scope="row">1</th><td>${tex("(55/26, 33/13)")}</td><td>${tex("(-9/13, 15/26)")}</td><td>${tex("99/338")}</td><td>0.326357</td></tr>
          <tr><th scope="row">2</th><td>${tex("(2, 3)")}</td><td>${tex("(0, 0)")}</td><td>0</td><td>0</td></tr>
        </tbody>
      </table>
    </div>
    <p>At iteration 1, ${tex("ρ_1 = \\sqrt{18/169} \\approx 0.326357")}, so the
      current ${tex("10^{-6}")} target requires the second step. A one-step
      budget fails to converge. For illustration, a looser relative tolerance
      of 0.5 would accept step 1; a relative tolerance of 0.1 with an absolute
      tolerance of ${tex("0.6\\sqrt{\\text{N·mm}}")}
      would also accept it, because ${tex("η_1 \\approx 0.5412\\sqrt{\\text{N·mm}}")}
      lies below the absolute floor. These illustrative tolerances are not app
      settings. The linked calculation below reproduces the steps in floating
      point, where roundoff can leave a small nonzero final residual.</p>

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
    <p>This bound uses different norms from the reported ${tex("ρ_k")}; inserting
      the log value into it would be unjustified. In practice:</p>
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
        condition number. KoFEM’s solid wrapper adds no separate equilibration
        step beyond preconditioning.</li>
    </ul>

    <h2 id="failure">Iteration budgets and failure</h2>
    <p>A budget limits work; it is not a convergence criterion. At the initial
      5000-step solid budget, KoFEM can pause at <strong>Keep solving?</strong>
      when a recent residual window shows progress. The policy checks both
      window endpoints and the geometric means of its two halves; it tolerates
      oscillations but requires improvement beyond roundoff. The default
      window is 100 observations. This heuristic predicts neither eventual
      convergence nor the validity of the model.</p>
    <p><strong>Continue</strong> adds the requested number of iterations to the
      live loop. It preserves the iterate, residual, search direction,
      preconditioner and original convergence target. The prompt may recur.
      <strong>Stop</strong>, including Escape, raises an explicit error and
      discards the partial result. Without a callback, or when the progress
      policy rejects continuation, exhausting the budget fails.</p>
    <p>The solid wrapper checks <code>GetConverged()</code> before recovering
      results. Failure reports the relative residual, iteration count and
      <code>target 1e-6</code>, with “The partial result was discarded”. MFEM can
      also warn about a non-positive preconditioner or operator during a
      breakdown. A non-convergence message alone does not diagnose singularity;
      a constrained but poorly conditioned model can also fail.</p>
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

    <h2 id="implementation">Implementation and reproducible evidence</h2>
    <p>Reviewed on 6 November 2026 at
      <a href="https://github.com/mkofler96/KoFEM/tree/${revision}"><code>${revision.slice(0, 7)}</code></a>,
      with MFEM 4.7. Earlier numerical-methods articles retain their own review
      snapshots.</p>
    <ul>
      <li>${source("engine/cpp/solve_mfem.cpp", 229, "FormLinearSystem → CG → RecoverFEMSolution")}
        connects assembly to the solid solve.
        ${source("engine/cpp/cg_mfem.cpp", 51, "solve_mfem_cg")}
        chooses CG, the smoother and relative tolerance; its monitor reports
        progress every ten iterations and on completion.</li>
      <li>MFEM’s ${mfemSource("linalg/sparsesmoothers.hpp", 38, "GSSmoother defaults")}
        and ${mfemSource("linalg/sparsesmoothers.cpp", 36, "forward/backward application")}
        establish the preconditioner. The
        ${mfemSource("linalg/solvers.cpp", 25, "base constructor")}
        initializes absolute tolerance to zero;
        ${mfemSource("linalg/solvers.cpp", 720, "CGSolver::Mult")}
        defines the preconditioned norm and squared stopping test.
        ${mfemSource("linalg/solvers.hpp", 280, "GetFinalRelNorm")}
        returns the final-to-initial norm ratio.</li>
      <li>${source("engine/cpp/cg_continuation.h", 45, "CgContinuation")}
        owns the progress policy and budgets;
        ${source("engine/cpp/cg_browser.cpp", 7, "browser controls")},
        ${source("web/src/workers/solver.worker.ts", 53, "worker request")}
        and ${source("web/src/components/CgContinuationDialog.tsx", 47, "continuation dialog")}
        connect it to the app. The worker
        ${source("web/src/workers/solver.worker.ts", 907, "returns errors to the caller")}
        rather than returning a partial field.</li>
    </ul>
    <p>From the repository root, reproduce the bar calculation and stopping
      checks with:</p>
    <pre><code>bun web/theory/numerical-methods/linear-solve-example.mjs</code></pre>
    <p><a href="https://github.com/mkofler96/KoFEM/blob/develop/web/theory/numerical-methods/linear-solve-example.mjs">The educational calculation</a>
      checks the analytical displacements, hand-derived iterates, absolute and
      relative stopping, and a one-step failure. It illustrates the equations;
      it does not run the production solver.</p>
    <p>For the actual solid wrapper, the existing
      ${source("engine/tests/cg_continuation_validation.cpp", 126, "160-row MFEM fixture")}
      and ${source("scripts/test-cg-continuation.sh", 18, "MFEM harness")}
      exercise successful continuation, identical final fields, Stop and budget
      failure. With Emscripten and the project’s MFEM dependencies installed:</p>
    <pre><code>bash scripts/test-cg-continuation.sh --mfem</code></pre>
    <p>The ${source("web/tests/cg-continuation.spec.ts", 77, "browser continuation regression")}
      also drives the real solid WASM path with a deliberately smaller budget:</p>
    <pre><code>cd web
bun x playwright test cg-continuation.spec.ts --grep "CG pauses"</code></pre>
    <p>It reproduces a budget stop without requiring a huge or private model.
      A historical large-model stagnation report,
      <a href="https://linear.app/kofem/issue/KOF-173">KOF-173</a>, records about
      209 000 DOFs and a residual plateau near 0.04–0.05. Those figures describe
      that model and old run, not a universal DOF limit or a fresh benchmark.
      <a href="https://linear.app/kofem/issue/KOF-291">KOF-291</a> records the
      later continuation decision.</p>

    <h2 id="decision">Decision: the current solid method</h2>
    <p><strong>Choice and rationale.</strong> Sparse CG with symmetric
      Gauss–Seidel suits a constrained, positive-definite elastic system and
      keeps storage and per-step work modest in the browser. The implementation
      has a fixed accuracy target, checks convergence and lets a progressing
      solve continue without restarting.</p>
    <p><strong>Tradeoff and recorded alternatives.</strong> Local smoothing
      gives no mesh-independent iteration guarantee. KOF-173 records algebraic
      multigrid with elasticity near-null-space information, geometric
      multigrid and stronger smoothing as alternatives, with WASM dependency
      or mesh-hierarchy work. Sparse direct factorization is another general
      option, with fill-in and memory costs; the current solid path does not
      select it as a fallback. These are options, not evidence of a completed
      comparative benchmark.</p>
    <p><strong>Revisit when</strong> representative, correctly constrained
      models repeatedly stagnate, require many extensions or exceed browser
      time or memory budgets. Compare methods on those models with measured
      residuals, accuracy, time and memory. Continuation cannot repair a rigid
      mode or make a wrong physical model accurate.</p>

    <h2 id="references">Sources and further reading</h2>
    <ol class="refs">
      <li>MFEM 4.7 production-library source linked above; the class API’s
        <code>SetRelTol</code> takes a norm tolerance. The separate free
        <code>CG</code>/<code>PCG</code> functions use squared tolerance arguments;
        KoFEM calls the class.</li>
      <li><a href="https://www.cs.cmu.edu/~quake-papers/painless-conjugate-gradient.pdf">Shewchuk,
        <cite>An Introduction to the Conjugate Gradient Method Without the Agonizing Pain</cite></a>
        (1994), conjugacy, conditioning and preconditioning.</li>
      <li>Saad, <cite>Iterative Methods for Sparse Linear Systems</cite>, second
        edition (2003), preconditioned CG and stopping criteria.</li>
    </ol>`,
};
