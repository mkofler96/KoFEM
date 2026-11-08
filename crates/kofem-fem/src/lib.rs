// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Linear-elastic finite elements for KoFEM: element stiffness, sparse
//! assembly, Dirichlet elimination and a preconditioned conjugate-gradient
//! solve. Pure Rust with no I/O or clock, so the same code runs natively under
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
pub mod element;
pub mod error;
pub mod material;
pub mod mesh;
pub mod sparse;
pub mod static_solve;
pub mod stress;
pub mod surface;

pub use amg::{AmgSettings, LevelInfo, Preconditioner, SmoothedAggregation, SymmetricGaussSeidel};
pub use assembly::assemble_stiffness;
pub use cg::{solve_pcg, solve_pcg_with, CgOutcome, CgSettings, PcgRun, PcgStatus, StoppingRule};
pub use constraints::{apply_dirichlet, Dirichlet};
pub use error::FemError;
pub use material::Isotropic;
pub use mesh::TetMesh;
pub use sparse::CsrMatrix;
pub use static_solve::{
    prepare_static, solve_static, PreconditionerChoice, PreparedStatic, StaticSolution,
};
pub use stress::von_mises;
pub use surface::{BoundaryFaces, SurfaceLoadKind, SurfaceLoadReport};
