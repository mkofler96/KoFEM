// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! One linear-elastic load case on an assembled stiffness matrix.

use crate::amg::{
    AmgSettings, LevelInfo, Preconditioner, SmoothedAggregation, SymmetricGaussSeidel,
};
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
    /// Displacement per node, x,y,z interleaved: the vertices first, then any
    /// edge nodes. Vertices no element uses are held at zero;
    /// `unused_vertices` says how many there were.
    pub displacements: Vec<f64>,
    pub iterations: usize,
    pub relative_residual: f64,
    pub unused_vertices: usize,
    /// Multigrid levels (unknowns, non-zeros), finest first; empty for
    /// Gauss–Seidel.
    pub levels: Vec<LevelInfo>,
}

/// A load case ready for CG: the stiffness with its Dirichlet conditions
/// eliminated, inside the chosen preconditioner, and the matching right-hand
/// side. [`solve_static`] solves it in one go; the browser module advances a
/// [`crate::cg::PcgRun`] on it in steps instead.
pub struct PreparedStatic {
    pub system: Box<dyn Preconditioner>,
    pub rhs: Vec<f64>,
    /// Multigrid levels, finest first; empty for Gauss–Seidel.
    pub levels: Vec<LevelInfo>,
    pub unused_vertices: usize,
}

/// Solve K·u = f with the given DOFs (3·node + component) prescribed. On a
/// quadratic mesh a condition on both ends of an edge extends to its edge
/// node (see [`prepare_static`]).
/// `stiffness` is the matrix `assemble_stiffness` built for `mesh`; it is left
/// unchanged, so it can serve further load cases.
///
/// # Errors
/// As [`prepare_static`], plus a CG breakdown or non-convergence.
pub fn solve_static(
    mesh: &TetMesh,
    stiffness: &CsrMatrix,
    fixed_dofs: &[u32],
    fixed_values: &[f64],
    forces: &[f64],
    settings: CgSettings,
    preconditioner: PreconditionerChoice,
) -> Result<StaticSolution, FemError> {
    let mut prepared = prepare_static(
        mesh,
        stiffness,
        fixed_dofs,
        fixed_values,
        forces,
        preconditioner,
    )?;
    let (displacements, outcome) =
        solve_pcg_with(prepared.system.as_mut(), &prepared.rhs, settings)?;
    Ok(StaticSolution {
        displacements,
        iterations: outcome.iterations,
        relative_residual: outcome.relative_residual,
        unused_vertices: prepared.unused_vertices,
        levels: prepared.levels,
    })
}

/// Check one load case and set it up for CG (see [`PreparedStatic`]).
///
/// On a quadratic mesh, the MFEM engine's rule extends vertex conditions to
/// the edge nodes: where both ends of an edge prescribe the same component,
/// the edge node gets it too, at the mean of the two values — exact for a
/// clamped face or a uniform or linear prescribed displacement. An edge with
/// only one end constrained (the border of a support) stays free, and an edge
/// node DOF the caller prescribes itself keeps the caller's value. The face
/// and centre nodes of 27-node hexes get no condition: the MFEM engine leaves
/// a hex face's centre DOF free as well, so a support on a hex face holds its
/// corners and edge nodes only. Prescribe a face node explicitly to hold it.
///
/// # Errors
/// Malformed forces or constraints, a support or load on a vertex no element
/// uses (it has no stiffness: a load there would vanish), or a multigrid
/// setup that finds the model under-constrained.
pub fn prepare_static(
    mesh: &TetMesh,
    stiffness: &CsrMatrix,
    fixed_dofs: &[u32],
    fixed_values: &[f64],
    forces: &[f64],
    preconditioner: PreconditionerChoice,
) -> Result<PreparedStatic, FemError> {
    let dof_count = mesh.dof_count();
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
    if fixed_dofs.len() != fixed_values.len() {
        return Err(FemError::ConstraintValueCount {
            dofs: fixed_dofs.len(),
            values: fixed_values.len(),
        });
    }
    for &dof in fixed_dofs {
        let node = dof as usize / 3;
        if node < mesh.node_count() && !mesh.is_used(node) {
            return Err(FemError::ConstraintOnUnusedVertex { vertex: node });
        }
    }

    let mut dofs = fixed_dofs.to_vec();
    let mut values = fixed_values.to_vec();
    extend_to_edge_nodes(mesh, fixed_dofs, fixed_values, &mut dofs, &mut values);
    // Hold every unused vertex at zero, after checking nothing loads it.
    for vertex in (0..mesh.vertex_count()).filter(|&vertex| !mesh.is_used(vertex)) {
        if forces[3 * vertex..3 * vertex + 3]
            .iter()
            .any(|&force| force != 0.0)
        {
            return Err(FemError::LoadOnUnusedVertex { vertex });
        }
        for component in 0..3 {
            dofs.push(dof_number(vertex, component));
            values.push(0.0);
        }
    }
    let constraints = Dirichlet::new(dof_count, &dofs, &values)?;

    let mut matrix = stiffness.clone();
    let mut rhs = forces.to_vec();
    apply_dirichlet(&mut matrix, &mut rhs, &constraints);
    let (system, levels): (Box<dyn Preconditioner>, Vec<LevelInfo>) = match preconditioner {
        PreconditionerChoice::SymmetricGaussSeidel => {
            (Box::new(SymmetricGaussSeidel::new(matrix)), Vec::new())
        }
        PreconditionerChoice::SmoothedAggregation(amg_settings) => {
            let constrained: Vec<bool> = (0..dof_count)
                .map(|dof| constraints.value(dof).is_some())
                .collect();
            let amg = SmoothedAggregation::new(
                matrix,
                mesh.node_coordinates(),
                &constrained,
                amg_settings,
            )?;
            let levels = amg.levels();
            (Box::new(amg), levels)
        }
    };
    Ok(PreparedStatic {
        system,
        rhs,
        levels,
        unused_vertices: mesh.unused_vertex_count(),
    })
}

/// DOF number of `component` at `node`.
fn dof_number(node: usize, component: usize) -> u32 {
    #[allow(
        clippy::cast_possible_truncation,
        reason = "TetMesh caps the node count at MAX_NODES, so every DOF fits in u32"
    )]
    let dof = (3 * node + component) as u32;
    dof
}

/// Append to `dofs`/`values` the edge-node conditions implied by the given
/// vertex conditions (see [`prepare_static`]). Nothing on a linear mesh.
fn extend_to_edge_nodes(
    mesh: &TetMesh,
    fixed_dofs: &[u32],
    fixed_values: &[f64],
    dofs: &mut Vec<u32>,
    values: &mut Vec<f64>,
) {
    if mesh.edges().is_empty() {
        return;
    }
    // First value per node component; a conflicting second value is refused
    // later by `Dirichlet::new`, so which one is kept does not matter.
    let mut prescribed = vec![[None::<f64>; 3]; mesh.node_count()];
    for (&dof, &value) in fixed_dofs.iter().zip(fixed_values) {
        let (node, component) = (dof as usize / 3, dof as usize % 3);
        if let Some(slot) = prescribed.get_mut(node) {
            slot[component].get_or_insert(value);
        }
    }
    for (edge, &[first, second]) in mesh.edges().iter().enumerate() {
        let node = mesh.vertex_count() + edge;
        let (lhs, rhs) = (prescribed[first as usize], prescribed[second as usize]);
        for (component, own) in prescribed[node].iter().enumerate() {
            if let (None, Some(lhs), Some(rhs)) = (own, lhs[component], rhs[component]) {
                dofs.push(dof_number(node, component));
                values.push(f64::midpoint(lhs, rhs));
            }
        }
    }
}
