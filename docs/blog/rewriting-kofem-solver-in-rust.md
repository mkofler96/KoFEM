# Rewriting KoFEM’s finite-element solver in Rust

We are beginning to move KoFEM’s finite-element code from C++ to Rust. The first
module implements linear-elastic tetrahedral analysis, produces displacements
that closely match the existing MFEM-based solver, and reduces computation time
in the reported comparisons.

[Pull request #534](https://github.com/mkofler96/KoFEM/pull/534) introduces this
first implementation. The application does not call the Rust module yet. This
gives us a way to evaluate its numerical behavior before changing the solver
that users rely on.

The starting point is [MFEM](https://mfem.org/), the C++ finite-element library
used by KoFEM’s current solid solver. The Rust work reimplements a limited part
of that numerical approach, with MFEM as the upstream implementation reference
and comparison solver. We credit MFEM and its contributors for that foundation.
Its BSD 3-Clause copyright notice, license conditions, and disclaimer remain
with the relevant source and distributed module.

The useful question for this rewrite is how a smaller implementation behaves
on the problems KoFEM needs to solve. We therefore begin with a defined subset,
compare it on identical inputs, and use the results to identify the next steps.

## A separate module for the numerical work

KoFEM runs its analysis pipeline in the browser. The existing C++ engine uses
OpenCASCADE for CAD geometry, Netgen for volume meshing, and MFEM for the solid
finite-element analysis. The Rust module operates on the resulting mesh.

The proposed division is straightforward: the C++ engine provides mesh data,
TypeScript passes the mesh, supports, and loads to Rust, and Rust returns the
displacements. The connection uses typed arrays between two WebAssembly modules.
The existing geometry and meshing tools remain part of this pipeline.

The Rust implementation has two components. `kofem-fem` contains the element
formulation, sparse assembly, displacement constraints, and iterative solver.
`kofem-wasm` provides the browser interface. The numerical core has no browser
dependency, so the same code can run in native tests and through WebAssembly.

Assembly and solution are separate operations. This allows their costs to be
measured independently and permits reuse of the assembled stiffness matrix for
several load cases. The current scope is linear elasticity with four-node
tetrahedra; shell analysis, coupled models, and the wider MFEM feature set remain
outside this first module.

## Establishing numerical agreement

For a static linear-elastic problem, the assembled system relates nodal forces
to displacements:

```text
K u = f
```

Here, `K` is the stiffness matrix, `u` contains the nodal displacements, and `f`
contains the applied forces. Prescribed displacements modify this system before
the iterative solution. Each of these stages must behave consistently with the
existing implementation.

The comparisons use the same mesh, supports, and loads in both solvers. Both
use conjugate gradients with one symmetric Gauss–Seidel sweep as a
preconditioner and a relative tolerance of `1e-6` in the preconditioned residual
norm. Keeping these choices aligned makes the comparison more informative than
changing the implementation and numerical method together.

For the model sweep, meshes are generated through OpenCASCADE and Netgen at
two densities. Each case clamps the first 2% of its longest axis and applies a
1 kN transverse load to the last 2%. These are controlled comparison setups
rather than the intended service loads for every part.

For the benchmark cases in which both solvers converged, the reported maximum
displacement differences range from approximately `3e-10` to `2e-7`, normalized
by the largest MFEM displacement. A separate tetrahedral cantilever comparison
reports agreement of `1.7e-10`.

This agreement supports consistency between the implementations for the tested
problems. Physical accuracy also depends on the model, boundary conditions, and
discretization. Two solvers can agree closely on the same mesh while sharing
its approximation error.

Native tests provide additional checks: element symmetry, rigid-body modes, an
exact patch test, and a bar compared with Hooke’s law. These tests examine
properties that a timing comparison alone cannot establish.

## Faster assembly, with a smaller overall gain

The timings reported in the PR show an assembly-and-solve speed-up between
1.11× and 1.68× across the fourteen cases where both implementations converged.
The following selection shows the variation with geometry and mesh size.

| Model         | Tetrahedra |   MFEM |   Rust | Speed-up |
| ------------- | ---------: | -----: | -----: | -------: |
| Tube          |      6,300 | 0.24 s | 0.15 s |    1.68× |
| I-beam        |     36,900 | 3.77 s | 2.71 s |    1.39× |
| NIST CTC 05   |    208,000 | 39.6 s | 31.0 s |    1.28× |
| New bracket 2 |    442,000 |  192 s |  169 s |    1.14× |

These measurements were taken in Bun. A separate headless Chromium comparison
on a 148,000-tetrahedron model reports 14.6 seconds for MFEM and 9.3 seconds for
Rust. Runtime therefore also matters when evaluating browser performance.

Assembly is reported to be four to eight times faster. The overall gain is
smaller because the conjugate-gradient iterations take most of the remaining
time, particularly for large or thin-walled models. Improving assembly further
will have limited effect when the iterative solution dominates.

These results describe the two implementations and tested configurations. They
do not isolate the programming language as the cause of the difference. The PR
provides the benchmark setup and full table; the measurements above are taken
from that report.

## Convergence determines the next step

Two thin-walled cases reach the MFEM configuration’s 5,000-iteration limit. The
Rust runs converge after approximately 7,300 iterations with a larger budget.
Those runs are excluded from the speed-up range because the iteration limits
differ.

Their behavior identifies a limitation of the current numerical setup. A
preconditioner helps the iterative solver reach a solution in fewer steps. One
symmetric Gauss–Seidel sweep leaves these cases requiring thousands of steps,
so reducing the cost of an individual iteration addresses only part of the
problem. Algebraic multigrid is the planned next investigation.

## Real meshes also test error handling

The model comparisons exposed vertices that Netgen generated but no
tetrahedron used. Their stiffness rows were empty, and the first Rust version
trapped when the preconditioner tried to access a missing diagonal entry.

The module now holds these unused vertices at zero displacement, matching the
MFEM output, and reports their number. A support or load attached to one is
rejected explicitly. An unused vertex has no connection to an element, so
accepting a load there would allow that load to disappear from the structural
problem.

This is part of the numerical implementation’s responsibility. Correct element
matrices are necessary, and meaningful input checks are also needed to ensure
that the system being solved represents the intended model.

## Continuing the migration

The first Rust module provides a limited implementation that can be tested
natively and compared with the existing engine in WebAssembly. Its measured
assembly cost is lower, its displacements closely match MFEM on the reported
cases, and the comparisons identify preconditioning as the next performance
question.

Further work must address convergence and application integration before this
module can replace the current solid-solver path. Throughout that work, MFEM
remains both an upstream foundation to credit and a numerical reference against
which to evaluate the changes.

_Implementation and measurements: [KoFEM PR #534](https://github.com/mkofler96/KoFEM/pull/534),
source snapshot `f14481b`, 8 November 2026. The
[MFEM notice](https://github.com/mkofler96/KoFEM/blob/3a948006b52914508e81476a98d7051be76d1584/crates/kofem-fem/NOTICE.md)
records the attribution, source references, and retained license terms._
