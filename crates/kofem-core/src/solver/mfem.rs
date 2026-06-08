// Native MFEM bridge — not implemented yet.
// The production solver runs via the WASM build: see engine/cpp/engine.cpp.
use super::{FemResult, FemSolver, SolverError};
use crate::{BoundaryConditions, LinearElasticMaterial};
use kofem_mesh::VolumeMesh;

#[derive(Debug, Clone)]
pub struct MfemParams {
    /// FE polynomial order (1 = linear, 2 = quadratic).
    pub order: i32,
}

pub struct MfemSolver {
    params: MfemParams,
}

impl MfemSolver {
    pub fn new(params: MfemParams) -> Self {
        Self { params }
    }
}

impl FemSolver for MfemSolver {
    fn solve_linear_elastic(
        &self,
        _mesh: &VolumeMesh,
        _material: &LinearElasticMaterial,
        _bcs: &BoundaryConditions,
    ) -> Result<FemResult, SolverError> {
        let _ = &self.params;
        Err(SolverError::Internal(
            "Native MFEM solver is not yet implemented. \
             Use the WASM build produced by engine/cpp/engine.cpp via scripts/build-wasm.sh."
                .to_string(),
        ))
    }
}
