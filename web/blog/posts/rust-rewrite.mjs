// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Measurements: PR #534 at f14481b. MFEM notices: 3a94800.
export default {
  slug: "rewriting-kofem-solver-in-rust",
  title: "Rewriting KoFEM’s finite-element solver in Rust",
  description:
    "A first Rust solver module: numerical agreement with MFEM, faster assembly, and the convergence work that comes next.",
  date: "2026-11-08",
  author: "Michael Kofler",
  body: `
    <p class="lede">We are beginning to move KoFEM’s finite-element code from C++ to Rust. The first
module implements linear-elastic tetrahedral analysis, produces displacements
that closely match the existing MFEM-based solver, and reduces computation time
in the reported comparisons.</p>

    <p><a href="https://github.com/mkofler96/KoFEM/pull/534">Pull request #534</a> introduces this
first implementation. The application does not call the Rust module yet. This
gives us a way to evaluate its numerical behavior before changing the solver
that users rely on.</p>

    <p>The starting point is <a href="https://mfem.org/">MFEM</a>, the C++ finite-element library
used by KoFEM’s current solid solver. The Rust work reimplements a limited part
of that numerical approach, with MFEM as the upstream implementation reference
and comparison solver. We credit MFEM and its contributors for that foundation.
Its BSD 3-Clause copyright notice, license conditions, and disclaimer remain
with the relevant source and distributed module.</p>

    <p>The useful question for this rewrite is how a smaller implementation behaves
on the problems KoFEM needs to solve. We therefore begin with a defined subset,
compare it on identical inputs, and use the results to identify the next steps.</p>

    <h2 id="a-separate-module-for-the-numerical-work">A separate module for the numerical work</h2>

    <p>KoFEM runs its analysis pipeline in the browser. The existing C++ engine uses
OpenCASCADE for CAD geometry, Netgen for volume meshing, and MFEM for the solid
finite-element analysis. The Rust module operates on the resulting mesh.</p>

    <p>The proposed division is straightforward: the C++ engine provides mesh data,
TypeScript passes the mesh, supports, and loads to Rust, and Rust returns the
displacements. The connection uses typed arrays between two WebAssembly modules.
The existing geometry and meshing tools remain part of this pipeline.</p>

    <figure class="blog-pipeline">
      <div role="group" aria-label="Proposed pipeline from CAD and mesh through typed arrays to finite elements">
        <div><strong>CAD and mesh</strong><small>C++ · OCCT · Netgen</small></div>
        <span class="blog-arrow" aria-hidden="true">→</span>
        <div><strong>Typed arrays</strong><small>TypeScript worker</small></div>
        <span class="blog-arrow" aria-hidden="true">→</span>
        <div><strong>Finite elements</strong><small>Rust · WebAssembly</small></div>
      </div>
      <figcaption>The proposed module boundary. The app continues to use its existing MFEM solver while the Rust implementation is evaluated.</figcaption>
    </figure>

    <p>The Rust implementation has two components. <code>kofem-fem</code> contains the element
formulation, sparse assembly, displacement constraints, and iterative solver.
<code>kofem-wasm</code> provides the browser interface. The numerical core has no browser
dependency, so the same code can run in native tests and through WebAssembly.</p>

    <p>Assembly and solution are separate operations. This allows their costs to be
measured independently and permits reuse of the assembled stiffness matrix for
several load cases. The current scope is linear elasticity with four-node
tetrahedra; shell analysis, coupled models, and the wider MFEM feature set remain
outside this first module.</p>

    <h2 id="establishing-numerical-agreement">Establishing numerical agreement</h2>

    <p>For a static linear-elastic problem, the assembled system relates nodal forces
to displacements:</p>

    <div class="equation" tabindex="0" role="region" aria-label="Static equilibrium: K times u equals f">
      <math display="block"><mi mathvariant="bold">K</mi><mi mathvariant="bold">u</mi><mo>=</mo><mi mathvariant="bold">f</mi></math>
    </div>

    <p>Here, <code>K</code> is the stiffness matrix, <code>u</code> contains the nodal displacements, and <code>f</code>
contains the applied forces. Prescribed displacements modify this system before
the iterative solution. Each of these stages must behave consistently with the
existing implementation.</p>

    <p>The comparisons use the same mesh, supports, and loads in both solvers. Both
use conjugate gradients with one symmetric Gauss–Seidel sweep as a
preconditioner and a relative tolerance of <code>1e-6</code> in the preconditioned residual
norm. Keeping these choices aligned makes the comparison more informative than
changing the implementation and numerical method together.</p>

    <p>For the model sweep, meshes are generated through OpenCASCADE and Netgen at
two densities. Each case clamps the first 2% of its longest axis and applies a
1 kN transverse load to the last 2%. These are controlled comparison setups
rather than the intended service loads for every part.</p>

    <p>For the benchmark cases in which both solvers converged, the reported maximum
displacement differences range from approximately <code>3e-10</code> to <code>2e-7</code>, normalized
by the largest MFEM displacement. A separate tetrahedral cantilever comparison
reports agreement of <code>1.7e-10</code>.</p>

    <p>This agreement supports consistency between the implementations for the tested
problems. Physical accuracy also depends on the model, boundary conditions, and
discretization. Two solvers can agree closely on the same mesh while sharing
its approximation error.</p>

    <p>Native tests provide additional checks: element symmetry, rigid-body modes, an
exact patch test, and a bar compared with Hooke’s law. These tests examine
properties that a timing comparison alone cannot establish.</p>

    <h2 id="faster-assembly-with-a-smaller-overall-gain">Faster assembly, with a smaller overall gain</h2>

    <p>The timings reported in the PR show an assembly-and-solve speed-up between
1.11× and 1.68× across the fourteen cases where both implementations converged.
The following selection shows the variation with geometry and mesh size.</p>

    <div class="table-wrap" tabindex="0" role="region" aria-label="Benchmark comparison; scroll horizontally for all columns">
      <table><caption>Selected assembly-and-solve timings reported in Bun</caption>
        <thead><tr><th scope="col">Model</th><th scope="col" class="num">Tetrahedra</th><th scope="col" class="num">MFEM</th><th scope="col" class="num">Rust</th><th scope="col" class="num">Speed-up</th></tr></thead>
        <tbody><tr><th scope="row">Tube</th><td class="num">6,300</td><td class="num">0.24 s</td><td class="num">0.15 s</td><td class="num">1.68×</td></tr>
          <tr><th scope="row">I-beam</th><td class="num">36,900</td><td class="num">3.77 s</td><td class="num">2.71 s</td><td class="num">1.39×</td></tr>
          <tr><th scope="row">NIST CTC 05</th><td class="num">208,000</td><td class="num">39.6 s</td><td class="num">31.0 s</td><td class="num">1.28×</td></tr>
          <tr><th scope="row">New bracket 2</th><td class="num">442,000</td><td class="num">192 s</td><td class="num">169 s</td><td class="num">1.14×</td></tr></tbody>
      </table>
    </div>

    <p>These measurements were taken in Bun. A separate headless Chromium comparison
on a 148,000-tetrahedron model reports 14.6 seconds for MFEM and 9.3 seconds for
Rust. Runtime therefore also matters when evaluating browser performance.</p>

    <p>Assembly is reported to be four to eight times faster. The overall gain is
smaller because the conjugate-gradient iterations take most of the remaining
time, particularly for large or thin-walled models. Improving assembly further
will have limited effect when the iterative solution dominates.</p>

    <p>These results describe the two implementations and tested configurations. They
do not isolate the programming language as the cause of the difference. The PR
provides the benchmark setup and full table; the measurements above are taken
from that report.</p>

    <h2 id="convergence-determines-the-next-step">Convergence determines the next step</h2>

    <p>Two thin-walled cases reach the MFEM configuration’s 5,000-iteration limit. The
Rust runs converge after approximately 7,300 iterations with a larger budget.
Those runs are excluded from the speed-up range because the iteration limits
differ.</p>

    <p>Their behavior identifies a limitation of the current numerical setup. A
preconditioner helps the iterative solver reach a solution in fewer steps. One
symmetric Gauss–Seidel sweep leaves these cases requiring thousands of steps,
so reducing the cost of an individual iteration addresses only part of the
problem. Algebraic multigrid is the planned next investigation.</p>

    <h2 id="real-meshes-also-test-error-handling">Real meshes also test error handling</h2>

    <p>The model comparisons exposed vertices that Netgen generated but no
tetrahedron used. Their stiffness rows were empty, and the first Rust version
trapped when the preconditioner tried to access a missing diagonal entry.</p>

    <p>The module now holds these unused vertices at zero displacement, matching the
MFEM output, and reports their number. A support or load attached to one is
rejected explicitly. An unused vertex has no connection to an element, so
accepting a load there would allow that load to disappear from the structural
problem.</p>

    <p>This is part of the numerical implementation’s responsibility. Correct element
matrices are necessary, and meaningful input checks are also needed to ensure
that the system being solved represents the intended model.</p>

    <h2 id="continuing-the-migration">Continuing the migration</h2>

    <p>The first Rust module provides a limited implementation that can be tested
natively and compared with the existing engine in WebAssembly. Its measured
assembly cost is lower, its displacements closely match MFEM on the reported
cases, and the comparisons identify preconditioning as the next performance
question.</p>

    <p>Further work must address convergence and application integration before this
module can replace the current solid-solver path. Throughout that work, MFEM
remains both an upstream foundation to credit and a numerical reference against
which to evaluate the changes.</p>

    <p>_Implementation and measurements: <a href="https://github.com/mkofler96/KoFEM/pull/534">KoFEM PR #534</a>,
source snapshot <code>f14481b</code>, 8 November 2026. The
<a href="https://github.com/mkofler96/KoFEM/blob/3a948006b52914508e81476a98d7051be76d1584/crates/kofem-fem/NOTICE.md">MFEM notice</a>
records the attribution, source references, and retained license terms._</p>

    <p class="meta">Sources: <a href="https://github.com/mkofler96/KoFEM/pull/534">implementation and benchmark report</a>;
      <a href="https://github.com/mkofler96/KoFEM/blob/3a948006b52914508e81476a98d7051be76d1584/crates/kofem-fem/NOTICE.md">MFEM attribution and retained license notices</a>.</p>`,
};
