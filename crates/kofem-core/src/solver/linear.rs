//! Linear static solver: [K]{u} = {f}
//! Uses Cholesky decomposition for SPD global stiffness matrix.

use crate::boundary::BoundaryConditions;
use crate::mesh::Mesh;
use alloc::vec::Vec;
use nalgebra::{DMatrix, DVector};

#[derive(Debug)]
pub struct LinearStaticResult {
    pub displacements: Vec<f64>,
}

pub struct LinearStaticSolver;

impl LinearStaticSolver {
    /// Assemble and solve the linear system.
    /// Returns nodal displacements (n_dof values, 6 per node).
    pub fn solve(mesh: &Mesh, bcs: &BoundaryConditions) -> Result<LinearStaticResult, SolverError> {
        let n = mesh.n_dof();
        let mut k_global = DMatrix::<f64>::zeros(n, n);
        let mut f_global = DVector::<f64>::zeros(n);

        // TODO: loop elements, assemble element stiffness into k_global
        // This requires element dispatch — wired up once element impls are complete.

        // Apply nodal loads
        for load in &bcs.nodal_loads {
            let row = load.node_id * 6 + load.dof as usize;
            f_global[row] += load.value;
        }

        // Apply homogeneous Dirichlet BCs via penalty method
        // (Switch to elimination for production quality)
        let penalty = k_global.diagonal().max() * 1e14;
        for bc in &bcs.constraints {
            let row = bc.node_id * 6 + bc.dof as usize;
            k_global[(row, row)] = penalty;
            f_global[row] = penalty * bc.prescribed_value;
        }

        // Solve via Cholesky (positive definite after BCs)
        let chol = k_global
            .clone()
            .cholesky()
            .ok_or(SolverError::NotPositiveDefinite)?;
        let u = chol.solve(&f_global);

        Ok(LinearStaticResult {
            displacements: u.as_slice().to_vec(),
        })
    }
}

#[derive(Debug, thiserror::Error)]
pub enum SolverError {
    #[error("Global stiffness matrix is not positive definite — check boundary conditions")]
    NotPositiveDefinite,
    #[error("Singular stiffness matrix — model may be under-constrained")]
    Singular,
}
