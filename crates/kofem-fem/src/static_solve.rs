// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! One linear-elastic load case on an assembled stiffness matrix.

use crate::amg::{AmgSettings, SmoothedAggregation, SymmetricGaussSeidel};
use crate::cg::{solve_pcg_with, CgSettings};
use crate::constraints::{apply_dirichlet, Dirichlet};
use crate::error::FemError;
use crate::mesh::TetMesh;
use crate::sparse::CsrMatrix;

/// Which preconditioner the CG solve uses.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum PreconditionerChoice {
    /// One symmetric Gauss–Seidel sweep — the MFEM engine's method.
    SymmetricGaussSeidel,
    /// Smoothed-aggregation algebraic multigrid, one V-cycle.
    SmoothedAggregation(AmgSettings),
}

#[derive(Debug, Clone)]
pub struct StaticSolution {
    /// Displacement per vertex, x,y,z interleaved. Vertices no element uses
    /// are held at zero; `unused_vertices` says how many there were.
    pub displacements: Vec<f64>,
    pub iterations: usize,
    pub relative_residual: f64,
    pub unused_vertices: usize,
    /// Multigrid levels (unknowns, non-zeros), finest first; empty for
    /// Gauss–Seidel.
    pub levels: Vec<crate::amg::LevelInfo>,
}

/// Solve K·u = f with the given DOFs (3·vertex + component) prescribed.
/// `stiffness` is the matrix `assemble_stiffness` built for `mesh`; it is left
/// unchanged, so it can serve further load cases.
///
/// # Errors
/// Malformed forces or constraints, a support or load on a vertex no element
/// uses (it has no stiffness: a load there would vanish), or a CG breakdown or
/// non-convergence.
pub fn solve_static(
    mesh: &TetMesh,
    stiffness: &CsrMatrix,
    fixed_dofs: &[u32],
    fixed_values: &[f64],
    forces: &[f64],
    settings: CgSettings,
    preconditioner: PreconditionerChoice,
) -> Result<StaticSolution, FemError> {
    let dof_count = 3 * mesh.vertex_count();
    if forces.len() != dof_count {
        return Err(FemError::ForceLength {
            len: forces.len(),
            count: dof_count,
        });
    }
    if let Some(&value) = forces.iter().find(|value| !value.is_finite()) {
        return Err(FemError::NonFinite {
            what: "a force component",
            value,
        });
    }
    for &dof in fixed_dofs {
        let vertex = dof as usize / 3;
        if vertex < mesh.vertex_count() && !mesh.is_used(vertex) {
            return Err(FemError::ConstraintOnUnusedVertex { vertex });
        }
    }

    // Hold every unused vertex at zero, after checking nothing loads it.
    let mut dofs = fixed_dofs.to_vec();
    let mut values = fixed_values.to_vec();
    for vertex in (0..mesh.vertex_count()).filter(|&vertex| !mesh.is_used(vertex)) {
        if forces[3 * vertex..3 * vertex + 3]
            .iter()
            .any(|&force| force != 0.0)
        {
            return Err(FemError::LoadOnUnusedVertex { vertex });
        }
        for component in 0..3 {
            #[allow(
                clippy::cast_possible_truncation,
                reason = "TetMesh::new caps the vertex count at MAX_VERTICES, so every DOF fits in u32"
            )]
            dofs.push((3 * vertex + component) as u32);
            values.push(0.0);
        }
    }
    if fixed_dofs.len() != fixed_values.len() {
        return Err(FemError::ConstraintValueCount {
            dofs: fixed_dofs.len(),
            values: fixed_values.len(),
        });
    }
    let constraints = Dirichlet::new(dof_count, &dofs, &values)?;

    let mut matrix = stiffness.clone();
    let mut rhs = forces.to_vec();
    apply_dirichlet(&mut matrix, &mut rhs, &constraints);
    let (displacements, outcome, levels) = match preconditioner {
        PreconditionerChoice::SymmetricGaussSeidel => {
            let (solution, outcome) = solve_pcg_with(
                &matrix,
                &rhs,
                settings,
                &mut SymmetricGaussSeidel::new(&matrix),
            )?;
            (solution, outcome, Vec::new())
        }
        PreconditionerChoice::SmoothedAggregation(amg_settings) => {
            let constrained: Vec<bool> = (0..dof_count)
                .map(|dof| constraints.value(dof).is_some())
                .collect();
            let mut amg =
                SmoothedAggregation::new(&matrix, mesh.vertices(), &constrained, amg_settings)?;
            let levels = amg.levels();
            let (solution, outcome) = solve_pcg_with(&matrix, &rhs, settings, &mut amg)?;
            (solution, outcome, levels)
        }
    };
    Ok(StaticSolution {
        displacements,
        iterations: outcome.iterations,
        relative_residual: outcome.relative_residual,
        unused_vertices: mesh.unused_vertex_count(),
        levels,
    })
}
