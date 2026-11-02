# Theory Guide content map

**Status:** authoring plan

**Solver reviewed:** `9274be29cfdd82ece266e63ac487358b2f551b57` (2026-11-02)

**Production implementation:** `engine/cpp/` (C++ compiled to WASM), not the
deferred Rust stubs in `crates/`

This map fixes the initial reading order and URLs. A page should answer its one
main question; supporting topics belong on linked pages. Published URLs must
not encode issue numbers or sequence numbers, so pages can move in navigation
without breaking links.

## Navigation and stable URLs

`/theory/` is the guide index. Article slugs below are permanent once
published. Renames require redirects and preserved heading anchors.

| Section                | Stable URL                                           | Main question                                                                                              |
| ---------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Foundations            | `/theory/foundations/model-and-units/`               | What makes a useful finite element model?                                                                  |
| Foundations            | `/theory/foundations/consistent-units/`              | Which combinations of units can be used together in a finite element model?                                |
| Foundations            | `/theory/foundations/reading-a-study/`               | How do geometry, materials, constraints, loads, the FEM discretisation, and results form one study?        |
| Notation and operators | `/theory/notation/`                                  | What do the shared symbols, indices, coordinate conventions, and units mean?                               |
| Notation and operators | `/theory/operators/gradient-divergence/`             | How do gradient, symmetric gradient, and divergence connect displacement, strain, stress, and equilibrium? |
| Notation and operators | `/theory/operators/tensor-products/`                 | Which products keep directions, and which reduce them to a scalar?                                         |
| Notation and operators | `/theory/operators/integration-by-parts/`            | Why can equilibrium be expressed using first derivatives of displacement?                                  |
| Notation and operators | `/theory/operators/reference-mapping/`               | How can the same shape functions and integration points work on different elements?                        |
| Solid mechanics        | `/theory/solid-mechanics/linear-elasticity/`         | Which assumptions lead from displacement to isotropic linear-elastic stress?                               |
| Solid mechanics        | `/theory/solid-mechanics/equilibrium-and-weak-form/` | Why does KoFEM solve the weak form instead of pointwise equilibrium?                                       |
| Numerical methods      | `/theory/numerical-methods/elements-and-quadrature/` | How are the displacement field and element integrals approximated?                                         |
| Numerical methods      | `/theory/numerical-methods/assembly/`                | How do element contributions become the global linear system?                                              |
| Numerical methods      | `/theory/numerical-methods/loads-and-constraints/`   | How do supported load and displacement conditions enter that system?                                       |
| Numerical methods      | `/theory/numerical-methods/linear-solve/`            | How is the linear system solved, and what do tolerance and non-convergence mean?                           |
| Results                | `/theory/results/displacement-and-stress/`           | How are nodal displacement and element von Mises stress produced and displayed?                            |
| Results                | `/theory/results/interpretation-and-convergence/`    | Which conclusions are justified by a result, and when must the FEM discretisation be refined?              |
| Verification           | `/theory/verification/axial-bar/`                    | Does the complete KoFEM path reproduce the analytical extension of a bar in tension?                       |
| Verification           | `/theory/verification/strategy/`                     | What does each benchmark establish, and what remains unverified?                                           |
| Shells (later)         | `/theory/shells/formulation/`                        | How does KoFEM's flat-facet shell represent membrane and bending response?                                 |
| Shells (later)         | `/theory/shells/solid-coupling/`                     | How are shell and solid degrees of freedom coupled?                                                        |
| Optimization (later)   | `/theory/optimization/simp/`                         | How does SIMP turn a solid FEM problem into a density optimization problem?                                |
| Optimization (later)   | `/theory/optimization/constraints-and-convergence/`  | How should filtering, constraints, convergence, and optimized results be interpreted?                      |

The initial verified path ends at the axial-bar page. The strategy page can
then branch to other existing benchmarks. Shell/coupling and optimization stay
visible in the map but are explicitly later extensions, not implied support in
the initial solid guide.

## Running example: axial bar in tension

Use the existing **Axial bar in tension** validation case where the initial
guide needs implementation or verification evidence. General introductions
may use standalone physical models and worked calculations; they do not need
to follow a KoFEM example. The model introduction uses a generic bar, while
unit-system comparisons have their own linked page.

- Fixture: `examples/validation/cases/axial-bar.mjs`
- Published page: `/examples/axial-bar/`
- Reproducible solve: `node examples/validation/run.mjs --case axial-bar`
- Reference: the closed-form small-strain result
  `delta = P L / (E A)` for a prismatic bar under uniform axial traction
- Current inputs: `L = 1000 mm`, `A = 100 mm x 100 mm`,
  `E = 210000 MPa`, `nu = 0.3`, and `P = 1.0e6 N`
- Current analytical extension: `delta = 0.476190476... mm`
- Readout: mean x-displacement on the loaded end (the public result summary
  also exposes the maximum `Ux` for this uniform end face)

This case is preferred because it is small, has an analytical reference, uses
the real WASM solid solver, and is already a generated public example and CI
regression fixture. It exercises material stiffness, a fixed support, a face
force converted to work-equivalent traction, assembly, solve, and displacement
recovery. It does **not** verify general stress recovery, bending, quadratic
elements, shells, coupling, or optimization; those claims need their own
examples.

## Reviewed implementation inventory

The inventory below records what was supported at the reviewed revision. Each
article must review its narrower claims again and update its own revision.

| Formulation or behavior            | Production source                                                                                 | Scope at reviewed revision                                                                                                                                                                                    |
| ---------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 3D isotropic linear-elastic solids | `engine/cpp/solve_mfem.cpp`, `engine/cpp/fem_mesh_io.cpp`, `engine/cpp/fem_bc_io.cpp`             | MFEM H1 displacement formulation on tetrahedra/hexahedra; order 1 or 2; per-body material attributes; fixed and prescribed translational DOFs; nodal and boundary loads; CG with Gauss-Seidel preconditioning |
| Solid result recovery              | `engine/cpp/solve_mfem.cpp`                                                                       | Vertex translations and element-centre von Mises stress                                                                                                                                                       |
| Flat-facet Kirchhoff shells        | `engine/cpp/solve_shell.cpp`, `engine/cpp/shell_core.cpp`, `engine/cpp/shell_element.cpp`         | Triangular surface discretisation, six DOFs per node internally, membrane and bending response, scalar or per-facet thickness, force/moment loads, prescribed DOFs, surface von Mises stress                  |
| Mixed solid–shell analysis         | `engine/cpp/solve_coupled.cpp`, `engine/cpp/coupling_constraints.cpp`                             | MFEM solid stiffness plus shell assembly and distributing, relaxed, kinematic, or shell-footprint coupling constraints                                                                                        |
| Shell idealisation pipeline        | `web/src/lib/shellize/`                                                                           | Browser-side mid-surface and mixed-discretisation construction feeding shell/coupled solves                                                                                                                   |
| SIMP topology optimization         | `engine/cpp/topology_simp.cpp`, `engine/cpp/topology_optimize.cpp`, `engine/cpp/topology_mma.cpp` | Density-based optimization with filtering/MMA and optional stress handling; later-guide topic                                                                                                                 |
| Level-set and shell topology paths | `engine/cpp/topology_levelset.cpp`, `engine/cpp/topology_shell.cpp`                               | Separate later-guide topics; do not infer their equations from the SIMP page                                                                                                                                  |
| Public examples and verification   | `examples/validation/`, `examples/gallery/`, `web/examples/`                                      | Real WASM solves compared with analytical or published references; generated static pages and app fixtures                                                                                                    |

Geometry display tessellation is not an FEM discretisation. The guide must call
tetrahedral/hexahedral volume and triangular shell data the FEM discretisation,
and reserve _tessellation_ for display geometry.

## Units audit

The app's canonical coherent system at the reviewed revision is:

| Quantity                                             | Unit          |
| ---------------------------------------------------- | ------------- |
| Length, displacement, shell thickness                | mm            |
| Force                                                | N             |
| Moment                                               | N·mm          |
| Young's modulus, pressure, stress                    | MPa = N/mm²   |
| Mass (stored, not used by the current static solver) | tonne         |
| Poisson's ratio, strain                              | dimensionless |

The solver performs no dimensional conversion: coordinates, section sizes,
material values, loads, and displayed results must already be coherent. CAD
and mesh formats do not make inconsistent user inputs coherent. Articles must
state units beside every dimensional input and must not describe the engine as
unit-aware. Density is currently stored for future gravity/inertial behavior
and must not be presented as active in static equilibrium.

Evidence for these conventions lives in `web/src/store/materialSlice.ts`,
`web/src/lib/resultField.ts`, `web/src/store/boundaryGroups.ts`, and
`examples/validation/lib/app-model.mjs`.

## Notation audit and conflicts to avoid

The published [notation reference](../../web/theory/notation.mjs) owns the symbol definitions
and permanent anchors. Use these authoring rules:

| Meaning                           | Preferred notation                           | Conflict found / rule                                                                                                                                                                                        |
| --------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Position and displacement         | **x**, **u**; components `u_x`, `u_y`, `u_z` | UI labels are `Ux`, `Uy`, `Uz`; show that mapping once. Do not use `u` for a test function.                                                                                                                  |
| Test displacement                 | **w**                                        | Many FEM texts use **v**, but `v` is also a vertex/node variable in implementation and commonly velocity. State the chosen convention.                                                                       |
| Strain and Cauchy stress          | **epsilon**, **sigma**                       | Implementation uses `eps`, `s`, and `von_mises`; distinguish tensor **sigma** from scalar `sigma_vm`.                                                                                                        |
| Young's modulus                   | `E`                                          | `e` also denotes an element index in code. Use `e` only as a subscripted element index and never as modulus.                                                                                                 |
| Poisson's ratio                   | `nu`                                         | Source uses `nu`/`poisson`; do not substitute `v`, which is visually ambiguous with Latin v.                                                                                                                 |
| Pressure and polynomial order     | `p_load`, `k`                                | The UI/source uses pressure `p`, while FEM literature often calls polynomial order `p` (P1/P2). In prose say “order 1/2”; reserve `p` locally only after qualification.                                      |
| Body force, traction, point force | **b**, **t**, **P**                          | Do not collapse a face force group, pressure, and nodal force into one symbol; explain their different assembly routes.                                                                                      |
| Boundary pieces                   | `Gamma_D`, `Gamma_N`                         | “Fixed face,” selected CAD face, and discretisation boundary facets are different objects. Define which is meant.                                                                                            |
| Nodes, vertices, and DOFs         | `a`, `i`, `d` as declared locally            | The code uses vertex indices, while UI copy may say nodes. State that an FEM node owns DOFs; do not imply a display-tessellation vertex is one.                                                              |
| Von Mises value                   | `sigma_vm`                                   | Solid recovery is per element at its centre; shell recovery is per facet at the worse surface. The UI may average values for visualization, so do not call the displayed smooth field a nodal solve unknown. |
| Area and stiffness matrix         | `A`, **K**                                   | In the axial formula `A` is area; elsewhere code may use `A` for the assembled matrix. Use **K** for global stiffness in guide equations.                                                                    |

Every article defines local symbols at first use and links them to
`/theory/notation/#<symbol-anchor>`. Accessible math needs accompanying prose;
meaning must not depend on color or a rendered glyph alone.

## Ownership and maintenance

- Public theory pages and this map live with website code and change in the
  same PR as implementation behavior they describe.
- Each article records the exact reviewed solver commit and source links. A
  later code change updates affected pages or opens a follow-up issue.
- Linear owns sequencing and ADRs. An article may summarize an established
  decision but links the Linear ADR rather than becoming a competing record.
- Generated example pages remain owned by the validation/gallery generators;
  theory pages link to them instead of copying their results by hand.
- New pages start from [`article-template.md`](article-template.md). A reviewer
  checks the question, assumptions, units, limitations, source
  trace, links, and revision before publication.

## Authoring and PR conventions

Do not add prerequisite lists or labels to public articles. Explain needed
concepts in context and link related pages when useful.

Teach general FEM concepts directly. Add KoFEM workflows, examples and pinned
implementation details when relevant to the claims; conceptual introductions
do not require those sections. Keep unit-system comparison on the separate
`/theory/foundations/consistent-units/` page, using
[Ansys LS-DYNA](https://lsdyna.ansys.com/consistent-units/) as a reference.
The general comparison does not imply automatic unit conversion in KoFEM.

All Theory work branches from and targets `develop` (the development/dev
channel). The repository branch is named `develop`, not `dev`; never target
Theory PRs at `main`. The shared clarification is also recorded on KOF-278
and KOF-280 through KOF-290 in Linear.
