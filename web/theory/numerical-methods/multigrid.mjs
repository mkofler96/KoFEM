// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { equation, matrixEquation, tex } from "../operators/math.mjs";
import { codeSource } from "./sources.mjs";
import { figure } from "../figures/index.mjs";
import { multigridStudy } from "../figures/multigrid.mjs";
import { barExample } from "./multigrid-example.mjs";

// The worked example's numbers are computed here, so the page cannot drift
// from the calculation that multigrid-example.mjs checks.
const bar = barExample();
const ratio = (error) => (error / bar.initialError).toFixed(3);

const studyRows = multigridStudy
  .map(
    (row) =>
      `<tr><th scope="row">${row.nx} × ${row.nx / 4}</th><td>${row.unknowns.toLocaleString("en-US")}</td><td>${row.levels.length}</td><td>${row.operatorComplexity.toFixed(2)}</td><td>${row.gaussSeidel}</td><td>${row.multigrid}</td></tr>`,
  )
  .join("\n          ");

export default {
  slug: "numerical-methods/multigrid",
  searchTitle: "Algebraic multigrid (AMG) preconditioner for elasticity",
  description:
    "How smoothed-aggregation algebraic multigrid builds coarse levels from the rigid-body modes, why it keeps conjugate-gradient iterations nearly constant as the mesh is refined, and where it struggles.",
  sections: [
    ["smooth-error", "Why local sweeps stall"],
    ["coarse-correction", "Coarse-level correction"],
    ["aggregation", "Aggregates from strong couplings"],
    ["rigid-body-modes", "Rigid-body modes on every level"],
    ["prolongator-smoothing", "Smoothing the prolongator"],
    ["v-cycle", "The V-cycle inside CG"],
    ["worked-example", "Worked example: one coarse level for a bar"],
    ["refinement", "Iterations under mesh refinement"],
    ["limits", "When multigrid struggles or fails"],
    ["implementation", "KoFEM implementation"],
    ["decision", "Why KoFEM uses smoothed aggregation"],
    ["references", "Sources and further reading"],
  ],
  body: `
    <p class="lede">Why does a multigrid preconditioner keep the iteration count low, and how does KoFEM build one?</p>
    <p>KoFEM solves a solid model with conjugate gradients (CG). The
      <a href="/theory/numerical-methods/linear-solve/">linear-solve page</a>
      explains CG, its residual and its stopping test. This page explains the
      default preconditioner inside CG: smoothed-aggregation algebraic
      multigrid (AMG). Multigrid is not a separate solver here. It is applied
      once per CG iteration to turn a residual into a correction. The page
      covers static, small-strain, linear-elastic solids, as on the
      linear-solve page; units are N, mm and N/mm.</p>

    <h2 id="smooth-error">Why local sweeps stall</h2>
    <p>Write the constrained system as ${tex("\\mathbf{A}\\mathbf{x} = \\mathbf{b}")},
      with the <a href="/theory/notation/#stiffness">stiffness matrix</a>
      ${tex("\\mathbf{A}")} after
      <a href="/theory/numerical-methods/loads-and-constraints/#elimination">constraint elimination</a>.
      For an estimate ${tex("\\mathbf{x}_k")}, the error
      ${tex("\\mathbf{e}_k = \\mathbf{x} - \\mathbf{x}_k")} and the residual
      ${tex("\\mathbf{r}_k = \\mathbf{b} - \\mathbf{A}\\mathbf{x}_k")} are related by
      ${tex("\\mathbf{A}\\mathbf{e}_k = \\mathbf{r}_k")}.</p>
    <p>A Gauss–Seidel sweep visits each unknown in turn and sets it so that
      its own row balances, using the current values of its neighbours. It
      only sees one node and its neighbours at a time. Error that changes sign
      from node to node creates large local force imbalances, and a sweep
      removes it quickly. Error that varies slowly over many elements creates
      almost no imbalance at any one node, so a sweep barely changes it.</p>
    ${figure("multigrid-smoothing", "Gauss–Seidel on a bar of 63 free nodes, applied to an error made of a smooth half-sine (dashed) and two fast oscillations. Four sweeps remove the oscillations and leave the smooth part almost untouched: the sweeps smooth the error rather than reduce it.")}
    <p>In a stiffness matrix, smooth error is soft. Its strain energy
      ${tex("\\mathbf{e}^{T}\\mathbf{A}\\mathbf{e}")} is small compared with its
      size, and the softest error of all is a
      <a href="/theory/numerical-methods/loads-and-constraints/#rigid-body-modes">rigid-body motion</a>,
      which costs no energy where the supports allow it. A finer mesh has more
      nodes across the same smooth shape, so a sweep reaches less of it and
      the iteration count of Gauss–Seidel-preconditioned CG grows. Thin walls
      make it worse: bending a thin wall is soft as well.</p>

    <h2 id="coarse-correction">Coarse-level correction</h2>
    <p>Smooth error can be described with far fewer unknowns than the mesh
      has. Multigrid builds a <strong>prolongator</strong>
      ${tex("\\mathbf{P}")}, a tall sparse matrix whose columns are coarse basis
      vectors: each is a displacement pattern on the fine mesh. A coarse vector
      ${tex("\\mathbf{y}")} stands for the fine displacement
      ${tex("\\mathbf{P}\\mathbf{y}")}. The coarse matrix is the Galerkin product</p>
    ${equation("\\mathbf{A}_c = \\mathbf{P}^{T}\\mathbf{A}\\mathbf{P},", "The coarse matrix A c equals P transpose times A times P")}
    <p>the stiffness of the coarse basis vectors against each other. Given a
      residual ${tex("\\mathbf{r}")} of an estimate ${tex("\\mathbf{x}")}, the coarse-level correction gives</p>
    ${equation("\\mathbf{x}' = \\mathbf{x} + \\mathbf{P}\\mathbf{A}_c^{-1}\\mathbf{P}^{T}\\mathbf{r}.", "The corrected estimate x prime equals x plus the prolongated solution of the coarse system whose right-hand side is P transpose times the residual")}
    <p>${tex("\\mathbf{P}^{T}\\mathbf{r}")} restricts the residual to the coarse
      unknowns, ${tex("\\mathbf{A}_c^{-1}")} solves the small system, and
      ${tex("\\mathbf{P}")} brings the answer back. Among all corrections of the
      form ${tex("\\mathbf{P}\\mathbf{y}")}, this one leaves the smallest error in
      the energy norm ${tex("\\sqrt{\\mathbf{e}^{T}\\mathbf{A}\\mathbf{e}}")}: the remaining
      error is ${tex("\\mathbf{A}")}-orthogonal to every coarse basis vector. So
      whatever smooth error the columns of ${tex("\\mathbf{P}")} can represent,
      the correction removes. The smoother removes the rest. The two are
      complementary, and the method stands or falls with the choice of
      ${tex("\\mathbf{P}")}.</p>
    <p>Geometric multigrid takes ${tex("\\mathbf{P}")} from a coarser mesh.
      KoFEM’s meshes are unstructured and have no coarser parent mesh, so
      ${tex("\\mathbf{P}")} is built from the matrix and the node coordinates
      alone: that makes it <em>algebraic</em>. Applied recursively to
      ${tex("\\mathbf{A}_c")}, it gives a hierarchy of levels.</p>

    <h2 id="aggregation">Aggregates from strong couplings</h2>
    <p>Smoothed aggregation first groups neighbouring nodes into
      <strong>aggregates</strong>; each aggregate becomes one coarse node.
      Nodes are grouped along strong couplings. The coupling of nodes
      ${tex("i")} and ${tex("j")} is the ${tex("3 × 3")} block
      ${tex("\\mathbf{A}_{ij}")} of the matrix; it counts as strong when</p>
    ${equation("|\\mathbf{A}_{ij}|_F > θ \\sqrt{|\\mathbf{A}_{ii}|_F |\\mathbf{A}_{jj}|_F},", "The Frobenius norm of the coupling block exceeds theta times the square root of the product of the Frobenius norms of the two diagonal blocks")}
    <p>with Frobenius norms ${tex("|\\cdot|_F")} (the square root of the sum
      of squared entries) and a threshold ${tex("θ")}. A small threshold
      keeps nearly every mesh neighbour; it drops couplings that are weak
      compared with the stiffness of the two nodes, for example across a
      soft material next to a stiff one.</p>
    <p>Aggregation then runs in three passes. First, a node whose strong
      neighbours are all still free forms an aggregate with them. Second,
      each node left over joins the aggregate of its strongest neighbour.
      Third, any node still left forms a new aggregate with its free
      neighbours. Constrained nodes join none: the coarse levels must not
      move them. A node with no strong coupling also joins none; the smoother
      handles it.</p>
    ${figure("multigrid-aggregates", "Aggregates on a plane-stress mesh of a plate with a hole, clamped at its left end. Each colour patch is one aggregate, a coarse node. The second coarsening groups the first level’s aggregates in the same way, on the coarse matrix. The clamped nodes belong to no aggregate. Computed for this figure with the threshold KoFEM uses.")}

    <h2 id="rigid-body-modes">Rigid-body modes on every level</h2>
    <p>Each aggregate needs coarse basis vectors that can represent the soft
      error on it. For an elastic solid the softest motions are the six
      rigid-body modes: three translations and three rotations. At a node with
      position ${tex("(p_x, p_y, p_z)")}, measured from the centroid of the
      model and divided by the root-mean-square node distance from it, the
      modes take the values</p>
    ${matrixEquation(
      "\\mathbf{B}_{\\text{node}} =",
      [
        ["1", "0", "0", "0", "p_z", "−p_y"],
        ["0", "1", "0", "−p_z", "0", "p_x"],
        ["0", "0", "1", "p_y", "−p_x", "0"],
      ],
      "Rigid-body modes at one node: rows are the x, y and z displacement; columns are translation in x, y and z, then rotation about x, y and z",
    )}
    <p>Rows are the node’s ${tex("x")}, ${tex("y")} and ${tex("z")}
      displacements; columns are the three translations and the rotations
      about ${tex("x")}, ${tex("y")} and ${tex("z")}. The scaling gives
      translations and rotations similar magnitudes. Rows of constrained
      unknowns are set to zero.</p>
    <p>Stack these rows over the nodes of one aggregate into
      ${tex("\\mathbf{B}_{\\text{agg}}")} and factor it,
      ${tex("\\mathbf{B}_{\\text{agg}} = \\mathbf{Q}\\mathbf{R}")}, with
      orthonormal columns in ${tex("\\mathbf{Q}")}. Those six columns are the
      aggregate’s columns of the <strong>tentative prolongator</strong>
      ${tex("\\mathbf{P}_0")}, zero outside the aggregate. By construction
      ${tex("\\mathbf{P}_0")} reproduces every rigid-body motion exactly, on
      every aggregate at once: a rigid motion of the whole body is a
      combination of its columns. ${tex("\\mathbf{R}")} records the modes in
      the coarse unknowns, so the next level repeats the process with six
      unknowns per coarse node. A mode an aggregate cannot carry, for example
      a rotation of an aggregate with too few free unknowns, is dropped as
      linearly dependent.</p>

    <h2 id="prolongator-smoothing">Smoothing the prolongator</h2>
    <p>${tex("\\mathbf{P}_0")} is piecewise rigid: each column moves one
      aggregate and nothing else, with a jump at the aggregate’s edge. Such
      jumps cost strain energy, so these basis vectors are too stiff to
      represent smooth error well. One damped Jacobi step on each column
      smooths them:</p>
    ${equation("\\mathbf{P} = (\\mathbf{I} - ω\\mathbf{D}^{-1}\\mathbf{A})\\mathbf{P}_0, \\quad ω = \\frac{4}{3ρ(\\mathbf{D}^{-1}\\mathbf{A})}.", "P equals the identity minus omega times D inverse A, times P zero; omega equals four divided by three times the spectral radius of D inverse A")}
    <p>${tex("\\mathbf{D}")} is the diagonal of ${tex("\\mathbf{A}")} and
      ${tex("ρ(\\mathbf{D}^{-1}\\mathbf{A})")} the largest eigenvalue of
      ${tex("\\mathbf{D}^{-1}\\mathbf{A}")}. The step lowers the energy of each
      column where it is highest, at the aggregate edges, and spreads it one
      layer of nodes into the neighbouring aggregates. The columns still add up to a rigid
      motion ${tex("\\mathbf{v}")} of the whole body wherever
      ${tex("\\mathbf{A}\\mathbf{v} = \\mathbf{0}")}, that is away from the
      supports, because the step leaves such a motion unchanged. The weight ${tex("ω")} is the usual choice of
      Vaněk, Mandel and Brezina; the price is a denser ${tex("\\mathbf{P}")}
      and therefore a denser coarse matrix.</p>

    <h2 id="v-cycle">The V-cycle inside CG</h2>
    <p>One application of the preconditioner, ${tex("\\mathbf{z} ≈ \\mathbf{A}^{-1}\\mathbf{r}")},
      is one <strong>V-cycle</strong> through the hierarchy, starting from
      ${tex("\\mathbf{z} = \\mathbf{0}")}:</p>
    <ol>
      <li>On each level going down: one forward Gauss–Seidel sweep, then
        restrict the remaining residual to the next level with
        ${tex("\\mathbf{P}^{T}")}.</li>
      <li>On the coarsest level: solve exactly by dense Cholesky
        factorization.</li>
      <li>On each level going up: add the prolongated correction, then one
        backward Gauss–Seidel sweep.</li>
    </ol>
    ${figure("multigrid-v-cycle", "One V-cycle: smooth and restrict on the way down, solve directly on the coarsest level, correct and smooth on the way up. The upward sweep runs in the reverse order of the downward one.")}
    <p>CG needs a symmetric positive-definite preconditioner. The backward
      sweep is the transpose of the forward sweep, so the cycle is symmetric;
      the Galerkin coarse matrices are positive definite whenever
      ${tex("\\mathbf{A}")} is, and with an exact coarsest solve and
      Gauss–Seidel sweeps the whole cycle is positive definite. This is why the cycle smooths forward on the way
      down and backward on the way up rather than forward both times.</p>
    <p>Each level has a fraction of the unknowns of the one above, so a cycle
      costs a few fine-level matrix–vector products. The
      <strong>operator complexity</strong>, the nonzeros of all levels divided
      by those of ${tex("\\mathbf{A}")}, measures the extra memory and work per
      cycle; in the study below it stays near 1.4.</p>

    <h2 id="worked-example">Worked example: one coarse level for a bar</h2>
    <p>Take a bar of seven springs of stiffness 1 N/mm between eight nodes,
      fixed at both ends, nodes 0 and 7. The six free nodes give the
      tridiagonal matrix ${tex("\\mathbf{A}")} with 2 on the diagonal and
      ${tex("−1")} beside it. Along a bar the only rigid motion is an axial
      translation. Group nodes 1–3 and 4–6 into two aggregates. The tentative
      prolongator has one column per aggregate, one on its nodes and zero
      elsewhere:</p>
    ${matrixEquation(
      "\\mathbf{P}_0^{T} =",
      [
        ["1", "1", "1", "0", "0", "0"],
        ["0", "0", "0", "1", "1", "1"],
      ],
      "Transpose of the tentative prolongator: first row one on nodes 1 to 3, second row one on nodes 4 to 6",
    )}
    <p>KoFEM normalizes the columns, here by ${tex("1/\\sqrt{3}")}; scaling a
      column rescales its coarse unknown and leaves the correction unchanged,
      so this example keeps whole numbers. Every diagonal entry is 2 and the
      off-diagonal entries of a row add up to at most 2 in absolute value, so
      by Gershgorin’s theorem ${tex("ρ(\\mathbf{D}^{-1}\\mathbf{A}) ≤ 2")}. With this bound,
      ${tex("ω = 2/3")} and ${tex("ω\\mathbf{D}^{-1} = \\mathbf{I}/3")}; KoFEM
      estimates ${tex("ρ")} instead. Then
      ${tex("\\mathbf{I} - \\mathbf{A}/3")} has ${tex("1/3")} on its three central
      diagonals, and each smoothed column averages three neighbouring entries
      of ${tex("\\mathbf{P}_0")}:</p>
    ${matrixEquation(
      "\\mathbf{P}^{T} =",
      [
        ["2/3", "1", "2/3", "1/3", "0", "0"],
        ["0", "0", "1/3", "2/3", "1", "2/3"],
      ],
      "Transpose of the smoothed prolongator: first row two thirds, one, two thirds, one third, zero, zero; second row zero, zero, one third, two thirds, one, two thirds",
    )}
    ${figure("multigrid-prolongator", "The two coarse basis vectors of the bar before and after smoothing. The tentative vectors move one aggregate rigidly and jump at its edge; the smoothed vectors are overlapping hats that taper towards the supports and into the neighbouring aggregate.")}
    <p>The coarse matrices follow from ${tex("\\mathbf{P}^{T}\\mathbf{A}\\mathbf{P}")}:</p>
    ${matrixEquation(
      "\\mathbf{P}_0^{T}\\mathbf{A}\\mathbf{P}_0 =",
      [
        ["2", "−1"],
        ["−1", "2"],
      ],
      "Tentative coarse matrix: two, minus one; minus one, two",
    )}
    ${matrixEquation(
      "\\mathbf{P}^{T}\\mathbf{A}\\mathbf{P} =",
      [
        ["8/9", "−1/3"],
        ["−1/3", "8/9"],
      ],
      "Smoothed coarse matrix: eight ninths, minus one third; minus one third, eight ninths",
    )}
    <p>The tentative coarse matrix is the bar seen as two rigid blocks: moving
      one block by 1 mm stretches the spring to its support and the spring
      between the blocks, 2 N/mm. The smoothed basis vectors taper
      gradually instead of jumping, so they are much softer, 8/9 instead of
      2 N/mm: they are closer to the soft, smooth error the coarse level has
      to remove.</p>
    <p>Now load every free node with 1 N. The exact displacements are
      ${tex("(3, 5, 6, 6, 5, 3)")} mm. Start from zero and apply each
      preconditioner once to this load. One symmetric Gauss–Seidel sweep pair
      leaves ${ratio(bar.gaussSeidelError)} of the initial error in the energy
      norm. One two-level cycle, a forward sweep, the coarse correction with
      the smoothed ${tex("\\mathbf{P}")} and a backward sweep, leaves
      ${ratio(bar.twoLevelError)}. On six unknowns the difference is modest;
      it grows with the mesh, as the next section shows.</p>

    <h2 id="refinement">Iterations under mesh refinement</h2>
    <p>The point of multigrid is that its iteration count hardly depends on
      the mesh size. The table and figure below show CG on a plane-stress
      cantilever plate, four times as long as it is deep, clamped at one end
      and loaded at the other. The plate is cut into squares of two linear
      triangles each, and every refinement halves the element size. Both
      preconditioners stop at the same relative residual of
      ${tex("10^{-6}")}. The multigrid follows the steps above in two
      dimensions, where a node has two unknowns and a body three rigid-body
      modes, and coarsens down to 60 unknowns so that even the smaller meshes
      have more than one level.</p>
    ${figure("multigrid-scaling", "CG iterations to a relative residual of 10<sup>−6</sup> on the refined cantilever plate. With symmetric Gauss–Seidel the count roughly doubles with each refinement; with smoothed aggregation it stays nearly flat. Computed for this page in two dimensions; the counts of KoFEM’s three-dimensional solves differ.", "narrow")}
    <div class="table-wrap" tabindex="0" role="region" aria-label="Iterations under mesh refinement; scroll horizontally if needed">
      <table>
        <caption>Cantilever plate, CG to a relative residual of 10<sup>−6</sup></caption>
        <thead><tr><th scope="col">Squares</th><th scope="col">Unknowns</th><th scope="col">Levels</th><th scope="col">Operator complexity</th><th scope="col">Gauss–Seidel iterations</th><th scope="col">Multigrid iterations</th></tr></thead>
        <tbody>
          ${studyRows}
        </tbody>
      </table>
    </div>
    <p>Each Gauss–Seidel iteration is cheaper than a V-cycle, but not by
      enough to make up for the iteration count on large models. Multigrid
      also costs a setup: aggregation, the prolongators and the coarse
      matrices are built once before CG starts.</p>

    <h2 id="limits">When multigrid struggles or fails</h2>
    <ul>
      <li><strong>Missing supports.</strong> The coarse levels carry the
        rigid-body modes on purpose. If the supports leave one of them free,
        the coarsest matrix is singular, its Cholesky factorization fails,
        and the solve stops before CG starts: the coarsest multigrid matrix
        “is not positive definite — the model is probably not fully
        constrained”. See
        <a href="/theory/numerical-methods/loads-and-constraints/#insufficient">insufficient constraints</a>.
        Gauss–Seidel builds no coarse level, so it may still run on such a
        model, but the free motion stays undetermined.</li>
      <li><strong>Soft motions that are not rigid.</strong> The coarse space
        holds rigid motions only. Bending a thin wall is soft too, but it is
        not a rigid motion of an aggregate, so thin-walled parts, above all
        with quadratic elements, can still need many iterations.</li>
      <li><strong>Material contrast.</strong> A very stiff body next to a
        very soft one leaves couplings that the strength threshold may keep or
        drop. Large contrasts can raise the iteration count with either
        preconditioner.</li>
      <li><strong>Memory and setup.</strong> The coarse levels add memory in
        proportion to the operator complexity, and the setup takes time before
        the first iteration. The solve log lists the size of every level.</li>
      <li><strong>Coarsening that stops early.</strong> If a level cannot be
        coarsened further while still large, the coarsest level is too big to
        factor densely and is smoothed with a few symmetric Gauss–Seidel
        sweeps instead of solved. The cycle stays a valid preconditioner,
        but converges more slowly.</li>
    </ul>
    <p>None of these makes a converged answer wrong. Multigrid changes how
      fast CG reaches the stopping test, not which system it solves: both
      preconditioners stop at the same residual, and the
      <a href="/theory/numerical-methods/linear-solve/#accuracy">accuracy questions</a>
      of the linear-solve page apply unchanged.</p>

    <h2 id="implementation">KoFEM implementation</h2>
    <p>The multigrid is part of KoFEM’s Rust finite-element module and is
      selected as “AMG multigrid” under “Solver” in the Solve panel, the
      default for solid models.</p>
    <div class="table-wrap" tabindex="0" role="region" aria-label="Multigrid settings; scroll horizontally if needed">
      <table>
        <caption>Multigrid settings in KoFEM</caption>
        <thead><tr><th scope="col">Setting</th><th scope="col">Value</th></tr></thead>
        <tbody>
          <tr><th scope="row">Strength threshold ${tex("θ")}</th><td>0.02 for solid solves; 0 in topology optimization</td></tr>
          <tr><th scope="row">Near-null space</th><td>Six rigid-body modes per node, from the node coordinates</td></tr>
          <tr><th scope="row">Prolongator smoothing</th><td>One damped Jacobi step, ${tex("ω = 4/(3ρ)")}, ${tex("ρ")} from 15 power iterations raised by 5 %</td></tr>
          <tr><th scope="row">Stop coarsening</th><td>At 600 unknowns or less, after 10 levels, or when a level no longer shrinks</td></tr>
          <tr><th scope="row">Smoother</th><td>Forward Gauss–Seidel down, backward Gauss–Seidel up, one sweep each</td></tr>
          <tr><th scope="row">Coarsest level</th><td>Dense Cholesky up to 2000 unknowns; otherwise four symmetric Gauss–Seidel sweep pairs</td></tr>
        </tbody>
      </table>
    </div>
    <ul>
      <li>${codeSource("crates/kofem-fem/src/static_solve.rs", 165, "The solid solve")}
        builds the hierarchy after eliminating the constraints and marks the
        constrained unknowns;
        ${codeSource("crates/kofem-fem/src/amg.rs", 841, "the setup")}
        repeats aggregation and prolongator construction level by level.</li>
      <li>${codeSource("crates/kofem-fem/src/amg.rs", 326, "Strong couplings")},
        ${codeSource("crates/kofem-fem/src/amg.rs", 377, "the three-phase aggregation")},
        ${codeSource("crates/kofem-fem/src/amg.rs", 730, "the rigid-body modes")},
        ${codeSource("crates/kofem-fem/src/amg.rs", 447, "the tentative prolongator")},
        ${codeSource("crates/kofem-fem/src/amg.rs", 581, "its smoothing")} and
        ${codeSource("crates/kofem-fem/src/amg.rs", 615, "the Galerkin product")}
        implement the steps above. A coarse unknown whose mode was dropped
        keeps a unit diagonal and a zero right-hand side.</li>
      <li>${codeSource("crates/kofem-fem/src/amg.rs", 995, "The V-cycle")}
        is applied by
        ${codeSource("crates/kofem-fem/src/cg.rs", 129, "preconditioned CG")}.
        ${codeSource("web/src/lib/solve/amg.ts", 581, "amg.ts")} writes the
        unknowns of every level to the solve log, and a singular coarsest
        level raises
        ${codeSource("crates/kofem-fem/src/error.rs", 102, "the setup error")}.</li>
      <li>In topology optimization the stiffness changes with the densities
        each design. A threshold of 0 makes the aggregates follow the mesh
        rather than the densities, so
        ${codeSource("crates/kofem-fem/src/topology/simp.rs", 399, "the SIMP solve")}
        keeps the coarse levels for
        ${codeSource("crates/kofem-fem/src/topology/simp.rs", 76, "three designs")},
        swapping in only the new fine matrix, before rebuilding them.</li>
      <li>In ${codeSource("crates/kofem-fem/src/coupled_static.rs", 510, "a solve with couplings")},
        a coupling’s reference point carries rotations instead of
        translations, and its modes are set accordingly. Pure shell models do
        not use multigrid; they solve with incomplete Cholesky preconditioning.</li>
    </ul>
    <p>KoFEM’s automated tests compare multigrid solves of real models with
      stored reference results and cover the setup and the V-cycle directly.
      The worked example and the refinement study on this page are separate
      calculations that illustrate the method; they do not run KoFEM’s
      code.</p>

    <h2 id="decision">Why KoFEM uses smoothed aggregation</h2>
    <p><strong>Choice and rationale.</strong> Smoothed-aggregation AMG with
      the rigid-body modes as coarse basis is a standard preconditioner for
      elasticity. It needs only the matrix and the node coordinates, so it
      works on Netgen’s unstructured tetrahedral meshes and on hexahedral
      meshes alike. It keeps CG iteration counts low as models grow, where
      Gauss–Seidel’s grow with the mesh, and it fits in the browser’s memory
      because the coarse levels add only a fraction of the matrix.</p>
    <p><strong>Alternatives.</strong> Geometric multigrid needs nested
      meshes, which an unstructured mesher does not produce. Classical
      (Ruge–Stüben) AMG was designed for scalar problems and needs extensions
      to see rigid rotations. Incomplete Cholesky, which KoFEM uses for shells,
      has no coarse level, so its iterations also grow with the mesh. A sparse
      direct factorization avoids iterations but its fill-in costs memory that
      large models do not have in the browser. Gauss–Seidel stays selectable
      as the simple choice.</p>
    <p><strong>Tradeoffs and limits.</strong> Multigrid costs a setup step
      and memory for its levels, fails early on under-constrained models, and
      helps less where soft motions are not rigid, such as thin walls with
      quadratic elements. A coarse space for those motions, a p-multigrid step
      from quadratic to linear elements or a stronger smoother would be the
      next things to try there.</p>

    <h2 id="references">Sources and further reading</h2>
    <ol class="refs">
      <li>Vaněk, Mandel and Brezina, “Algebraic multigrid by smoothed
        aggregation for second and fourth order elliptic problems”,
        <cite>Computing</cite> 56 (1996), the method this page follows.</li>
      <li>Briggs, Henson and McCormick, <cite>A Multigrid Tutorial</cite>,
        second edition (2000), smoothing, coarse-level correction and the
        V-cycle.</li>
      <li>Trottenberg, Oosterlee and Schüller, <cite>Multigrid</cite> (2001),
        with an appendix by Stüben on algebraic multigrid.</li>
      <li>Saad, <cite>Iterative Methods for Sparse Linear Systems</cite>, second
        edition (2003), multigrid as a preconditioner for CG.</li>
    </ol>`,
};
