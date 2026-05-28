use crate::{BoundaryConditions, LinearElasticMaterial};
use kofem_mesh::VolumeMesh;
use thiserror::Error;

/// Output of a completed linear-elastic FEM solve.
#[derive(Debug, Clone)]
pub struct FemResult {
    /// Displacement vector: 3 components per vertex in the same order as `VolumeMesh::vertices`.
    pub displacements: Vec<f64>,
    /// Von-Mises stress: one scalar per element.
    pub von_mises: Vec<f64>,
}

#[derive(Debug, Error)]
pub enum SolverError {
    #[error("mesh is invalid or empty: {0}")]
    InvalidMesh(String),
    #[error("boundary conditions are inconsistent: {0}")]
    BadBoundaryConditions(String),
    #[error("solver did not converge: {0}")]
    DidNotConverge(String),
    #[error("internal solver error: {0}")]
    Internal(String),
}

/// Trait that decouples the FEM solver backend from the rest of the pipeline.
pub trait FemSolver: Send + Sync {
    fn solve_linear_elastic(
        &self,
        mesh: &VolumeMesh,
        material: &LinearElasticMaterial,
        bcs: &BoundaryConditions,
    ) -> Result<FemResult, SolverError>;
}
