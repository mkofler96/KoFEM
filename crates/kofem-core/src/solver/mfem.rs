// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

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

#[cfg(test)]
mod tests {
    use super::*;

    fn single_tetrahedron() -> VolumeMesh {
        VolumeMesh {
            vertices: vec![
                [0.0, 0.0, 0.0],
                [1.0, 0.0, 0.0],
                [0.0, 1.0, 0.0],
                [0.0, 0.0, 1.0],
            ],
            tetrahedra: vec![[0, 1, 2, 3]],
        }
    }

    #[test]
    fn solve_reports_missing_native_bridge() {
        let solver: Box<dyn FemSolver> = Box::new(MfemSolver::new(MfemParams { order: 1 }));
        let mut bcs = BoundaryConditions::default();
        bcs.fix_vertex(0);
        bcs.fix_vertex(1);
        bcs.fix_vertex(2);
        bcs.apply_force(3, [0.0, 0.0, -1.0]);

        let result = solver.solve_linear_elastic(
            &single_tetrahedron(),
            &LinearElasticMaterial::steel(),
            &bcs,
        );
        match result {
            Err(SolverError::Internal(msg)) => assert!(msg.contains("WASM build")),
            Err(other) => panic!("expected Internal, got {other:?}"),
            Ok(_) => panic!("native MFEM bridge must not report success"),
        }
    }
}
