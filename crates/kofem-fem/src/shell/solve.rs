// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! One load case on an assembled shell stiffness matrix.

use crate::amg::{Preconditioner, SymmetricGaussSeidel};
use crate::cg::{solve_pcg_with, CgSettings};
use crate::constraints::{apply_dirichlet, Dirichlet};
use crate::error::FemError;
use crate::incomplete_cholesky::IncompleteCholesky;
use crate::shell::assembly::SHELL_NODE_DOFS;
use crate::shell::mesh::ShellMesh;
use crate::sparse::CsrMatrix;
use crate::static_solve::PreparedStatic;

/// The preconditioner a shell solve ended up with.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum ShellPreconditioner {
    /// IC(0) of K + shift·diag(K).
    IncompleteCholesky { shift: f64 },
    /// Every IC(0) shift broke down; one symmetric Gauss–Seidel sweep instead.
    SymmetricGaussSeidel,
}

/// A shell load case ready for CG, and the preconditioner it uses.
pub struct PreparedShell {
    pub prepared: PreparedStatic,
    pub preconditioner: ShellPreconditioner,
}

#[derive(Debug, Clone)]
pub struct ShellSolution {
    /// Six values per vertex (u, v, w, θx, θy, θz). Vertices no facet uses
    /// are held at zero.
    pub dofs: Vec<f64>,
    pub iterations: usize,
    pub relative_residual: f64,
    pub unused_vertices: usize,
    pub preconditioner: ShellPreconditioner,
}

/// Solve K·u = f with the given DOFs (6·vertex + component, component 0..5 =
/// u, v, w, θx, θy, θz) prescribed. `stiffness` is the matrix
/// `assemble_shell_stiffness` built for `mesh`; it is left unchanged.
///
/// # Errors
/// As [`prepare_shell_static`], plus a CG breakdown or non-convergence.
pub fn solve_shell_static(
    mesh: &ShellMesh,
    stiffness: &CsrMatrix,
    fixed_dofs: &[u32],
    fixed_values: &[f64],
    forces: &[f64],
    settings: CgSettings,
) -> Result<ShellSolution, FemError> {
    let PreparedShell {
        mut prepared,
        preconditioner,
    } = prepare_shell_static(mesh, stiffness, fixed_dofs, fixed_values, forces)?;
    let (dofs, outcome) = solve_pcg_with(prepared.system.as_mut(), &prepared.rhs, settings)?;
    Ok(ShellSolution {
        dofs,
        iterations: outcome.iterations,
        relative_residual: outcome.relative_residual,
        unused_vertices: prepared.unused_vertices,
        preconditioner,
    })
}

/// Check one shell load case and set it up for CG. Forces and moments are 6
/// per vertex. The preconditioner is IC(0), falling back to symmetric
/// Gauss–Seidel when no diagonal shift lets it factor — the C++ engine's
/// choice for shells.
///
/// # Errors
/// Malformed forces or constraints, a DOF constrained to two values, or a
/// support or load on a vertex no facet uses (it has no stiffness: a load
/// there would vanish).
pub fn prepare_shell_static(
    mesh: &ShellMesh,
    stiffness: &CsrMatrix,
    fixed_dofs: &[u32],
    fixed_values: &[f64],
    forces: &[f64],
) -> Result<PreparedShell, FemError> {
    let dof_count = SHELL_NODE_DOFS * mesh.vertex_count();
    if forces.len() != dof_count {
        return Err(FemError::ForceLength {
            len: forces.len(),
            count: dof_count,
        });
    }
    if let Some(&value) = forces.iter().find(|value| !value.is_finite()) {
        return Err(FemError::NonFinite {
            what: "a force or moment component",
            value,
        });
    }
    if fixed_dofs.len() != fixed_values.len() {
        return Err(FemError::ConstraintValueCount {
            dofs: fixed_dofs.len(),
            values: fixed_values.len(),
        });
    }
    for &dof in fixed_dofs {
        let vertex = dof as usize / SHELL_NODE_DOFS;
        if vertex < mesh.vertex_count() && !mesh.is_used(vertex) {
            return Err(FemError::ConstraintOnUnusedVertex { vertex });
        }
    }

    // Hold every unused vertex at zero, after checking nothing loads it.
    let mut dofs = fixed_dofs.to_vec();
    let mut values = fixed_values.to_vec();
    for vertex in (0..mesh.vertex_count()).filter(|&vertex| !mesh.is_used(vertex)) {
        let first = SHELL_NODE_DOFS * vertex;
        if forces[first..first + SHELL_NODE_DOFS]
            .iter()
            .any(|&force| force != 0.0)
        {
            return Err(FemError::LoadOnUnusedVertex { vertex });
        }
        for dof in first..first + SHELL_NODE_DOFS {
            #[allow(
                clippy::cast_possible_truncation,
                reason = "ShellMesh::new caps the vertex count at MAX_SHELL_VERTICES, so every DOF fits in u32"
            )]
            dofs.push(dof as u32);
            values.push(0.0);
        }
    }
    let constraints = Dirichlet::new(dof_count, &dofs, &values)?;

    let mut matrix = stiffness.clone();
    let mut rhs = forces.to_vec();
    apply_dirichlet(&mut matrix, &mut rhs, &constraints);
    let (system, preconditioner): (Box<dyn Preconditioner>, ShellPreconditioner) =
        match IncompleteCholesky::new(matrix) {
            Ok(factored) => {
                let shift = factored.shift();
                (
                    Box::new(factored),
                    ShellPreconditioner::IncompleteCholesky { shift },
                )
            }
            Err(matrix) => (
                Box::new(SymmetricGaussSeidel::new(matrix)),
                ShellPreconditioner::SymmetricGaussSeidel,
            ),
        };
    Ok(PreparedShell {
        prepared: PreparedStatic {
            system,
            rhs,
            levels: Vec::new(),
            unused_vertices: mesh.unused_vertex_count(),
        },
        preconditioner,
    })
}

/// The three translations of every vertex from a shell solution (six DOFs per
/// vertex), the layout the solid solve returns.
///
/// # Errors
/// [`FemError::DisplacementLength`] when `dofs` is not 6 per vertex.
pub fn shell_translations(mesh: &ShellMesh, dofs: &[f64]) -> Result<Vec<f64>, FemError> {
    let count = SHELL_NODE_DOFS * mesh.vertex_count();
    if dofs.len() != count {
        return Err(FemError::DisplacementLength {
            len: dofs.len(),
            count,
        });
    }
    // The length check above leaves no remainder.
    Ok(dofs
        .as_chunks::<SHELL_NODE_DOFS>()
        .0
        .iter()
        .flat_map(|node| [node[0], node[1], node[2]])
        .collect())
}
