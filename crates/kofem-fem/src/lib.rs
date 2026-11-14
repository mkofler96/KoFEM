// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Linear-elastic finite elements for KoFEM: linear and quadratic tetrahedra
//! and hexahedra, Kirchhoff shell facets, sparse assembly, Dirichlet elimination,
//! surface-to-point couplings, constraint ties with dual mortar weights and a
//! preconditioned conjugate-gradient solve.
//! Pure Rust with no I/O or clock, so the same code runs natively under
//! `cargo test` and in the browser through `kofem-wasm`.
//!
//! MFEM attribution: this module reimplements the linear-elastic formulation
//! and iterative-solver approach used by KoFEM's MFEM-based engine. MFEM and
//! its contributors are the upstream numerical implementation reference.
//! See `../NOTICE.md` for source references and `../LICENSE-MFEM` for MFEM's
//! copyright notice and BSD-3-Clause terms, retained alongside KoFEM's license.

pub mod amg;
pub mod assembly;
pub mod cg;
pub mod constraints;
pub mod coupled_static;
pub mod coupling;
pub mod element;
pub mod error;
pub mod incomplete_cholesky;
pub mod material;
pub mod mesh;
pub mod mortar;
pub mod shell;
pub mod sparse;
pub mod static_solve;
pub mod stress;
pub mod surface;
pub mod tie;

pub use amg::{AmgSettings, LevelInfo, Preconditioner, SmoothedAggregation, SymmetricGaussSeidel};
pub use assembly::assemble_stiffness;
pub use cg::{solve_pcg, solve_pcg_with, CgOutcome, CgSettings, PcgRun, PcgStatus, StoppingRule};
pub use constraints::{apply_dirichlet, Dirichlet};
pub use coupled_static::{
    prepare_coupled_static, prepare_mixed_static, solve_coupled_static, solve_mixed_static,
    AppliedPreconditioner, CoupledReduction, CoupledSolution, MixedPreconditioner, PreparedCoupled,
    PreparedMixed, ShellPart,
};
pub use coupling::{Coupling, CouplingConstraints, CouplingKind, ALL_DOFS, DOFS_PER_NODE};
pub use error::FemError;
pub use incomplete_cholesky::IncompleteCholesky;
pub use material::Isotropic;
pub use mesh::{ElementOrder, ElementShape, TetMesh};
pub use mortar::{mortar_weights, MortarFace, MortarRow};
pub use shell::{
    assemble_shell_stiffness, prepare_shell_static, shell_translations, shell_von_mises,
    solve_shell_static, PreparedShell, ShellMesh, ShellPreconditioner, ShellSolution,
};
pub use sparse::CsrMatrix;
pub use static_solve::{
    prepare_static, solve_static, PreconditionerChoice, PreparedStatic, StaticSolution,
};
pub use stress::von_mises;
pub use surface::{BoundaryFaces, SurfaceLoadKind, SurfaceLoadReport};
pub use tie::{
    node_ties, prepare_tied_static, solve_tied_static, NodeTie, PreparedTied, TieReport,
    TiedSolution, VertexTies,
};
