# MFEM attribution

KoFEM's Rust finite-element module is based on the linear-elastic formulation
and iterative-solver approach used by KoFEM's existing
[MFEM](https://mfem.org/) engine. We credit MFEM and its contributors as the
upstream implementation reference for this work.

The Rust module reimplements a limited subset: linear and quadratic
tetrahedral (4- and 10-node) and hexahedral (8- and 27-node) elasticity,
surface loads, sparse assembly, prescribed displacements, and preconditioned
conjugate gradients. MFEM remains the numerical reference used in the
comparison tests. This module does not provide MFEM's full feature set.

## Upstream references

The following references identify the numerical implementations, rather than
claiming a line-for-line translation. They are pinned to MFEM v4.7, commit
`dc9128ef596e84daf1138aa3046b826bba9d259f`, the version selected by the
KoFEM-Dependencies builder:

| KoFEM source     | MFEM reference                                                                                                                                                                                                                                                                                                                                                        |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/element.rs` | [`ElasticityIntegrator::AssembleElementMatrix`, `fem/bilininteg.cpp`](https://github.com/mfem/mfem/blob/dc9128ef596e84daf1138aa3046b826bba9d259f/fem/bilininteg.cpp#L3033)                                                                                                                                                                                            |
| `src/element.rs` | [`IsoparametricTransformation::OrderGrad`, `fem/eltrans.cpp`](https://github.com/mfem/mfem/blob/dc9128ef596e84daf1138aa3046b826bba9d259f/fem/eltrans.cpp#L467) and [`IntegrationRules::CubeIntegrationRule`, `fem/intrules.cpp`](https://github.com/mfem/mfem/blob/dc9128ef596e84daf1138aa3046b826bba9d259f/fem/intrules.cpp#L1849): the hexahedron integration rules |
| `src/surface.rs` | [`VectorBoundaryLFIntegrator::AssembleRHSElementVect`, `fem/lininteg.cpp`](https://github.com/mfem/mfem/blob/dc9128ef596e84daf1138aa3046b826bba9d259f/fem/lininteg.cpp#L375): the quadrilateral face integration rule                                                                                                                                                 |
| `src/cg.rs`      | [`CGSolver::Mult`, `linalg/solvers.cpp`](https://github.com/mfem/mfem/blob/dc9128ef596e84daf1138aa3046b826bba9d259f/linalg/solvers.cpp#L718), including the preconditioned residual stopping rule                                                                                                                                                                     |
| `src/sparse.rs`  | [`SparseMatrix::Gauss_Seidel_forw` and `Gauss_Seidel_back`, `linalg/sparsemat.cpp`](https://github.com/mfem/mfem/blob/dc9128ef596e84daf1138aa3046b826bba9d259f/linalg/sparsemat.cpp#L2443)                                                                                                                                                                            |

## Copyright and license

MFEM copyright (c) 2010-2024, Lawrence Livermore National Security, LLC.
All rights reserved. MFEM is distributed under the BSD 3-Clause License.
The complete upstream copyright notice, conditions, and disclaimer are
retained verbatim in [LICENSE-MFEM](LICENSE-MFEM).

KoFEM's additions are copyright 2026 Michael Kofler and licensed under
AGPL-3.0-or-later. MFEM's copyright and BSD-3-Clause conditions remain
applicable to MFEM-derived portions; the KoFEM license does not replace them.
Retain this notice and LICENSE-MFEM when redistributing the module.

The WASM build copies both files alongside the generated module. The web
distribution also includes the upstream license at `/licenses/mfem.txt`.
Attribution does not imply endorsement by MFEM or its contributors.
