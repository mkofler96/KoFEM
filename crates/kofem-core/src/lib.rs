// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

pub mod boundary;
pub mod material;
pub mod solver;

pub use boundary::BoundaryConditions;
pub use material::LinearElasticMaterial;
pub use solver::{FemResult, FemSolver, SolverError};
