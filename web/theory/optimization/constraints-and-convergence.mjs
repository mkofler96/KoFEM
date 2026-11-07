// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { equation, tex } from "../operators/math.mjs";
import { evidence, number, source, table } from "./evidence.mjs";
import { figure } from "../figures/index.mjs";

const { mbb, meshIndependence: mi } = evidence;
const count = (value) => value.toLocaleString("en-US");

export default {
  slug: "optimization/constraints-and-convergence",
  description:
    "What happens in each SIMP iteration: reused analysis objects, the radius filter and mesh dependence, MMA updates and move limits, stress constraints, and what convergence does and does not establish, checked on the MBB and cantilever benchmarks.",
  sections: [
    ["iteration", "One iteration, step by step"],
    ["in-engine", "Why the loop runs in the engine"],
    ["filtering", "Filtering, radius and mesh dependence"],
    ["mma", "Updating densities with MMA"],
    ["stress-constraint", "Maximum-stress constraints"],
    ["termination", "When a run stops"],
    ["benchmarks", "Check the MBB beam and mesh independence"],
    ["references", "Implementation and references"],
  ],
  body: `
    <p class="lede">How do filtering, constraints and convergence shape an optimized design?</p>
    <p><a href="/theory/optimization/simp/">SIMP</a> defines the design
      problem: element densities, a penalized stiffness and compliance or
      volume as the objective. This page follows the loop that solves it, and
      explains what a reported “converged” run means.</p>

    <h2 id="iteration">One iteration, step by step</h2>
    <p>Before the first iteration the engine builds, once per run: the order-1
      finite element space, the supported degrees of freedom, the assembled
      load vector ${tex("\\mathbf{f}")}, every full-material element matrix
      ${tex("\\mathbf{K}_e^0")} with its volume and centroid, the filter’s
      neighbour weights, and the optimizer state. A minimum-compliance run
      starts with every density equal to ${tex("v_{\\mathrm{f}}")}; a
      minimum-volume run starts from full material. Each iteration then:</p>
    <ol>
      <li><strong>Analyses</strong> the current design. It scales the cached
        ${tex("\\mathbf{K}_e^0")} by ${tex("s(ρ_e)")}, assembles
        ${tex("\\mathbf{K}(ρ)")} and solves ${tex("\\mathbf{K}\\mathbf{d}=\\mathbf{f}")}
        with conjugate gradients. Nothing is re-meshed or re-integrated.</li>
      <li><strong>Evaluates</strong> compliance, volume and their
        sensitivities from that one displacement field.</li>
      <li><strong>Filters</strong> the compliance sensitivities over a radius
        ${tex("r_{\\mathrm{min}}")}.</li>
      <li><strong>Updates</strong> all active densities with one step of the
        method of moving asymptotes (MMA).</li>
      <li><strong>Reports</strong> the analysed design: compliance, volume
        fraction and largest density change are logged, and the density is
        streamed to the viewport. Then it tests the stopping rule.</li>
    </ol>
    <p>Each iteration is therefore a full static
      <a href="/theory/numerical-methods/linear-solve/">linear solve</a> of a
      model with a different stiffness distribution. A run of 50–100
      iterations costs roughly that many static solves, each typically harder
      than the original because void elements create large stiffness contrasts.
      The returned density, the last history entry and the returned
      displacements always describe the same analysed design.</p>

    <h2 id="in-engine">Why the loop runs in the engine</h2>
    <p>KoFEM’s solver is C++ compiled to WebAssembly and runs in a browser
      worker. The whole optimization runs inside one engine call. Keeping the
      loop there reuses the mesh, element matrices, supports, load and filter
      weights for every iteration. A loop driven from JavaScript would instead
      cross the JavaScript–WebAssembly boundary and rebuild or re-transfer that
      data each iteration.</p>
    <p>The tradeoff is control. A single blocking call cannot pause, so
      cancelling a run terminates the worker and discards it. Progress is
      visible because the engine logs one line per iteration and passes each
      analysed density to an optional callback.</p>

    <h2 id="filtering">Filtering, radius and mesh dependence</h2>
    <p>Unfiltered SIMP has two well-known failures. Checkerboards — alternating
      solid and void elements — look artificially stiff to low-order elements.
      And refining the mesh lets ever thinner members appear, so the answer
      changes with the mesh instead of converging to one design.</p>
    ${figure("density-filter", "Filter weights around element e: they fall linearly with distance and vanish at the radius r<sub>min</sub>. Features thinner than about the radius cannot form.")}
    <p>KoFEM’s filter introduces a physical length, the
      <a href="/theory/notation/#filter-radius">filter radius</a>
      ${tex("r_{\\mathrm{min}}")}. Elements whose centroids
      ${tex("\\mathbf{x}_e,\\mathbf{x}_i")} are closer than it are neighbours,
      with linear “cone” weights:</p>
    ${equation("H_{ei}=\\mathrm{max}(0,\\,r_{\\mathrm{min}}-|\\mathbf{x}_e-\\mathbf{x}_i|),\\quad g_e^{\\mathrm{f}}=\\frac{1}{\\mathrm{max}(ρ_e,10^{-3})\\sum_i H_{ei}}\\sum_i H_{ei}ρ_ig_i,\\quad g_i=\\frac{∂c}{∂ρ_i}.", "Cone weights fall linearly to zero at the filter radius; the filtered sensitivity is a density-weighted neighbour average of the raw sensitivities")}
    <p>This is Sigmund’s sensitivity filter in the form of Andreassen et al.,
      used for compliance and volume runs. It smooths the information the
      optimizer acts on, not the densities themselves. It is a heuristic: the
      filtered value is not the exact derivative of any function, which works
      well for compliance but not for stress. Stress-constrained runs therefore
      filter densities instead; see <a href="#stress-constraint">maximum-stress constraints</a>.</p>
    <p>Members thinner than about ${tex("2r_{\\mathrm{min}}")} are
      discouraged, so ${tex("r_{\\mathrm{min}}")} acts as a minimum length
      scale only if it spans several elements. In the app,
      <strong>Filter r_min is an absolute length in model units</strong>
      (default 1.5, i.e. 1.5&nbsp;mm in the app’s mm units), not a multiple of
      element size. Compare it with your mesh size: a radius smaller than one
      element leaves each element as its own only neighbour and disables the
      filter. Values of 1.5–3 element sizes are common. The engine’s own
      fallback of 1.5 × the mean element size applies only when an API caller
      sends no positive radius.</p>
    <p>Keeping ${tex("r_{\\mathrm{min}}")} fixed while refining the mesh is
      what can make designs mesh-independent: the resolution improves, but the
      admissible member size does not shrink. Changing
      ${tex("r_{\\mathrm{min}}")} changes the problem and therefore the design.
      Mesh independence is a property to check, not a guarantee; see the
      <a href="#benchmarks">two-resolution benchmark</a>.</p>

    <h2 id="mma">Updating densities with MMA</h2>
    <p>The method of moving asymptotes (Svanberg 1987) is KoFEM’s only
      optimizer. At each iterate it replaces the objective and each constraint
      by a separable convex approximation built from the current values and
      gradients, bounded by moving asymptotes either side of each variable,
      and solves that subproblem exactly. The asymptotes widen while a variable
      keeps moving in one direction and contract when it oscillates.</p>
    <p>Each variable stays within ${tex("[ρ_{\\mathrm{min}},1]")} and may
      change by at most the move limit per iteration (default 0.2). Objective
      and constraints are normalized so they are of order one; compliance, for
      example, is divided by its first-iteration value. MMA was chosen over the
      simpler optimality-criteria update because one method then covers
      minimum compliance, minimum volume and stress constraints alike.</p>
    <p>Topology optimization problems are nonconvex. MMA finds a design that
      stops improving locally; it does not prove a global optimum. A different
      starting density, penalty, filter radius, move limit or mesh can produce
      a different layout of similar stiffness.</p>

    <h2 id="stress-constraint">Maximum-stress constraints</h2>
    <p>On all-solid models, either formulation can also require that the
      element-centre von Mises stress not exceed ${tex("σ_{\\mathrm{allow}}")}.
      Three standard devices make that tractable:</p>
    <ul>
      <li><strong>Relaxation.</strong> The constrained stress is
        ${tex("ρ_e^{p-q}σ_{\\mathrm{vm},e}^{0}")}, where ${tex("σ_{\\mathrm{vm},e}^{0}")}
        is the full-material stress of the element’s displacement and
        ${tex("q=p-0.5")} by default. Without it, vanishing elements
        create “singular” optima the optimizer cannot reach.</li>
      <li><strong>Aggregation.</strong> One P-norm (default ${tex("P=8")}) or
        Kreisselmeier–Steinhauser function (default ${tex("P=40")}) replaces
        one constraint per element. An adaptive factor scales it towards the
        true maximum, with a lag of one iteration.</li>
      <li><strong>Adjoint sensitivity.</strong> Stress is not self-adjoint, so
        each iteration adds a second linear solve.</li>
    </ul>
    <p>These runs use a density filter: the analysed density is the
      ${tex("H")}-weighted average of the design variables, and every gradient
      is chained back exactly. The density lower bound is
      ${tex("ρ_{\\mathrm{min}}=10^{-3}")} rather than 0. The constraint
      controls a relaxed, element-centre, aggregated measure. It does not
      bound the peak stress of a smoothed, re-meshed part, and it is not
      available for shell or coupled models.</p>

    <h2 id="termination">When a run stops</h2>
    <p>A run is reported as <em>converged</em> when the largest density change
      of an MMA step is below the tolerance (default 0.01) <em>and</em> the
      analysed design meets its limits within small slack: 0.5% on a
      compliance limit and on a volume cap that accompanies a stress limit, and
      2% on the true maximum relaxed stress. Otherwise it stops at the
      iteration limit (app default 50). A minimum-volume or stress-constrained run that
      ends above its limits returns its last design that met them. If no
      iteration ever met a stress limit, the run fails with an explicit error.</p>
    <p>A minimum-compliance run without a stress limit meets its volume
      constraint through MMA itself, so the stopping test there is the density
      change alone. Convergence therefore means “this design stopped moving
      and meets the stated limits”. It does not mean:</p>
    <ul>
      <li>the design is a global optimum, or that small densities have become
        exactly 0 or 1;</li>
      <li>the compliance has converged with mesh refinement;</li>
      <li>the part is strong, stable or manufacturable: compliance concerns
        stiffness under the chosen loads only.</li>
    </ul>
    <p>Satisfying the volume fraction says only how much material was used.
      Judge adequacy by re-analysing the interpreted shape; see
      <a href="/theory/optimization/interpreting-designs/#reanalysis">reanalysis</a>.</p>

    <h2 id="benchmarks">Check the MBB beam and mesh independence</h2>
    <p>The existing topology benchmarks run the shipped WebAssembly optimizer
      on structured hexahedral meshes. Their inputs are normalized:
      ${tex("E_0=1")}, ${tex("ν=0.3")} and a unit total load, so compliance
      is in the matching normalized work unit. They compare a run with
      published layouts and with itself under refinement; there is no
      closed-form optimum.</p>
    <p>The <strong>MBB beam</strong> is half of a simply supported beam with a
      central load, ${mbb.meshDims.L} long and ${mbb.meshDims.W} high and one
      element thick with out-of-plane motion fixed, so it behaves as a planar
      problem. It uses ${mbb.meshDims.nx} × ${mbb.meshDims.ny} elements,
      ${tex(`v_{\\mathrm{f}}=${mbb.settings.constraints.volumeFraction}`)},
      ${tex(`p=${mbb.settings.penalty}`)} and
      ${tex(`r_{\\mathrm{min}}=${mbb.settings.filterRadius}`)}
      (about 1.8 element widths). The <strong>cantilever</strong> is a
      ${mi.box.L} × ${mi.box.H} × ${mi.box.D} box fixed at one end, loaded along
      the bottom edge of the free end, optimized at
      ${tex(`v_{\\mathrm{f}}=${mi.coarse.settings.constraints.volumeFraction}`)}
      on two grids with the same ${tex(`r_{\\mathrm{min}}=${mi.coarse.settings.filterRadius}`)}.</p>
    ${table(
      "Executed topology-optimization benchmarks",
      [
        "Case",
        "Elements",
        "Iterations",
        "Compliance: start → end",
        "Final volume fraction",
      ],
      [
        [
          "MBB half-beam",
          count(mbb.elements),
          `${mbb.iterations}${mbb.converged ? ", converged" : ""}`,
          `${number(mbb.initialCompliance)} → ${number(mbb.finalCompliance)}`,
          number(mbb.finalVolumeFraction, 4),
        ],
        [
          "Cantilever, 10 × 5 × 5",
          count(mi.coarse.elements),
          `${mi.coarse.iterations}${mi.coarse.converged ? ", converged" : ""}`,
          `${number(mi.coarse.initialCompliance)} → ${number(mi.coarse.finalCompliance)}`,
          number(mi.coarse.finalVolumeFraction, 4),
        ],
        [
          "Cantilever, 20 × 10 × 10",
          count(mi.fine.elements),
          `${mi.fine.iterations}${mi.fine.converged ? ", converged" : ""}`,
          `${number(mi.fine.initialCompliance)} → ${number(mi.fine.finalCompliance)}`,
          number(mi.fine.finalVolumeFraction, 4),
        ],
      ],
    )}
    ${figure("mbb-half-beam-layout", "The recorded MBB half-beam densities, one square per element: black above 0.5, grey 0.25–0.5, white below 0.25. The symmetry plane is on the left, the load at its top and the roller at bottom right.")}
    <p>The MBB run reproduces the published layout: a compression chord along
      the top, a tension tie along the bottom and diagonals between them. Its
      compliance falls to ${number((100 * mbb.finalCompliance) / mbb.initialCompliance, 3)}%
      of the uniform start, and ${count(mbb.solidElements)} of
      ${count(mbb.elements)} elements end above 0.9 and
      ${count(mbb.voidElements)} below 0.1. The rest are gray.</p>
    <p>For the cantilever, the fine grid’s density is averaged onto the coarse
      grid. The two converged compliances differ by
      ${number(mi.complianceDifferencePercent, 3)}%, the density fields
      correlate at ${number(mi.densityCorrelation, 4)}, and the regions above
      0.5 overlap with an intersection-over-union of ${number(mi.solidIoU, 4)}.
      This shows the filter holding the layout fixed across one factor-2
      refinement of one problem on structured hexahedra. It does not establish
      mesh independence for unstructured Netgen tetrahedra, other filter radii,
      shells or stress-constrained runs.</p>
    <p>KoFEM’s automated tests rerun both benchmarks with their tolerance
      bands and compare them with the <a href="/theory/optimization.json">recorded numbers</a>. The public
      <a href="/examples/mbb-beam-topopt/">MBB beam example</a> solves the full
      beam from a STEP model on a Netgen mesh in the app.</p>

    <h2 id="references">Implementation and references</h2>
    <ol class="refs">
      <li>Sigmund (2001), <cite>A 99 line topology optimization code written in Matlab</cite>, Structural and Multidisciplinary Optimization 21, 120–127; and Andreassen et al. (2011), <cite>Efficient topology optimization in MATLAB using 88 lines of code</cite>, Structural and Multidisciplinary Optimization 43, 1–16.</li>
      <li>Svanberg (1987), <cite>The method of moving asymptotes — a new method for structural optimization</cite>, International Journal for Numerical Methods in Engineering 24, 359–373.</li>
      <li>Le, Norato, Bruns, Ha and Tortorelli (2010), <cite>Stress-based topology optimization for continua</cite>, Structural and Multidisciplinary Optimization 41, 605–620; and Bruggi (2008), <cite>On an alternative approach to stress constraints relaxation in topology optimization</cite>, Structural and Multidisciplinary Optimization 36, 125–141.</li>
      <li>${source("engine/cpp/topology_optimize.cpp", 222, "iteration loop")},
        ${source("engine/cpp/topology_optimize.cpp", 347, "stopping rule")},
        ${source("engine/cpp/topology_filter.cpp", 69, "sensitivity filter")},
        ${source("engine/cpp/topology_filter.cpp", 31, "default radius")},
        ${source("engine/cpp/topology_mma.cpp", 284, "MMA optimizer")},
        ${source("engine/cpp/topology_stress.cpp", 95, "relaxed, aggregated stress and adjoint")} and
        ${source("engine/cpp/topology_simp.cpp", 320, "stress density floor")}.</li>
      <li>${source("web/src/store/topOptSlice.ts", 72, "app defaults")} and
        ${source("examples/validation/topopt/README.md", 1, "benchmark descriptions and bands")}.</li>
    </ol>`,
};
