// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! One linear-elastic load case on an assembled stiffness matrix.

use crate::amg::{
    AmgSettings, LevelInfo, Preconditioner, SmoothedAggregation, SymmetricGaussSeidel,
};
use crate::cg::{solve_pcg_with, CgSettings};
use crate::constraints::{eliminate_dirichlet, Dirichlet, EliminatedEntries};
use crate::error::FemError;
use crate::mesh::{ElementOrder, TetMesh};
use crate::sparse::CsrMatrix;
use crate::surface::BoundaryFaces;

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
/// side. An uncoupled solve works on the assembled matrix itself, not a copy,
/// and gives it back with [`PreparedStatic::into_stiffness`]. [`solve_static`] solves it in one go; the browser module advances a
/// [`crate::cg::PcgRun`] on it in steps instead.
pub struct PreparedStatic {
    pub system: Box<dyn Preconditioner>,
    pub rhs: Vec<f64>,
    /// Multigrid levels, finest first; empty for Gauss–Seidel.
    pub levels: Vec<LevelInfo>,
    pub unused_vertices: usize,
    /// What the supports overwrote in the assembled matrix, for
    /// [`PreparedStatic::into_stiffness`]; `None` on a coupled, tied or mixed
    /// solve, whose system is a reduction of it.
    pub eliminated: Option<EliminatedEntries>,
}

impl PreparedStatic {
    /// Entries kept of the assembled matrix (0 on a reduced system).
    #[must_use]
    pub fn eliminated_entries(&self) -> usize {
        self.eliminated.as_ref().map_or(0, EliminatedEntries::len)
    }

    /// The assembled matrix the solve took, given back exactly as it was
    /// handed in: the system's matrix with the supports' entries restored.
    ///
    /// # Errors
    /// [`FemError::ReducedSystem`] on a coupled, tied or mixed solve, whose
    /// system is a reduction, not the assembled matrix.
    pub fn into_stiffness(self) -> Result<CsrMatrix, FemError> {
        let eliminated = self.eliminated.ok_or(FemError::ReducedSystem)?;
        let mut matrix = self.system.into_matrix();
        eliminated.restore(&mut matrix);
        Ok(matrix)
    }
}

/// Solve K·u = f with the given DOFs (3·node + component) prescribed. On a
/// quadratic mesh a condition on every corner of a boundary face extends to
/// the face's edge and face nodes (see [`prepare_static`]).
/// `stiffness` is the matrix `assemble_stiffness` built for `mesh`; it is left
/// unchanged, so it can serve further load cases — at the price of a copy.
/// To solve without one, hand the matrix to [`prepare_static`].
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
        stiffness.clone(),
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

/// Check one load case and set it up for CG (see [`PreparedStatic`]). The
/// solve takes `stiffness` and eliminates the supports in place, keeping the
/// entries they overwrite so that [`PreparedStatic::into_stiffness`] can give
/// the assembled matrix back.
///
/// On a quadratic mesh, vertex conditions extend to the nodes of the
/// supported boundary faces: where every corner of a boundary face (a tet
/// triangle or a hex quadrilateral) prescribes the same component, its edge
/// nodes get it too, at the mean of the edge's two ends, and a hex face node
/// at the mean of the face's four corners — exact for a clamped face or a
/// uniform or linear prescribed displacement. An edge through the interior
/// stays free even when both its ends are held (where two supported faces
/// meet, or across a wall supported on both sides), as does an edge with only
/// one end constrained (the border of a support) and every hex centre node.
/// A node DOF the caller prescribes itself keeps the caller's value.
///
/// # Errors
/// Malformed forces or constraints, a support or load on a vertex no element
/// uses (it has no stiffness: a load there would vanish), or a multigrid
/// setup that finds the model under-constrained.
pub fn prepare_static(
    mesh: &TetMesh,
    stiffness: CsrMatrix,
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
    extend_to_boundary_nodes(mesh, 3, fixed_dofs, fixed_values, &mut dofs, &mut values);
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

    let mut matrix = stiffness;
    let mut rhs = forces.to_vec();
    let eliminated = eliminate_dirichlet(&mut matrix, &mut rhs, &constraints);
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
        eliminated: Some(eliminated),
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

/// Append to `dofs`/`values` the conditions the given vertex conditions imply
/// for the edge and face nodes of the supported boundary faces (see
/// [`prepare_static`]). DOFs are numbered `node_dofs`·node + component, with
/// the translations as components 0–2; other components and DOFs out of range
/// are left for the caller to check. Nothing on a linear mesh.
pub(crate) fn extend_to_boundary_nodes(
    mesh: &TetMesh,
    node_dofs: usize,
    fixed_dofs: &[u32],
    fixed_values: &[f64],
    dofs: &mut Vec<u32>,
    values: &mut Vec<f64>,
) {
    if mesh.order() == ElementOrder::Linear {
        return;
    }
    // First value per node translation; a conflicting second value is refused
    // later by the caller's constraint check, so which one is kept does not
    // matter. Conditions added here go in too, so a node on several supported
    // faces is extended once.
    let mut prescribed = vec![[None::<f64>; 3]; mesh.node_count()];
    for (&dof, &value) in fixed_dofs.iter().zip(fixed_values) {
        let (node, component) = (dof as usize / node_dofs, dof as usize % node_dofs);
        if let Some(slot) = prescribed.get_mut(node).filter(|_| component < 3) {
            slot[component].get_or_insert(value);
        }
    }
    BoundaryFaces::new(mesh).for_each_higher_order_node(mesh, |corners, node, between| {
        let node = node as usize;
        for component in 0..3 {
            let held = |vertex: &u32| prescribed[*vertex as usize][component];
            if prescribed[node][component].is_some()
                || !corners.iter().all(|vertex| held(vertex).is_some())
            {
                continue;
            }
            let sum: f64 = between.iter().filter_map(held).sum();
            #[allow(
                clippy::cast_precision_loss,
                reason = "an edge has two ends and a face four corners"
            )]
            let value = sum / between.len() as f64;
            prescribed[node][component] = Some(value);
            #[allow(
                clippy::cast_possible_truncation,
                reason = "callers cap the node count so that every DOF fits in u32"
            )]
            dofs.push((node_dofs * node + component) as u32);
            values.push(value);
        }
    });
}
