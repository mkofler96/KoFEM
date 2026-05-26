//! `kofem-core` — MFEM-backed FEM solver.
//!
//! # Design
//!
//! The central abstraction is the [`FemSolver`] trait.  The default implementation
//! [`MfemSolver`] delegates to MFEM via an FFI bridge.  Alternative solvers can be
//! plugged in by implementing the same trait, allowing MFEM to be replaced
//! component-by-component as the project evolves.
//!
//! # Typical workflow
//!
//! ```ignore
//! let solver = MfemSolver::new(MfemParams { order: 1, ..Default::default() });
//! let result = solver.solve_linear_elastic(&volume_mesh, &material, &bcs)?;
//! ```

pub mod boundary;
pub mod material;
pub mod solver;

pub use boundary::BoundaryConditions;
pub use material::LinearElasticMaterial;
pub use solver::mfem::MfemSolver;
pub use solver::{FemResult, FemSolver, SolverError};
