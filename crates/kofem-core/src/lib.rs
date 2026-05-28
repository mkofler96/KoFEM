pub mod boundary;
pub mod material;
pub mod solver;

pub use boundary::BoundaryConditions;
pub use material::LinearElasticMaterial;
pub use solver::{FemResult, FemSolver, SolverError};
