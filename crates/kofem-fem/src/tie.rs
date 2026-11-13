// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Constraint ("MPC") ties of the solid solve: a tied (slave) node follows
//! the surface it is tied to,
//!
//! ```text
//! u_slave = Σ wᵢ · u_masterᵢ ,   Σ wᵢ = 1 .
//! ```
//!
//! No node moves: unlike a node-merge, the two surfaces keep their geometry
//! and only their displacements are coupled, so two bodies meshed on their
//! own join across a gap without a node in common (a pin in a hook eye).
//!
//! The caller ties mesh vertices ([`VertexTies`]). On linear elements the
//! weights are the tie as given — dual mortar weights ([`crate::mortar`]) or
//! a node-to-surface projection; some may be negative. On quadratic elements
//! the master side is a quadratic field, so [`node_ties`] maps each tied
//! vertex's projection point onto the master face holding its masters and
//! evaluates that face's own shape functions there (6-node triangle, 9-node
//! quadrilateral). Interpolating a quadratic face from its corners alone
//! would load it at the corners only and leave the joint soft. The edge
//! nodes (and hex face nodes) of the tied surface — every one whose vertices
//! are all tied — follow the master field too, at the mean of their
//! vertices' projections, so the whole surface follows, not just its corners.
//!
//! The ties are eliminated as master–slave equations by the coupled solve's
//! reduction `K_r = TᵀKT` ([`crate::coupled_static`]), so the reduced system
//! stays symmetric positive definite and the same CG solve and
//! preconditioners carry it. A slave DOF a support already prescribes keeps
//! its support: a DOF cannot be both prescribed and dependent, and the
//! support is the stronger statement. A master may itself be a slave of
//! another tie; such chains are substituted out, and a cycle is refused.
//!
//! Ported from the C++ engine's tie path (PR #547: `tie_constraints.cpp` and
//! `fe_node_ties` in `solve_mfem.cpp`), which it replaces.

use crate::amg::LevelInfo;
use crate::cg::{solve_pcg_with, CgSettings};
use crate::coupled_static::{
    prepare_mixed_static, CoupledReduction, MixedPreconditioner, PreparedMixed,
};
use crate::coupling::{Coupling, CouplingKind, DOFS_PER_NODE};
use crate::error::FemError;
use crate::mesh::{local_edge, local_hex_edge, ElementOrder, TetMesh, FACES_OF_HEX};
use crate::sparse::CsrMatrix;
use crate::static_solve::{extend_to_edge_nodes, PreconditionerChoice, PreparedStatic};

/// Shape functions sum to one exactly; this only absorbs the round-off of
/// computing them in the caller.
const WEIGHT_SUM_TOLERANCE: f64 = 1e-8;

/// A shape-function value this small is round-off of a projection onto an
/// edge or a corner: the node plays no part in the tie.
const NEGLIGIBLE_SHAPE: f64 = 1e-12;

/// One tied node: `node` follows Σ `weights[i]` · u(`masters[i]`).
#[derive(Debug, Clone, PartialEq)]
pub struct NodeTie {
    pub node: usize,
    pub masters: Vec<usize>,
    pub weights: Vec<f64>,
}

/// Ties between mesh vertices, checked: every node in range, tied once, to
/// at least one other node, with finite weights that sum to one.
#[derive(Debug, Clone)]
pub struct VertexTies {
    vertex_count: usize,
    ties: Vec<NodeTie>,
}

fn tie_error(reason: String) -> FemError {
    FemError::Tie { reason }
}

impl VertexTies {
    /// Ties in CSR form over `vertex_count` vertices: vertex `slaves[k]`
    /// follows `masters[offsets[k]..offsets[k + 1]]` with the matching
    /// `weights`.
    ///
    /// # Errors
    /// [`FemError::Tie`] for arrays that do not describe one CSR table, a
    /// node outside the mesh, a node tied twice or to itself or to nothing,
    /// a non-finite weight, or weights that do not sum to one (the tie would
    /// not follow a rigid motion).
    pub fn new(
        vertex_count: usize,
        slaves: &[u32],
        offsets: &[u32],
        masters: &[u32],
        weights: &[f64],
    ) -> Result<Self, FemError> {
        if offsets.len() != slaves.len() + 1
            || offsets.first() != Some(&0)
            || offsets.last().map(|&last| last as usize) != Some(masters.len())
            || weights.len() != masters.len()
        {
            return Err(tie_error(
                "slave, offsets, master and weights do not describe one CSR table".into(),
            ));
        }
        let mut is_slave = vec![false; vertex_count];
        let mut ties = Vec::with_capacity(slaves.len());
        for (index, &slave) in slaves.iter().enumerate() {
            let node = slave as usize;
            if node >= vertex_count {
                return Err(tie_error(format!(
                    "tied node {slave} is outside the mesh (0..{})",
                    vertex_count.saturating_sub(1)
                )));
            }
            if is_slave[node] {
                return Err(tie_error(format!(
                    "node {slave} is tied twice — a node can follow only one surface"
                )));
            }
            is_slave[node] = true;
            let (begin, end) = (offsets[index] as usize, offsets[index + 1] as usize);
            if end > masters.len() || begin > end {
                return Err(tie_error(format!(
                    "offsets of node {slave} leave the CSR table"
                )));
            }
            if end == begin {
                return Err(tie_error(format!("node {slave} is tied to no node at all")));
            }
            let mut sum = 0.0;
            for (&master, &weight) in masters[begin..end].iter().zip(&weights[begin..end]) {
                if master as usize >= vertex_count {
                    return Err(tie_error(format!(
                        "node {slave} is tied to node {master}, which is outside the mesh"
                    )));
                }
                if master == slave {
                    return Err(tie_error(format!("node {slave} is tied to itself")));
                }
                if !weight.is_finite() {
                    return Err(tie_error(format!(
                        "node {slave} has a non-finite tie weight"
                    )));
                }
                sum += weight;
            }
            if (sum - 1.0).abs() > WEIGHT_SUM_TOLERANCE {
                return Err(tie_error(format!(
                    "the tie weights of node {slave} sum to {sum}, not 1 — the tie would not \
                     follow a rigid motion"
                )));
            }
            ties.push(NodeTie {
                node,
                masters: masters[begin..end]
                    .iter()
                    .map(|&master| master as usize)
                    .collect(),
                weights: weights[begin..end].to_vec(),
            });
        }
        Ok(Self { vertex_count, ties })
    }

    /// Tied vertices.
    #[must_use]
    pub fn len(&self) -> usize {
        self.ties.len()
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.ties.is_empty()
    }

    #[must_use]
    pub fn ties(&self) -> &[NodeTie] {
        &self.ties
    }
}

/// A boundary face of the mesh with the nodes of its shape functions:
/// a triangle's 3 corners then (quadratic) its edge nodes 01, 12, 20; a
/// quadrilateral's 4 corners then (quadratic) its edge nodes 01, 12, 23, 30
/// and its face node.
struct MasterFace {
    corners: Vec<usize>,
    nodes: Vec<usize>,
}

/// The faces used by one element only, with their nodes.
fn boundary_faces(mesh: &TetMesh) -> Vec<MasterFace> {
    let quadratic = mesh.order() == ElementOrder::Quadratic;
    let mut all: Vec<(Vec<u32>, MasterFace)> = Vec::new();
    for (index, tet) in mesh.tets().iter().enumerate() {
        let nodes = mesh.element_nodes(index);
        for skip in 0..4 {
            let local: Vec<usize> = (0..4).filter(|&corner| corner != skip).collect();
            let corners: Vec<usize> = local.iter().map(|&corner| tet[corner] as usize).collect();
            let mut face_nodes = corners.clone();
            if quadratic {
                for side in 0..3 {
                    let edge = local_edge(local[side], local[(side + 1) % 3]);
                    face_nodes.push(nodes[4 + edge] as usize);
                }
            }
            all.push((
                sorted_key(&corners),
                MasterFace {
                    corners,
                    nodes: face_nodes,
                },
            ));
        }
    }
    for (index, hex) in mesh.hexes().iter().enumerate() {
        let nodes = mesh.element_nodes(mesh.tets().len() + index);
        for (face, local) in FACES_OF_HEX.iter().enumerate() {
            let corners: Vec<usize> = local.iter().map(|&corner| hex[corner] as usize).collect();
            let mut face_nodes = corners.clone();
            if quadratic {
                for side in 0..4 {
                    let edge = local_hex_edge(local[side], local[(side + 1) % 4]);
                    face_nodes.push(nodes[8 + edge] as usize);
                }
                face_nodes.push(nodes[20 + face] as usize);
            }
            all.push((
                sorted_key(&corners),
                MasterFace {
                    corners,
                    nodes: face_nodes,
                },
            ));
        }
    }
    all.sort_by(|first, second| first.0.cmp(&second.0));
    let mut kept = Vec::new();
    let mut entries = all.into_iter().peekable();
    while let Some((key, face)) = entries.next() {
        let mut repeated = false;
        while entries.peek().is_some_and(|(next, _)| *next == key) {
            entries.next();
            repeated = true;
        }
        if !repeated {
            kept.push(face);
        }
    }
    kept
}

fn sorted_key(corners: &[usize]) -> Vec<u32> {
    let mut key: Vec<u32> = corners.iter().map(|&corner| to_u32(corner)).collect();
    key.sort_unstable();
    key
}

/// The FE-node ties of `ties` on `mesh` (see the module notes): the vertex
/// ties as given on a linear mesh; on a quadratic one, every tied vertex and
/// every edge or hex face node of the tied surface tied to the master face's
/// quadratic field.
///
/// # Errors
/// [`FemError::Tie`] for ties over another vertex count, or (quadratic) a tie
/// whose masters do not lie on one boundary face of the mesh.
pub fn node_ties(mesh: &TetMesh, ties: &VertexTies) -> Result<Vec<NodeTie>, FemError> {
    if ties.vertex_count != mesh.vertex_count() {
        return Err(tie_error(format!(
            "the ties are over {} vertices, but the mesh has {}",
            ties.vertex_count,
            mesh.vertex_count()
        )));
    }
    if mesh.order() == ElementOrder::Linear {
        return Ok(ties.ties.clone());
    }
    let faces = boundary_faces(mesh);
    let points = mesh.node_coordinates();
    let mut faces_of: Vec<Vec<usize>> = vec![Vec::new(); mesh.vertex_count()];
    for (index, face) in faces.iter().enumerate() {
        for &corner in &face.corners {
            faces_of[corner].push(index);
        }
    }
    let mut out = Vec::new();
    // Per tied vertex: the point it projects onto, and the boundary faces
    // around the face it lands on — where its edge and face neighbours land.
    let mut projected: Vec<Option<[f64; 3]>> = vec![None; mesh.vertex_count()];
    let mut nearby: Vec<Vec<usize>> = vec![Vec::new(); mesh.vertex_count()];
    for tie in &ties.ties {
        let holding: Vec<usize> = faces_of[tie.masters[0]]
            .iter()
            .copied()
            .filter(|&face| {
                tie.masters
                    .iter()
                    .all(|master| faces[face].corners.contains(master))
            })
            .collect();
        if holding.is_empty() {
            return Err(tie_error(format!(
                "the nodes vertex {} is tied to do not lie on one free element face",
                tie.node
            )));
        }
        let mut target = [0.0; 3];
        for (&master, &weight) in tie.masters.iter().zip(&tie.weights) {
            for (axis, value) in target.iter_mut().enumerate() {
                *value += weight * points[master][axis];
            }
        }
        let face = tie_to_field(&faces, points, tie.node, target, &holding, &mut out)?;
        projected[tie.node] = Some(target);
        let around = &mut nearby[tie.node];
        for &corner in &faces[face].corners {
            for &other in &faces_of[corner] {
                if !around.contains(&other) {
                    around.push(other);
                }
            }
        }
    }
    // An edge or hex face node whose vertices are all tied follows the master
    // field at the mean of their projections: the master's quadratic field,
    // not the mean of the slave vertices, which would open a gap wherever the
    // master face curves.
    let vertices = mesh.vertex_count();
    let interior = mesh
        .edges()
        .iter()
        .map(|edge| &edge[..])
        .chain(mesh.faces().iter().map(|face| &face[..]))
        .enumerate();
    for (index, corners) in interior {
        let Some(targets) = corners
            .iter()
            .map(|&corner| projected[corner as usize])
            .collect::<Option<Vec<[f64; 3]>>>()
        else {
            continue;
        };
        #[allow(
            clippy::cast_precision_loss,
            reason = "an edge or face has 2 or 4 corners"
        )]
        let share = 1.0 / targets.len() as f64;
        let mut target = [0.0; 3];
        for point in &targets {
            for (axis, value) in target.iter_mut().enumerate() {
                *value += share * point[axis];
            }
        }
        let mut candidates: Vec<usize> = Vec::new();
        for &corner in corners {
            for &face in &nearby[corner as usize] {
                if !candidates.contains(&face) {
                    candidates.push(face);
                }
            }
        }
        tie_to_field(
            &faces,
            points,
            vertices + index,
            target,
            &candidates,
            &mut out,
        )?;
    }
    Ok(out)
}

/// Tie `node` to the master field at `target`: of the `candidates`, the face
/// the point projects onto most closely, with that face's own shape
/// functions at the projection. Returns the face.
fn tie_to_field(
    faces: &[MasterFace],
    points: &[[f64; 3]],
    node: usize,
    target: [f64; 3],
    candidates: &[usize],
    out: &mut Vec<NodeTie>,
) -> Result<usize, FemError> {
    let mut best: Option<(usize, f64, Vec<f64>)> = None;
    for &face in candidates {
        let corners: Vec<[f64; 3]> = faces[face]
            .corners
            .iter()
            .map(|&corner| points[corner])
            .collect();
        let (distance, local) = project(&corners, target);
        if best
            .as_ref()
            .is_none_or(|(_, closest, _)| distance < *closest)
        {
            best = Some((face, distance, local));
        }
    }
    let Some((face, _, local)) = best else {
        return Err(tie_error(format!("no master face for tied node {node}")));
    };
    let nodes = &faces[face].nodes;
    let shape = quadratic_shape(&local);
    let mut masters = Vec::with_capacity(nodes.len());
    let mut weights = Vec::with_capacity(nodes.len());
    for (&master, &value) in nodes.iter().zip(&shape) {
        if value.abs() < NEGLIGIBLE_SHAPE {
            continue;
        }
        masters.push(master);
        weights.push(value);
    }
    // Shape functions sum to one; dropping the negligible ones must not break
    // that, or the tie would resist a rigid motion.
    let sum: f64 = weights.iter().sum();
    for weight in &mut weights {
        *weight /= sum;
    }
    out.push(NodeTie {
        node,
        masters,
        weights,
    });
    Ok(face)
}

/// Closest point of a (straight-sided) face to `target`: its distance and
/// local coordinates — barycentric (λ₀, λ₁, λ₂) on a triangle, (s, t) in
/// [0, 1]² on a bilinear quadrilateral.
fn project(corners: &[[f64; 3]], target: [f64; 3]) -> (f64, Vec<f64>) {
    if corners.len() == 3 {
        let lambda = closest_on_triangle(target, [corners[0], corners[1], corners[2]]);
        let point = combine(corners, &lambda);
        return (distance(point, target), lambda.to_vec());
    }
    // Gauss–Newton on the bilinear map, clamped to the face.
    let bilinear = |along_s: f64, along_t: f64| {
        [
            (1.0 - along_s) * (1.0 - along_t),
            along_s * (1.0 - along_t),
            along_s * along_t,
            (1.0 - along_s) * along_t,
        ]
    };
    let (mut along_s, mut along_t) = (0.5, 0.5);
    for _ in 0..30 {
        let point = combine(corners, &bilinear(along_s, along_t));
        let residual = sub(target, point);
        let tangent_s: [f64; 3] = std::array::from_fn(|axis| {
            (1.0 - along_t) * (corners[1][axis] - corners[0][axis])
                + along_t * (corners[2][axis] - corners[3][axis])
        });
        let tangent_t: [f64; 3] = std::array::from_fn(|axis| {
            (1.0 - along_s) * (corners[3][axis] - corners[0][axis])
                + along_s * (corners[2][axis] - corners[1][axis])
        });
        let [ss, st, tt] = [
            dot(tangent_s, tangent_s),
            dot(tangent_s, tangent_t),
            dot(tangent_t, tangent_t),
        ];
        let determinant = ss * tt - st * st;
        if determinant.abs() <= f64::EPSILON * ss * tt {
            break;
        }
        let [rs, rt] = [dot(tangent_s, residual), dot(tangent_t, residual)];
        let next_s = (along_s + (tt * rs - st * rt) / determinant).clamp(0.0, 1.0);
        let next_t = (along_t + (ss * rt - st * rs) / determinant).clamp(0.0, 1.0);
        let moved = (next_s - along_s).abs() + (next_t - along_t).abs();
        (along_s, along_t) = (next_s, next_t);
        if moved < 1e-14 {
            break;
        }
    }
    let point = combine(corners, &bilinear(along_s, along_t));
    (distance(point, target), vec![along_s, along_t])
}

/// Quadratic shape functions at local coordinates: the 6-node triangle from
/// barycentric λ (corners, then edges 01, 12, 20), or the 9-node
/// quadrilateral from (s, t) (corners, edges 01, 12, 23, 30, centre).
fn quadratic_shape(local: &[f64]) -> Vec<f64> {
    // (s index, t index) of each node: 0 at 0, 1 at 1, 2 at ½.
    const NODES: [[usize; 2]; 9] = [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1],
        [2, 0],
        [1, 2],
        [2, 1],
        [0, 2],
        [2, 2],
    ];
    if let [first, second, third] = *local {
        return vec![
            first * (2.0 * first - 1.0),
            second * (2.0 * second - 1.0),
            third * (2.0 * third - 1.0),
            4.0 * first * second,
            4.0 * second * third,
            4.0 * third * first,
        ];
    }
    // 1-D quadratic Lagrange functions on [0, 1] at 0, 1 and ½.
    let line = |along: f64| {
        [
            (1.0 - along) * (1.0 - 2.0 * along),
            along * (2.0 * along - 1.0),
            4.0 * along * (1.0 - along),
        ]
    };
    let (along_s, along_t) = (line(local[0]), line(local[1]));
    NODES
        .iter()
        .map(|&[index_s, index_t]| along_s[index_s] * along_t[index_t])
        .collect()
}

/// Closest point of triangle abc to p, as barycentric weights (Ericson,
/// Real-Time Collision Detection §5.1.5).
fn closest_on_triangle(point: [f64; 3], triangle: [[f64; 3]; 3]) -> [f64; 3] {
    let [first, second, third] = triangle;
    let ab = sub(second, first);
    let ac = sub(third, first);
    let ap = sub(point, first);
    let (d1, d2) = (dot(ab, ap), dot(ac, ap));
    if d1 <= 0.0 && d2 <= 0.0 {
        return [1.0, 0.0, 0.0];
    }
    let bp = sub(point, second);
    let (d3, d4) = (dot(ab, bp), dot(ac, bp));
    if d3 >= 0.0 && d4 <= d3 {
        return [0.0, 1.0, 0.0];
    }
    let vc = d1 * d4 - d3 * d2;
    if vc <= 0.0 && d1 >= 0.0 && d3 <= 0.0 {
        let along = d1 / (d1 - d3);
        return [1.0 - along, along, 0.0];
    }
    let cp = sub(point, third);
    let (d5, d6) = (dot(ab, cp), dot(ac, cp));
    if d6 >= 0.0 && d5 <= d6 {
        return [0.0, 0.0, 1.0];
    }
    let vb = d5 * d2 - d1 * d6;
    if vb <= 0.0 && d2 >= 0.0 && d6 <= 0.0 {
        let along = d2 / (d2 - d6);
        return [1.0 - along, 0.0, along];
    }
    let va = d3 * d6 - d5 * d4;
    if va <= 0.0 && d4 - d3 >= 0.0 && d5 - d6 >= 0.0 {
        let along = (d4 - d3) / (d4 - d3 + (d5 - d6));
        return [0.0, 1.0 - along, along];
    }
    let scale = 1.0 / (va + vb + vc);
    let (weight_b, weight_c) = (vb * scale, vc * scale);
    [1.0 - weight_b - weight_c, weight_b, weight_c]
}

fn combine(corners: &[[f64; 3]], weights: &[f64]) -> [f64; 3] {
    let mut out = [0.0; 3];
    for (corner, &weight) in corners.iter().zip(weights) {
        for axis in 0..3 {
            out[axis] += weight * corner[axis];
        }
    }
    out
}

fn sub(lhs: [f64; 3], rhs: [f64; 3]) -> [f64; 3] {
    [lhs[0] - rhs[0], lhs[1] - rhs[1], lhs[2] - rhs[2]]
}

fn dot(lhs: [f64; 3], rhs: [f64; 3]) -> f64 {
    lhs[0] * rhs[0] + lhs[1] * rhs[1] + lhs[2] * rhs[2]
}

fn distance(lhs: [f64; 3], rhs: [f64; 3]) -> f64 {
    let offset = sub(lhs, rhs);
    dot(offset, offset).sqrt()
}

fn to_u32(index: usize) -> u32 {
    #[allow(
        clippy::cast_possible_truncation,
        reason = "node indices of a TetMesh fit in u32 (MAX_NODES)"
    )]
    let narrow = index as u32;
    narrow
}

/// What the elimination did with the ties, for the solve log.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct TieReport {
    /// Nodes tied (on a quadratic mesh, edge and face nodes included).
    pub tied_nodes: usize,
    /// Slave DOFs eliminated.
    pub eliminated: usize,
    /// Slave DOFs left to the support that already prescribes them.
    pub prescribed: usize,
}

/// A tied load case ready for CG (see [`prepare_tied_static`]).
pub struct PreparedTied {
    /// The reduced system, its preconditioner and right-hand side.
    pub prepared: PreparedStatic,
    pub reduction: CoupledReduction,
    pub report: TieReport,
}

#[derive(Debug, Clone)]
pub struct TiedSolution {
    /// Displacement per node, x,y,z interleaved: the vertices first, then any
    /// added nodes, as [`crate::StaticSolution`].
    pub displacements: Vec<f64>,
    pub iterations: usize,
    pub relative_residual: f64,
    /// Multigrid levels (unknowns, non-zeros), finest first; empty for
    /// Gauss–Seidel.
    pub levels: Vec<LevelInfo>,
    pub report: TieReport,
}

/// Solve one tied load case in one go (see [`prepare_tied_static`]).
///
/// # Errors
/// As [`prepare_tied_static`], plus a CG breakdown or non-convergence.
#[allow(
    clippy::too_many_arguments,
    reason = "the load case's parts, as solve_static takes them, plus the ties"
)]
pub fn solve_tied_static(
    mesh: &TetMesh,
    stiffness: &CsrMatrix,
    ties: &VertexTies,
    fixed_dofs: &[u32],
    fixed_values: &[f64],
    forces: &[f64],
    settings: CgSettings,
    preconditioner: PreconditionerChoice,
) -> Result<TiedSolution, FemError> {
    let PreparedTied {
        mut prepared,
        reduction,
        report,
    } = prepare_tied_static(
        mesh,
        stiffness,
        ties,
        fixed_dofs,
        fixed_values,
        forces,
        preconditioner,
    )?;
    let (reduced, outcome) = solve_pcg_with(prepared.system.as_mut(), &prepared.rhs, settings)?;
    Ok(TiedSolution {
        displacements: translations(&reduction.expand(&reduced)),
        iterations: outcome.iterations,
        relative_residual: outcome.relative_residual,
        levels: prepared.levels,
        report,
    })
}

/// The three translations of every node from a 6-per-node vector.
#[must_use]
pub fn translations(dofs: &[f64]) -> Vec<f64> {
    dofs.as_chunks::<DOFS_PER_NODE>()
        .0
        .iter()
        .flat_map(|node| [node[0], node[1], node[2]])
        .collect()
}

/// Check one tied load case and set up its reduced system for CG: the
/// uncoupled solve's inputs (`fixed_dofs`/`fixed_values` and `forces` over
/// 3·node + component, vertex conditions extended to the edge nodes as
/// [`crate::prepare_static`] does) plus the vertex ties, turned into node
/// ties by [`node_ties`] and eliminated by the coupled solve's reduction.
/// A slave DOF a support prescribes (directly, or extended to an edge node)
/// keeps its support and is not tied.
///
/// # Errors
/// Malformed forces or constraints, ties that do not fit the mesh (see
/// [`node_ties`]), ties that depend on each other in a cycle
/// ([`FemError::CouplingCycle`]), a load nothing stiffens, or a multigrid
/// setup that finds the model under-constrained.
pub fn prepare_tied_static(
    mesh: &TetMesh,
    stiffness: &CsrMatrix,
    ties: &VertexTies,
    fixed_dofs: &[u32],
    fixed_values: &[f64],
    forces: &[f64],
    preconditioner: PreconditionerChoice,
) -> Result<PreparedTied, FemError> {
    let dof_count = mesh.dof_count();
    if forces.len() != dof_count {
        return Err(FemError::ForceLength {
            len: forces.len(),
            count: dof_count,
        });
    }
    if fixed_dofs.len() != fixed_values.len() {
        return Err(FemError::ConstraintValueCount {
            dofs: fixed_dofs.len(),
            values: fixed_values.len(),
        });
    }
    if let Some(&dof) = fixed_dofs.iter().find(|&&dof| dof as usize >= dof_count) {
        return Err(FemError::DofOutOfRange {
            dof,
            count: dof_count,
        });
    }
    let ties = node_ties(mesh, ties)?;
    let mut dofs = fixed_dofs.to_vec();
    let mut values = fixed_values.to_vec();
    extend_to_edge_nodes(mesh, fixed_dofs, fixed_values, &mut dofs, &mut values);
    let mut prescribed = vec![false; dof_count];
    for &dof in &dofs {
        prescribed[dof as usize] = true;
    }
    let mut report = TieReport {
        tied_nodes: ties.len(),
        ..TieReport::default()
    };
    let mut couplings = Vec::with_capacity(ties.len());
    for tie in ties {
        let mut dof_mask = 0u8;
        for component in 0..3 {
            if prescribed[3 * tie.node + component] {
                report.prescribed += 1;
            } else {
                dof_mask |= 1 << component;
                report.eliminated += 1;
            }
        }
        if dof_mask != 0 {
            couplings.push(Coupling {
                reference: tie.node,
                nodes: tie.masters,
                weights: tie.weights,
                kind: CouplingKind::Tie { dof_mask },
            });
        }
    }
    let wide = |dof: u32| to_u32(DOFS_PER_NODE * (dof as usize / 3) + dof as usize % 3);
    let wide_dofs: Vec<u32> = fixed_dofs.iter().map(|&dof| wide(dof)).collect();
    let mut wide_forces = vec![0.0; DOFS_PER_NODE * mesh.node_count()];
    for (dof, &force) in forces.iter().enumerate() {
        wide_forces[DOFS_PER_NODE * (dof / 3) + dof % 3] = force;
    }
    let PreparedMixed {
        prepared,
        reduction,
        ..
    } = prepare_mixed_static(
        mesh,
        stiffness,
        None,
        &couplings,
        &wide_dofs,
        fixed_values,
        &wide_forces,
        MixedPreconditioner::Choice(preconditioner),
    )?;
    Ok(PreparedTied {
        prepared,
        reduction,
        report,
    })
}
