// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Linear-elastic finite elements for KoFEM: element stiffness, sparse
//! assembly, Dirichlet elimination and a preconditioned conjugate-gradient
//! solve. Pure Rust with no I/O or clock, so the same code runs natively under
//! `cargo test` and in the browser through `kofem-wasm`.

pub mod assembly;
pub mod cg;
pub mod constraints;
pub mod element;
pub mod error;
pub mod material;
pub mod mesh;
pub mod sparse;

pub use assembly::assemble_stiffness;
pub use cg::{solve_pcg, CgOutcome, CgSettings};
pub use constraints::{apply_dirichlet, Dirichlet};
pub use error::FemError;
pub use material::Isotropic;
pub use mesh::TetMesh;
pub use sparse::CsrMatrix;
