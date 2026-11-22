// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Support reactions of a solved load case, summed per support (KOF-387).
//!
//! The reaction at a DOF is the force (or moment) the support applies there,
//! `K·u − f`: zero at a free DOF up to the solver tolerance. On a coupled,
//! tied or mixed solve the residual is taken through the coupling reduction
//! ([`crate::CoupledReduction::mixed_reactions`]), so a dependent DOF's share
//! reaches the DOF it follows. On a quadratic mesh the added nodes' values are
//! folded onto the vertices ([`fold_onto_vertices`]), so a support, which
//! names vertices, gets the reactions of the edge nodes it holds too.
//!
//! [`summarize_reactions`] sums the reactions of each support's DOFs: the
//! resultant force, and the resultant moment about the support's centroid
//! (the nodal moments plus the lever arm of each nodal force). Next to them
//! it sums the applied loads, so the caller can check that the reactions
//! balance them.

use crate::coupling::DOFS_PER_NODE;
use crate::error::FemError;
use crate::mesh::{cross, sub, ElementOrder, TetMesh};
use crate::sparse::CsrMatrix;

/// The resultant reaction of one support.
#[derive(Debug, Clone, PartialEq)]
pub struct SupportReaction {
    /// Σ of the support's nodal reaction forces.
    pub force: [f64; 3],
    /// Resultant moment about `centroid`: the nodal reaction moments plus
    /// (x − centroid) × nodal force.
    pub moment: [f64; 3],
    /// Mean of the vertices the support holds; the origin when it holds none.
    pub centroid: [f64; 3],
    /// Vertices the support holds in this solve; 0 when none of its nodes
    /// reached it.
    pub vertices: usize,
}

/// Every support's reaction, and the applied loads they should balance.
#[derive(Debug, Clone, PartialEq)]
pub struct ReactionSummary {
    pub supports: Vec<SupportReaction>,
    /// Σ of every applied nodal force.
    pub applied: [f64; 3],
    /// Σ of the applied forces on DOFs a support holds: load that goes
    /// straight into the support without loading the structure.
    pub applied_on_supports: [f64; 3],
}

/// `K·u − f` for one stiffness matrix and a displacement and force vector
/// of its numbering: the nodal reactions of an uncoupled solve.
///
/// # Errors
/// [`FemError::ReactionInput`] when a vector does not fit the matrix.
pub fn nodal_residual(
    stiffness: &CsrMatrix,
    dofs: &[f64],
    forces: &[f64],
) -> Result<Vec<f64>, FemError> {
    let rows = stiffness.rows();
    if dofs.len() != rows || forces.len() != rows {
        return Err(FemError::ReactionInput {
            reason: format!(
                "{} displacements and {} forces for a stiffness of {rows} rows",
                dofs.len(),
                forces.len()
            ),
        });
    }
    let mut residual = vec![0.0; rows];
    stiffness.mul_vec(dofs, &mut residual);
    for (value, force) in residual.iter_mut().zip(forces) {
        *value -= force;
    }
    Ok(residual)
}

/// Three translations per node widened to six DOFs per node, the rotations
/// zero. A trailing partial triple is kept as far as it goes.
#[must_use]
pub fn widen_translations(values: &[f64]) -> Vec<f64> {
    let mut wide = vec![0.0; DOFS_PER_NODE * values.len().div_ceil(3)];
    for (dof, &value) in values.iter().enumerate() {
        wide[DOFS_PER_NODE * (dof / 3) + dof % 3] = value;
    }
    wide
}

/// Six values per node of `mesh` (vertices first, then any added nodes)
/// folded onto its vertices, six per vertex: each edge node's values split
/// equally between its two ends, each hex face node's among the face's four
/// corners, each hex centre's among the hex's eight corners. Every added node
/// sits at the mean of the corners it splits among, so the fold keeps both
/// the sum and the moment about any point. A linear mesh's values come back
/// unchanged.
///
/// # Errors
/// [`FemError::ReactionInput`] when `values` is not six per node.
pub fn fold_onto_vertices(mesh: &TetMesh, values: &[f64]) -> Result<Vec<f64>, FemError> {
    let expected = DOFS_PER_NODE * mesh.node_count();
    if values.len() != expected {
        return Err(FemError::ReactionInput {
            reason: format!(
                "{} values for {} nodes; expected {DOFS_PER_NODE} per node",
                values.len(),
                mesh.node_count()
            ),
        });
    }
    let vertex_count = mesh.vertex_count();
    let mut folded = values[..DOFS_PER_NODE * vertex_count].to_vec();
    let mut spread = |node: usize, corners: &[u32]| {
        #[allow(
            clippy::cast_precision_loss,
            reason = "an added node splits among at most eight corners"
        )]
        let share = 1.0 / corners.len() as f64;
        for &corner in corners {
            for component in 0..DOFS_PER_NODE {
                folded[DOFS_PER_NODE * corner as usize + component] +=
                    share * values[DOFS_PER_NODE * node + component];
            }
        }
    };
    let mut node = vertex_count;
    for edge in mesh.edges() {
        spread(node, edge);
        node += 1;
    }
    for face in mesh.faces() {
        spread(node, face);
        node += 1;
    }
    if mesh.order() == ElementOrder::Quadratic {
        for hex in mesh.hexes() {
            spread(node, hex);
            node += 1;
        }
    }
    Ok(folded)
}

/// Σ of the forces in `forces` (six per node of `mesh`, vertices first) that
/// act on a held translation, in the solve's own numbering: on a vertex, a
/// component its `owners` entry (six per vertex) gives to a support; on an
/// added node of a quadratic mesh, a component every corner it lies between
/// holds — the rule by which a support reaches the edge and face nodes of the
/// faces it holds; a hex centre node is never held. Folding the loads first would count half of a free edge
/// node's load as on a support whenever one of its ends is held.
///
/// # Errors
/// [`FemError::ReactionInput`] when `forces` is not six per node or `owners`
/// not six per vertex.
pub fn load_on_held_nodes(
    mesh: &TetMesh,
    forces: &[f64],
    owners: &[i32],
) -> Result<[f64; 3], FemError> {
    if forces.len() != DOFS_PER_NODE * mesh.node_count()
        || owners.len() != DOFS_PER_NODE * mesh.vertex_count()
    {
        return Err(FemError::ReactionInput {
            reason: format!(
                "{} forces and {} owners for {} nodes and {} vertices; expected \
                 {DOFS_PER_NODE} per node and per vertex",
                forces.len(),
                owners.len(),
                mesh.node_count(),
                mesh.vertex_count()
            ),
        });
    }
    let held =
        |vertex: u32, component: usize| owners[DOFS_PER_NODE * vertex as usize + component] >= 0;
    let mut total = [0.0; 3];
    let mut add = |node: usize, corners: &[u32]| {
        for (component, sum) in total.iter_mut().enumerate() {
            if corners.iter().all(|&corner| held(corner, component)) {
                *sum += forces[DOFS_PER_NODE * node + component];
            }
        }
    };
    #[allow(
        clippy::cast_possible_truncation,
        reason = "TetMesh caps the node count at MAX_NODES, so every vertex fits in u32"
    )]
    for vertex in 0..mesh.vertex_count() {
        add(vertex, &[vertex as u32]);
    }
    let mut node = mesh.vertex_count();
    for edge in mesh.edges() {
        add(node, edge);
        node += 1;
    }
    for face in mesh.faces() {
        add(node, face);
        node += 1;
    }
    // A hex centre is never held: no support reaches inside an element.
    Ok(total)
}

/// Sum the nodal reactions of each support. `reactions` and `forces` hold
/// six values per vertex of `vertices` (forces, then moments); `owners` six
/// per vertex too, the support (0..`supports`) that holds each DOF, or −1.
/// A rotation no support names but whose vertex a support holds in some
/// other DOF counts for that support: a solve can hold a rotation the user
/// did not name (a shell node clamped in its translations), and a free
/// rotation's reaction is zero anyway.
///
/// # Errors
/// [`FemError::ReactionInput`] for arrays that are not six per vertex, or an
/// owner outside −1..`supports`.
pub fn summarize_reactions(
    vertices: &[[f64; 3]],
    reactions: &[f64],
    forces: &[f64],
    owners: &[i32],
    supports: usize,
) -> Result<ReactionSummary, FemError> {
    let expected = DOFS_PER_NODE * vertices.len();
    for (name, len) in [
        ("reactions", reactions.len()),
        ("forces", forces.len()),
        ("owners", owners.len()),
    ] {
        if len != expected {
            return Err(FemError::ReactionInput {
                reason: format!(
                    "{len} {name} for {} vertices; expected {DOFS_PER_NODE} per vertex",
                    vertices.len()
                ),
            });
        }
    }
    let owned = owner_table(owners, supports)?;

    let mut sums = vec![[0.0; 3]; supports];
    let mut counts = vec![0usize; supports];
    for (vertex, row) in owned.iter().enumerate() {
        let mut seen: Vec<usize> = row.iter().flatten().copied().collect();
        seen.sort_unstable();
        seen.dedup();
        for support in seen {
            counts[support] += 1;
            for axis in 0..3 {
                sums[support][axis] += vertices[vertex][axis];
            }
        }
    }
    let mut result: Vec<SupportReaction> = sums
        .iter()
        .zip(&counts)
        .map(|(sum, &count)| {
            #[allow(
                clippy::cast_precision_loss,
                reason = "a vertex count is far below 2^52"
            )]
            let centroid = if count == 0 {
                [0.0; 3]
            } else {
                sum.map(|value| value / count as f64)
            };
            SupportReaction {
                force: [0.0; 3],
                moment: [0.0; 3],
                centroid,
                vertices: count,
            }
        })
        .collect();

    let mut applied = [0.0; 3];
    let mut applied_on_supports = [0.0; 3];
    for (vertex, row) in owned.iter().enumerate() {
        let at = DOFS_PER_NODE * vertex;
        for axis in 0..3 {
            applied[axis] += forces[at + axis];
        }
        for (component, owner) in row.iter().enumerate() {
            let Some(support) = *owner else { continue };
            let value = reactions[at + component];
            let reaction = &mut result[support];
            if component < 3 {
                reaction.force[component] += value;
                let mut nodal = [0.0; 3];
                nodal[component] = value;
                let arm = cross(sub(vertices[vertex], reaction.centroid), nodal);
                for axis in 0..3 {
                    reaction.moment[axis] += arm[axis];
                }
                applied_on_supports[component] += forces[at + component];
            } else {
                reaction.moment[component - 3] += value;
            }
        }
    }
    Ok(ReactionSummary {
        supports: result,
        applied,
        applied_on_supports,
    })
}

/// Each vertex's DOF owners from the flat `owners` (6 per vertex, −1 for
/// none), with unnamed rotations going to the first support that holds the
/// vertex (see [`summarize_reactions`]).
fn owner_table(
    owners: &[i32],
    supports: usize,
) -> Result<Vec<[Option<usize>; DOFS_PER_NODE]>, FemError> {
    let owner_of = |dof: usize| -> Result<Option<usize>, FemError> {
        match usize::try_from(owners[dof]) {
            Ok(owner) if owner < supports => Ok(Some(owner)),
            Err(_) if owners[dof] == -1 => Ok(None),
            _ => Err(FemError::ReactionInput {
                reason: format!(
                    "DOF {dof} belongs to support {}, but there are {supports} supports",
                    owners[dof]
                ),
            }),
        }
    };
    let vertices = owners.len() / DOFS_PER_NODE;
    let mut owned = Vec::with_capacity(vertices);
    for vertex in 0..vertices {
        let mut row = [None; DOFS_PER_NODE];
        for (component, slot) in row.iter_mut().enumerate() {
            *slot = owner_of(DOFS_PER_NODE * vertex + component)?;
        }
        let first = row.iter().flatten().next().copied();
        for slot in &mut row[3..] {
            if slot.is_none() {
                *slot = first;
            }
        }
        owned.push(row);
    }
    Ok(owned)
}
