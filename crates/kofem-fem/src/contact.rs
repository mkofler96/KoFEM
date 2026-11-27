// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Frictionless dual mortar contact between solid surfaces, small sliding:
//! two surfaces that are not connected carry load where they touch and
//! separate where they pull apart.
//!
//! The mortar integrals ([`crate::mortar`]) are taken once, on the
//! undeformed geometry: per slave node j its weight Dⱼⱼ, its masters' weights
//! wⱼₖ = Mⱼₖ / Dⱼⱼ, its normal nⱼ and its gap
//!
//! ```text
//! gⱼ(u) = nⱼ · (Σₖ wⱼₖ (xₖ + uₖ) − (xⱼ + uⱼ)),
//! ```
//!
//! the weighted gap g̃ⱼ over Dⱼⱼ, positive where the surfaces are apart. The
//! contact conditions are, with pⱼ ≥ 0 the contact pressure (the dual
//! multiplier, a force per area),
//!
//! ```text
//! gⱼ ≥ 0,   pⱼ ≥ 0,   pⱼ · gⱼ = 0 .
//! ```
//!
//! They are solved by the primal–dual active set strategy (Hüeber &
//! Wohlmuth 2005) inside the Newton driver: a closed node j holds gⱼ = 0 —
//! an elimination in Wohlmuth's rotated basis, a [`NormalConstraint`] with
//! the gap still open as its offset, which keeps the system symmetric
//! positive definite for CG and multigrid — and an open node is free. After
//! each solve a closed node whose pressure pulls opens, and an open node
//! whose gap went negative closes. With the gap held on closed nodes and the
//! pressure zero on open ones, this is the active set update
//! `pⱼ − c·gⱼ > 0` for every c > 0: no penalty or complementarity constant
//! enters. The solve has converged when the set stops changing and the
//! residual is within tolerance. The first set closes the nodes that touch
//! at the start (gⱼ ≤ 0).
//!
//! A body its supports and ties leave loose may still be held by contact,
//! but not before its gap has closed, and frictionless contact never holds
//! it across the surface: a block resting on a flat face can still slide and
//! spin. Such a body therefore gets a weak spring to its rest position on
//! every DOF, a fraction [`STABILISATION`] of its mean tangent diagonal, as
//! weak springs in commercial codes do: the system stays positive definite,
//! and a motion nothing holds is held at zero rather than left to drift on
//! round-off. The first set closes every node where such a body faces the
//! other surface, so the first correction moves it across its gap instead of
//! far along the springs, and the update opens the nodes that pull.
//!
//! While the set changes, the springs' force is part of the balance. Once a
//! correction has been solved under a set that it leaves unchanged, the
//! springs leave the balance and stay in the tangent only: the following
//! corrections remove what they carried, so the converged solution is
//! balanced by contact and supports alone, and with nothing left out of
//! balance along a free motion nothing makes it drift. Where contact or a
//! support holds a body, what the springs carried, its load or their pull
//! against its crossing a gap, is gone after one correction but for the
//! springs' share. Where the load drives a body in a motion nothing holds,
//! the force out of balance on it stays from one correction to the next, and
//! the solve is refused with that motion ([`FemError::ContactUnheld`]).
//!
//! The pressure of a closed node is its share of the force the out-of-balance
//! residual leaves along its normal, pⱼ = nⱼ · rⱼ / Dⱼⱼ; the same pressure
//! pushes its masters with wⱼₖ Dⱼⱼ pⱼ nⱼ. Supports hold the tangents they
//! act along: a slave node's normal loses its components along the axes a
//! support holds (a symmetry plane), and a node whose whole normal a support
//! holds keeps the support, as a tied node does.
//!
//! The slave surface should be the finer one: each slave node gets one
//! condition, so a coarse slave surface lets a fine master surface's nodes
//! through between its own.
//!
//! Each node carries one condition and is one side of contact only, so where
//! two contacts meet at an edge its nodes are settled first: a node on two
//! slave surfaces whose normals agree (one surface picked as two contacts)
//! takes both shares as one condition, summing the areas and weighting the
//! masters by area, as one contact over both would; at a corner it keeps the
//! larger share. A slave node that is also among another's masters keeps
//! its condition, and the other follows its remaining masters instead, their
//! weights scaled back to sum to one so a rigid motion still closes no gap;
//! one left with too little of its weight gives up its condition. The nodes
//! these steps touched are reported ([`ContactState::shared`]); the same face
//! in two contacts would count its area twice and is refused.
//!
//! References: S. Hüeber, B. I. Wohlmuth, "A primal–dual active set strategy
//! for non-linear multibody contact problems", CMAME 194 (2005) 3147–3166;
//! A. Popp, M. W. Gee, W. A. Wall, "A finite deformation mortar contact
//! formulation using a primal–dual active set strategy", IJNME 79 (2009)
//! 1354–1391.

use std::collections::btree_map::Entry;
use std::collections::{BTreeMap, BTreeSet};

use crate::amg::Preconditioner;
use crate::cg::{CgSettings, PcgRun, PcgStatus};
use crate::constraints::Dirichlet;
use crate::count::count_as_f64;
use crate::coupled_static::{
    constrained_reduction, prepare_constrained_static, CoupledReduction, NormalConstraint,
    PreparedMixed,
};
use crate::coupling::{Coupling, DOFS_PER_NODE};
use crate::error::FemError;
use crate::mesh::{ElementOrder, TetMesh};
use crate::mortar::{mortar_integrals, MortarFace, SlaveIntegrals};
use crate::nonlinear::{Settled, SolveProgress, TangentSolver};
use crate::rigid_body::{free_rigid_motions, RigidBodyModel, RigidLink};
use crate::sparse::CsrMatrix;
use crate::static_solve::PreconditionerChoice;
use crate::surface::BoundaryFaces;
use crate::tie::{tie_couplings, translations, TieReport, VertexTies};

/// The spring on each DOF of a loose body, as a fraction of the body's mean
/// tangent diagonal (see the module notes): what a held body's springs carry,
/// their stiffness times a rigid motion of the order of a gap, stays far
/// below any load, and a body nothing holds still moves a finite way.
const STABILISATION: f64 = 1e-9;

/// A loose body whose out-of-balance resultant keeps more than this fraction
/// from one correction to the next, under an unchanged active set, is driven
/// in a motion nothing holds: a held one keeps about the springs' share.
const STALLED: f64 = 0.5;

/// Below this many times the solve's tolerance and the load, a resultant is
/// round-off and says nothing about a motion.
const RESULTANT_FLOOR: f64 = 10.0;

/// Two slave normals of one node at most this far apart (cos 10°) are one
/// surface picked as two contacts; further apart, the node is a corner.
const SAME_SURFACE: f64 = 0.984_807_753;

/// A slave node that keeps less than this share of its master weights once
/// the other contacts' slave nodes are taken out of them mostly faces the
/// other contact's slave side, and gives up its condition. A node half-way
/// across a master face from the shared edge keeps half.
const KEPT_WEIGHT: f64 = 0.25;

/// A direction component below this is taken as zero, so that a motion along
/// a coordinate axis is reported as exactly that axis: the springs' share of
/// a held motion leaves a trace in the direction of an unheld one.
const AXIS_SNAP: f64 = 1e-3;

fn contact_error(reason: String) -> FemError {
    FemError::Contact { reason }
}

/// Two surfaces that may come into contact: the element faces of the slave
/// side (the finer mesh) and of the master side, nodes numbered as the mesh
/// vertices.
#[derive(Debug, Clone)]
pub struct ContactPair {
    pub slave: Vec<MortarFace>,
    pub master: Vec<MortarFace>,
}

impl ContactPair {
    /// The pair between two picked surfaces, each given by its vertices:
    /// the boundary faces of `boundary` whose corners are all on a side.
    /// The side with the smaller mean face area is the slave.
    ///
    /// # Errors
    /// [`FemError::Contact`] when a side names no whole boundary face.
    pub fn between(
        mesh: &TetMesh,
        boundary: &BoundaryFaces,
        side_a: &[u32],
        side_b: &[u32],
    ) -> Result<Self, FemError> {
        let faces = |side: &[u32], name: &str| {
            let members: BTreeSet<u32> = side.iter().copied().collect();
            let faces = boundary.mortar_faces(mesh, |vertex| members.contains(&vertex));
            if faces.is_empty() {
                return Err(contact_error(format!(
                    "side {name} of the contact names no whole boundary face — pick the faces \
                     of a solid's surface"
                )));
            }
            Ok(faces)
        };
        let first = faces(side_a, "A")?;
        let second = faces(side_b, "B")?;
        let mean_area = |faces: &[MortarFace]| {
            #[allow(clippy::cast_precision_loss, reason = "a face count is far below 2^52")]
            let count = faces.len() as f64;
            faces
                .iter()
                .map(|face| polygon_area(&face.points))
                .sum::<f64>()
                / count
        };
        Ok(if mean_area(&second) < mean_area(&first) {
            Self {
                slave: second,
                master: first,
            }
        } else {
            Self {
                slave: first,
                master: second,
            }
        })
    }
}

/// The area of a planar or slightly warped polygon (Newell).
fn polygon_area(points: &[[f64; 3]]) -> f64 {
    let mut doubled = [0.0; 3];
    for (index, point) in points.iter().enumerate() {
        let next = points[(index + 1) % points.len()];
        doubled[0] += (point[1] - next[1]) * (point[2] + next[2]);
        doubled[1] += (point[2] - next[2]) * (point[0] + next[0]);
        doubled[2] += (point[0] - next[0]) * (point[1] + next[1]);
    }
    dot(doubled, doubled).sqrt() / 2.0
}

/// One slave node with its mortar integrals.
#[derive(Debug, Clone)]
struct SlaveNode {
    node: usize,
    normal: [f64; 3],
    masters: Vec<usize>,
    /// D⁻¹M.
    weights: Vec<f64>,
    /// Dⱼⱼ: the area the node's pressure acts on.
    area: f64,
}

/// The mortar integrals of every contact pair, both ways round: with its
/// slave side as the slave (the preferred way, the finer mesh), and with its
/// master side as the slave. Which one a solve uses depends on its supports
/// (see [`ContactCg`]).
#[derive(Debug, Clone)]
pub struct ContactInterface {
    pairs: Vec<[Vec<SlaveNode>; 2]>,
    /// The faces of each way round's slave side, each as its sorted nodes.
    slave_faces: Vec<[Vec<Vec<usize>>; 2]>,
}

impl ContactInterface {
    /// The mortar integrals of each pair's surfaces over each other, on
    /// linear elements.
    ///
    /// # Errors
    /// [`FemError::Contact`] for a quadratic mesh, no pair, a pair without
    /// slave or master faces, a face node outside the mesh, a degenerate
    /// face, or surfaces with no node of either opposite the other.
    pub fn new(mesh: &TetMesh, pairs: &[ContactPair]) -> Result<Self, FemError> {
        if mesh.order() != ElementOrder::Linear {
            return Err(contact_error(
                "contact needs linear elements: the mortar integrals are taken over linear \
                 faces"
                    .into(),
            ));
        }
        if pairs.is_empty() {
            return Err(contact_error("no contact pair is given".into()));
        }
        let vertices = mesh.vertex_count();
        let mut both_ways = Vec::with_capacity(pairs.len());
        let mut slave_faces = Vec::with_capacity(pairs.len());
        for (index, pair) in pairs.iter().enumerate() {
            let fail = |reason: &str| contact_error(format!("contact pair {index}: {reason}"));
            if pair.slave.is_empty() {
                return Err(fail("the slave surface has no faces"));
            }
            if pair.master.is_empty() {
                return Err(fail("the master surface has no faces"));
            }
            if let Some(&node) = pair
                .slave
                .iter()
                .chain(&pair.master)
                .flat_map(|face| &face.nodes)
                .find(|&&node| node >= vertices)
            {
                return Err(fail(&format!(
                    "face node {node} is outside the mesh ({vertices} vertices)"
                )));
            }
            let nodes = |slave: &[MortarFace], master: &[MortarFace]| {
                mortar_integrals(slave, master, f64::INFINITY)
                    .map(|integrals| integrals.into_iter().map(SlaveNode::from).collect())
                    .map_err(|error| fail(&error.to_string()))
            };
            let preferred: Vec<SlaveNode> = nodes(&pair.slave, &pair.master)?;
            let reversed: Vec<SlaveNode> = nodes(&pair.master, &pair.slave)?;
            if preferred.is_empty() && reversed.is_empty() {
                return Err(fail(
                    "no node of either surface lies opposite the other — the two surfaces do \
                     not face each other",
                ));
            }
            both_ways.push([preferred, reversed]);
            let keys = |faces: &[MortarFace]| -> Vec<Vec<usize>> {
                faces
                    .iter()
                    .map(|face| {
                        let mut key = face.nodes.clone();
                        key.sort_unstable();
                        key
                    })
                    .collect()
            };
            slave_faces.push([keys(&pair.slave), keys(&pair.master)]);
        }
        Ok(Self {
            pairs: both_ways,
            slave_faces,
        })
    }
}

impl From<SlaveIntegrals> for SlaveNode {
    fn from(integrals: SlaveIntegrals) -> Self {
        Self {
            node: integrals.slave,
            normal: integrals.normal,
            weights: integrals
                .coupling
                .iter()
                .map(|value| value / integrals.diagonal)
                .collect(),
            masters: integrals.masters,
            area: integrals.diagonal,
        }
    }
}

/// The rigid motion a load drives a body in that nothing holds: along a unit
/// direction, or about a unit axis through the body. A coordinate axis is
/// given exactly.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum UnheldMotion {
    Along([f64; 3]),
    About([f64; 3]),
}

impl std::fmt::Display for UnheldMotion {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let (verb, direction) = match self {
            Self::Along(direction) => ("move it along", direction),
            Self::About(axis) => ("turn it about", axis),
        };
        let [first, second, third] = direction;
        write!(formatter, "{verb} ({first}, {second}, {third})")
    }
}

/// The contact state at the last iterate the solver settled.
#[derive(Debug, Clone, PartialEq)]
pub struct ContactState {
    /// The slave nodes in contact condition, sorted by pair, then node.
    pub nodes: Vec<usize>,
    /// Contact pressure per node (force per area, ≥ 0 pressing); zero on an
    /// open node.
    pub pressure: Vec<f64>,
    /// Gap per node along its normal (length, ≥ 0 apart).
    pub gap: Vec<f64>,
    /// Whether the node is closed (in the active set).
    pub closed: Vec<bool>,
    /// The area each node's pressure acts on (Dⱼⱼ).
    pub area: Vec<f64>,
    /// Slave nodes a support holds along their whole normal; they keep the
    /// support and carry no contact condition.
    pub held: Vec<usize>,
    /// Nodes on an edge two contacts share (see the module notes): slave
    /// nodes another contact no longer follows, and nodes that gave up a
    /// condition there.
    pub shared: Vec<usize>,
    /// What the elimination did with the model's ties.
    pub ties: TieReport,
}

impl ContactState {
    /// The total normal force the contact carries, Σ pⱼ Dⱼⱼ.
    #[must_use]
    pub fn force(&self) -> f64 {
        self.pressure
            .iter()
            .zip(&self.area)
            .map(|(pressure, area)| pressure * area)
            .sum()
    }
}

/// A slave node as the supports leave it.
#[derive(Debug, Clone)]
struct ActiveNode {
    /// Index into the set-up's slave nodes.
    index: usize,
    normal: [f64; 3],
    /// The gap at zero displacement.
    initial_gap: f64,
    closed: bool,
    gap: f64,
    pressure: f64,
}

/// What the solver knows once it has seen the supports.
struct Setup {
    /// The slave nodes of every pair, the way round the supports allow.
    slaves: Vec<SlaveNode>,
    couplings: Vec<Coupling>,
    ties: TieReport,
    nodes: Vec<ActiveNode>,
    held: Vec<usize>,
    /// Nodes on an edge two contacts share ([`ContactState::shared`]).
    shared: Vec<usize>,
    /// The ties-only reduction and its held unknowns, to take the reactions
    /// out of a residual.
    tie_reduction: CoupledReduction,
    tie_held: Vec<bool>,
    /// The bodies the supports and ties leave loose (see the module notes).
    loose: Vec<LooseBody>,
    /// Settles in a row whose active set update changed nothing.
    steady: usize,
    /// The largest load seen, summed over its magnitudes: the out-of-balance
    /// force or what the closed nodes imposed.
    load_scale: f64,
    /// The springs' force at the last settled iterate, 3 per node; zero
    /// once they have left the balance.
    spring_force: Vec<f64>,
    /// Whether the springs have left the balance (see the module notes).
    released: bool,
}

/// A piece of the mesh the supports and ties leave free to move rigidly.
struct LooseBody {
    /// Its nodes, sorted.
    nodes: Vec<usize>,
    center: [f64; 3],
    /// Its bounding box diagonal, which turns a moment into a force.
    size: f64,
    /// The out-of-balance force and moment / size on it at the last settle
    /// since the springs left the balance under the same active set.
    resultant: Option<[f64; 6]>,
}

impl LooseBody {
    /// The force and the moment about the centre over the size that `forces`
    /// (3 per node) exert on the body.
    fn resultant_of(&self, forces: &[f64], points: &[[f64; 3]]) -> [f64; 6] {
        let mut sum = [0.0; 6];
        for &node in &self.nodes {
            let force = [forces[3 * node], forces[3 * node + 1], forces[3 * node + 2]];
            let arm: [f64; 3] = std::array::from_fn(|axis| points[node][axis] - self.center[axis]);
            let moment = cross(arm, force);
            for axis in 0..3 {
                sum[axis] += force[axis];
                sum[3 + axis] += moment[axis] / self.size;
            }
        }
        sum
    }

    /// The motion a resultant drives: along its force, or about its moment
    /// where that is the larger.
    fn motion(resultant: [f64; 6]) -> UnheldMotion {
        let force = [resultant[0], resultant[1], resultant[2]];
        let moment = [resultant[3], resultant[4], resultant[5]];
        if dot(force, force) >= dot(moment, moment) {
            UnheldMotion::Along(snapped(force))
        } else {
            UnheldMotion::About(snapped(moment))
        }
    }

    /// The spring on each of the body's DOFs for `tangent`.
    fn spring(&self, tangent: &CsrMatrix) -> f64 {
        let diagonal: f64 = self
            .nodes
            .iter()
            .flat_map(|&node| (0..3).map(move |axis| tangent.diagonal(3 * node + axis)))
            .sum();
        STABILISATION * diagonal / count_as_f64(3 * self.nodes.len())
    }
}

/// `vector` as a unit vector, components below [`AXIS_SNAP`] of it zeroed.
fn snapped(vector: [f64; 3]) -> [f64; 3] {
    let length = dot(vector, vector).sqrt();
    let kept = vector.map(|component| {
        if component.abs() < AXIS_SNAP * length {
            0.0
        } else {
            component
        }
    });
    let length = dot(kept, kept).sqrt();
    kept.map(|component| component / length)
}

fn cross(lhs: [f64; 3], rhs: [f64; 3]) -> [f64; 3] {
    [
        lhs[1] * rhs[2] - lhs[2] * rhs[1],
        lhs[2] * rhs[0] - lhs[0] * rhs[2],
        lhs[0] * rhs[1] - lhs[1] * rhs[0],
    ]
}

/// What one active set update did.
struct Update {
    /// A node opened or closed.
    flipped: bool,
    /// A closed node's gap was not yet zero (an overlap at the start).
    overlap: bool,
}

struct ActiveSolve {
    system: Box<dyn Preconditioner>,
    run: PcgRun,
    reduction: CoupledReduction,
    tangent: CsrMatrix,
}

/// The correction solve of a Newton run with contact (see the module notes):
/// the supports, the model's ties and the closed contact nodes eliminated by
/// the coupled solve's reduction, then CG with Gauss–Seidel or multigrid.
pub struct ContactCg {
    mesh: TetMesh,
    interface: ContactInterface,
    ties: Option<VertexTies>,
    cg: CgSettings,
    preconditioner: PreconditionerChoice,
    setup: Option<Setup>,
    active: Option<ActiveSolve>,
    /// Corrections solved so far.
    corrections: usize,
}

impl ContactCg {
    /// Solves on `mesh`'s DOFs with contact over `interface` and, if given,
    /// the constraint ties `ties`. Each correction stops at
    /// `cg.relative_tolerance`, which also bounds the round-off the active
    /// set update ignores, and fails after `cg.max_iterations`.
    #[must_use]
    pub fn new(
        mesh: &TetMesh,
        interface: ContactInterface,
        ties: Option<VertexTies>,
        cg: CgSettings,
        preconditioner: PreconditionerChoice,
    ) -> Self {
        Self {
            mesh: mesh.clone(),
            interface,
            ties,
            cg,
            preconditioner,
            setup: None,
            active: None,
            corrections: 0,
        }
    }

    /// The contact state at the last settled iterate; `None` before the
    /// first.
    #[must_use]
    pub fn state(&self) -> Option<ContactState> {
        let setup = self.setup.as_ref()?;
        Some(ContactState {
            nodes: setup
                .nodes
                .iter()
                .map(|active| setup.slaves[active.index].node)
                .collect(),
            pressure: setup.nodes.iter().map(|active| active.pressure).collect(),
            gap: setup.nodes.iter().map(|active| active.gap).collect(),
            closed: setup.nodes.iter().map(|active| active.closed).collect(),
            area: setup
                .nodes
                .iter()
                .map(|active| setup.slaves[active.index].area)
                .collect(),
            held: setup.held.clone(),
            shared: setup.shared.clone(),
            ties: setup.ties,
        })
    }

    /// The ties as couplings, the slave normals as the supports leave them,
    /// the initial gaps and the first active set: the nodes that touch, and
    /// every node where a loose body faces the other surface, which closes
    /// that body's gap in the first correction (see the module notes).
    fn set_up(&self, supports: &Dirichlet) -> Result<Setup, FemError> {
        let (fixed_dofs, fixed_values): (Vec<u32>, Vec<f64>) = supports
            .prescribed()
            .map(|(dof, value)| (to_u32(dof), value))
            .unzip();
        let (couplings, ties) = match &self.ties {
            Some(ties) => tie_couplings(&self.mesh, ties, &fixed_dofs, &fixed_values)?,
            None => (Vec::new(), TieReport::default()),
        };
        let (slaves, shared) = self.slave_sides(supports)?;
        let wide_dofs: Vec<u32> = fixed_dofs.iter().map(|&dof| widen_dof(dof)).collect();
        let loose = self.loose_bodies(&wide_dofs)?;
        let on_loose = |node: usize| {
            loose
                .iter()
                .any(|body| body.nodes.binary_search(&node).is_ok())
        };
        let points = self.mesh.vertices();
        let mut nodes = Vec::new();
        let mut held = Vec::new();
        for (index, slave) in slaves.iter().enumerate() {
            let mut normal = slave.normal;
            for (axis, component) in normal.iter_mut().enumerate() {
                if supports.value(3 * slave.node + axis).is_some() {
                    *component = 0.0;
                }
            }
            let length = dot(normal, normal).sqrt();
            if length == 0.0 {
                held.push(slave.node);
                continue;
            }
            let normal = normal.map(|component| component / length);
            let mut followed = [0.0; 3];
            for (&master, &weight) in slave.masters.iter().zip(&slave.weights) {
                for (axis, value) in followed.iter_mut().enumerate() {
                    *value += weight * points[master][axis];
                }
            }
            let own = points[slave.node];
            let initial_gap = (0..3)
                .map(|axis| normal[axis] * (followed[axis] - own[axis]))
                .sum::<f64>();
            nodes.push(ActiveNode {
                index,
                normal,
                initial_gap,
                closed: initial_gap <= 0.0
                    || on_loose(slave.node)
                    || slave.masters.iter().any(|&master| on_loose(master)),
                gap: initial_gap,
                pressure: 0.0,
            });
        }
        let (tie_reduction, tie_held) =
            constrained_reduction(&self.mesh, &couplings, &[], &wide_dofs, &fixed_values)?;
        Ok(Setup {
            slaves,
            couplings,
            ties,
            nodes,
            held,
            shared,
            tie_reduction,
            tie_held,
            loose,
            steady: 0,
            load_scale: 0.0,
            spring_force: vec![0.0; self.mesh.dof_count()],
            released: false,
        })
    }

    /// The pieces of the mesh that the supports (`wide_dofs`, 6 per node)
    /// and the ties leave free to move rigidly, contact aside.
    fn loose_bodies(&self, wide_dofs: &[u32]) -> Result<Vec<LooseBody>, FemError> {
        let points = self.mesh.vertices();
        let positions: Vec<f64> = points.iter().flatten().copied().collect();
        let mut element_offsets = vec![0];
        let mut element_nodes = Vec::new();
        for element in 0..self.mesh.element_count() {
            element_nodes.extend_from_slice(self.mesh.element_nodes(element));
            element_offsets.push(to_u32(element_nodes.len()));
        }
        // Each element labelled by its index, so a loose piece reports its
        // elements.
        let element_labels: Vec<u32> = (0..self.mesh.element_count()).map(to_u32).collect();
        let links: Vec<RigidLink> = self
            .ties
            .iter()
            .flat_map(VertexTies::ties)
            .map(|tie| RigidLink {
                primary: tie.masters.iter().map(|&master| to_u32(master)).collect(),
                secondary: vec![to_u32(tie.node)],
                dof_mask: 0b111,
            })
            .collect();
        let motions = free_rigid_motions(&RigidBodyModel {
            positions: &positions,
            element_offsets: &element_offsets,
            element_nodes: &element_nodes,
            element_labels: &element_labels,
            rotational_nodes: &[],
            links: &links,
            contacts: &[],
            fixed_dofs: wide_dofs,
        })?;
        Ok(motions
            .into_iter()
            .map(|motion| {
                let members: BTreeSet<usize> = motion
                    .labels
                    .iter()
                    .flat_map(|&element| self.mesh.element_nodes(element as usize))
                    .map(|&node| node as usize)
                    .collect();
                let nodes: Vec<usize> = members.into_iter().collect();
                let mut low = [f64::INFINITY; 3];
                let mut high = [f64::NEG_INFINITY; 3];
                let mut sum = [0.0; 3];
                for &node in &nodes {
                    for axis in 0..3 {
                        let value = points[node][axis];
                        low[axis] = low[axis].min(value);
                        high[axis] = high[axis].max(value);
                        sum[axis] += value;
                    }
                }
                let count = count_as_f64(nodes.len());
                let extent: [f64; 3] = std::array::from_fn(|axis| high[axis] - low[axis]);
                LooseBody {
                    center: sum.map(|value| value / count),
                    size: dot(extent, extent).sqrt(),
                    nodes,
                    resultant: None,
                }
            })
            .collect())
    }

    /// The slave nodes of every pair, each pair the preferred way round
    /// unless its supports hold a slave node along its whole normal while a
    /// master of it can still move — the master would pass through, so the
    /// other side is the slave then. Nodes where pairs meet are settled as
    /// the module notes say; returns the slave nodes and those that gave up
    /// a condition.
    ///
    /// # Errors
    /// [`FemError::Contact`] when neither way round avoids that, or when a
    /// face is on the slave side of two pairs.
    fn slave_sides(&self, supports: &Dirichlet) -> Result<(Vec<SlaveNode>, Vec<usize>), FemError> {
        let held_along = |node: usize, normal: [f64; 3]| {
            (0..3).all(|axis| normal[axis] == 0.0 || supports.value(3 * node + axis).is_some())
        };
        let stuck = |side: &[SlaveNode]| {
            side.iter()
                .find(|slave| {
                    held_along(slave.node, slave.normal)
                        && slave
                            .masters
                            .iter()
                            .any(|&master| !held_along(master, slave.normal))
                })
                .map(|slave| slave.node)
        };
        let mut chosen: Vec<SlaveNode> = Vec::new();
        let mut faces_of: BTreeMap<&[usize], usize> = BTreeMap::new();
        for (index, ways) in self.interface.pairs.iter().enumerate() {
            let way = (0..2)
                .filter(|&way| !ways[way].is_empty())
                .find(|&way| stuck(&ways[way]).is_none())
                .ok_or_else(|| {
                    let node = ways.iter().find_map(|side| stuck(side)).unwrap_or_default();
                    contact_error(format!(
                        "contact pair {index}: supports hold both surfaces along the contact \
                         normal (at node {node}) where the other surface can still move — \
                         release the support on one of them"
                    ))
                })?;
            for face in &self.interface.slave_faces[index][way] {
                if let Some(other) = faces_of.insert(face, index) {
                    return Err(contact_error(format!(
                        "contact pairs {other} and {index} both press the face of nodes \
                         {face:?} — a face can be in two contacts only as their common edge"
                    )));
                }
            }
            chosen.extend(ways[way].iter().cloned());
        }
        Ok(settle_shared_nodes(chosen))
    }

    fn running(&mut self) -> Result<&mut ActiveSolve, FemError> {
        self.active
            .as_mut()
            .ok_or_else(|| FemError::NonlinearInput {
                reason: String::from("no tangent solve has been started"),
            })
    }
}

impl Setup {
    /// The pressure and gap of every slave node at `displacements`, and the
    /// residual `wide` (6 per node) less the reactions of the closed nodes
    /// and the ties, back on 3 DOFs per node (see the module notes).
    fn measure(&mut self, displacements: &[f64], wide: &[f64]) -> Result<Vec<f64>, FemError> {
        // The force along each closed node's normal, gathered over the ties.
        let gathered = self.tie_reduction.place(&self.tie_reduction.reduce(wide)?);
        let mut reactions = vec![0.0; wide.len()];
        for active in &mut self.nodes {
            let slave = &self.slaves[active.index];
            let along = (0..3)
                .map(|axis| active.normal[axis] * gathered[DOFS_PER_NODE * slave.node + axis])
                .sum::<f64>();
            active.pressure = if active.closed {
                along / slave.area
            } else {
                0.0
            };
            let force = active.pressure * slave.area;
            for axis in 0..3 {
                let push = force * active.normal[axis];
                reactions[DOFS_PER_NODE * slave.node + axis] += push;
                for (&master, &weight) in slave.masters.iter().zip(&slave.weights) {
                    reactions[DOFS_PER_NODE * master + axis] -= weight * push;
                }
            }
            let mut moved = 0.0;
            for axis in 0..3 {
                let mut followed = 0.0;
                for (&master, &weight) in slave.masters.iter().zip(&slave.weights) {
                    followed += weight * displacements[3 * master + axis];
                }
                moved += active.normal[axis] * (followed - displacements[3 * slave.node + axis]);
            }
            active.gap = active.initial_gap + moved;
        }
        let free: Vec<f64> = wide
            .iter()
            .zip(&reactions)
            .map(|(force, reaction)| force - reaction)
            .collect();
        let mut reduced = self.tie_reduction.reduce(&free)?;
        for (value, &held) in reduced.iter_mut().zip(&self.tie_held) {
            if held {
                *value = 0.0;
            }
        }
        Ok(translations(&self.tie_reduction.place(&reduced)))
    }

    /// Open the closed nodes that pull and close the open nodes that
    /// penetrate. Below `tolerance` (the solve's) times the largest
    /// displacement or pressure, a gap or a pressure carries no sign.
    fn update_active_set(&mut self, tolerance: f64, displacements: &[f64]) -> Update {
        let gap_tolerance = tolerance
            * displacements
                .iter()
                .map(|value| value.abs())
                .fold(0.0, f64::max);
        let pressure_tolerance = tolerance
            * self
                .nodes
                .iter()
                .map(|active| active.pressure.abs())
                .fold(0.0, f64::max);
        let overlap = self
            .nodes
            .iter()
            .any(|active| active.closed && active.gap.abs() > gap_tolerance);
        let mut flipped = false;
        for active in &mut self.nodes {
            let flip = if active.closed {
                active.pressure < -pressure_tolerance
            } else {
                active.gap < -gap_tolerance
            };
            if flip {
                active.closed = !active.closed;
                active.pressure = 0.0;
                flipped = true;
            }
        }
        Update { flipped, overlap }
    }

    /// The loose bodies' spring force at `displacements` (3 per node), zero
    /// on the supported DOFs.
    fn springs_at(
        &self,
        displacements: &[f64],
        tangent: &CsrMatrix,
        supports: &Dirichlet,
    ) -> Vec<f64> {
        let mut force = vec![0.0; displacements.len()];
        for body in &self.loose {
            let spring = body.spring(tangent);
            for &node in &body.nodes {
                for axis in 0..3 {
                    let dof = 3 * node + axis;
                    if supports.value(dof).is_none() {
                        force[dof] = spring * displacements[dof];
                    }
                }
            }
        }
        force
    }

    /// Refuse a loose body whose out-of-balance resultant under `free` kept
    /// more than [`STALLED`] of the last one, both measured under one active
    /// set with the springs out of the balance (see the module notes).
    /// Resultants below `floor` are round-off.
    fn check_held(
        &mut self,
        free: &[f64],
        points: &[[f64; 3]],
        floor: f64,
    ) -> Result<(), FemError> {
        for body in &mut self.loose {
            let now = body.resultant_of(free, points);
            if let Some(before) = body.resultant.replace(now) {
                if norm(&now) > floor && norm(&now) > STALLED * norm(&before) {
                    return Err(FemError::ContactUnheld {
                        node: body.nodes[0],
                        motion: LooseBody::motion(now),
                    });
                }
            }
        }
        Ok(())
    }

    /// The tangent with the loose bodies' springs, or `None` without loose
    /// bodies.
    fn stabilised(&self, tangent: &CsrMatrix) -> Option<CsrMatrix> {
        if self.loose.is_empty() {
            return None;
        }
        let mut stiffened = tangent.clone();
        for body in &self.loose {
            let spring = body.spring(tangent);
            for &node in &body.nodes {
                for axis in 0..3 {
                    let at = stiffened.diagonal_position(3 * node + axis);
                    stiffened.values_mut()[at] += spring;
                }
            }
        }
        Some(stiffened)
    }

    /// The force on the free DOFs of moving each closed node out of its
    /// overlap at the start along its normal: what the model's own overlaps
    /// impose. A node a correction pushed through the other surface counts
    /// only its overlap at the start: how far it went is the solve's doing,
    /// not a load.
    fn imposed_load(&self, tangent: &CsrMatrix, supports: &Dirichlet) -> f64 {
        let count = tangent.rows();
        let mut imposed = vec![0.0; count];
        for active in self.nodes.iter().filter(|active| active.closed) {
            let node = self.slaves[active.index].node;
            for axis in 0..3 {
                imposed[3 * node + axis] = active.normal[axis] * active.initial_gap.min(0.0);
            }
        }
        let mut force = vec![0.0; count];
        tangent.mul_vec(&imposed, &mut force);
        force
            .iter()
            .enumerate()
            .filter(|(dof, _)| supports.value(*dof).is_none())
            .map(|(_, value)| value * value)
            .sum::<f64>()
            .sqrt()
    }
}

impl TangentSolver for ContactCg {
    /// Measures the pressures of the closed nodes from the residual, takes
    /// their reactions and the ties' out of it, then updates the active set
    /// (see the module notes).
    fn settle(
        &mut self,
        displacements: &[f64],
        residual: Vec<f64>,
        tangent: &CsrMatrix,
        supports: &Dirichlet,
    ) -> Result<Settled, FemError> {
        let count = self.mesh.dof_count();
        if displacements.len() != count || residual.len() != count {
            return Err(FemError::DisplacementLength {
                len: displacements.len().min(residual.len()),
                count,
            });
        }
        if self.setup.is_none() {
            self.setup = Some(self.set_up(supports)?);
        }
        let Some(setup) = self.setup.as_mut() else {
            return Err(FemError::NonlinearInput {
                reason: String::from("the contact set-up is missing (internal error)"),
            });
        };
        setup.load_scale = setup
            .load_scale
            .max(residual.iter().map(|value| value.abs()).sum());
        if !setup.released {
            setup.spring_force = setup.springs_at(displacements, tangent, supports);
        }
        let balance: Vec<f64> = residual
            .iter()
            .zip(&setup.spring_force)
            .map(|(force, spring)| force - spring)
            .collect();
        let mut free = setup.measure(displacements, &widen(&balance))?;
        let update = setup.update_active_set(self.cg.relative_tolerance, displacements);
        let load = setup.imposed_load(tangent, supports);
        setup.load_scale = setup.load_scale.max(load);
        // Only an iterate balanced under the set it was solved with tells a
        // held body from one nothing holds: one that changes the set or
        // closes an overlap is on its way.
        setup.steady = if update.flipped || update.overlap {
            0
        } else {
            setup.steady + 1
        };
        let mut release = false;
        if setup.steady == 0 {
            for body in &mut setup.loose {
                body.resultant = None;
            }
        } else if setup.released {
            let floor = RESULTANT_FLOOR * self.cg.relative_tolerance * setup.load_scale;
            setup.check_held(&free, self.mesh.vertices(), floor)?;
        } else if self.corrections > 0 {
            // The springs' share is still in this iterate and its reactions:
            // the next corrections take it out.
            setup.released = true;
            setup.spring_force.fill(0.0);
            free = setup.measure(displacements, &widen(&residual))?;
            let floor = RESULTANT_FLOOR * self.cg.relative_tolerance * setup.load_scale;
            setup.check_held(&free, self.mesh.vertices(), floor)?;
            release = true;
        }
        Ok(Settled {
            residual: free,
            pending: update.flipped || update.overlap || release,
            load,
        })
    }

    fn start(
        &mut self,
        tangent: CsrMatrix,
        residual: Vec<f64>,
        prescribed: &Dirichlet,
    ) -> Result<(), FemError> {
        if self.cg.max_iterations == 0 {
            return Err(FemError::InvalidSettings {
                reason: "the iteration budget must be positive",
            });
        }
        let Some(setup) = self.setup.as_ref() else {
            return Err(FemError::NonlinearInput {
                reason: String::from("the contact state was not settled before the solve"),
            });
        };
        let constraints: Vec<NormalConstraint> = setup
            .nodes
            .iter()
            .filter(|active| active.closed)
            .map(|active| {
                let slave = &setup.slaves[active.index];
                NormalConstraint {
                    node: slave.node,
                    normal: active.normal,
                    masters: slave.masters.clone(),
                    weights: slave.weights.clone(),
                    offset: active.gap,
                }
            })
            .collect();
        let (dofs, values): (Vec<u32>, Vec<f64>) = prescribed
            .prescribed()
            .map(|(dof, value)| (widen_dof(to_u32(dof)), value))
            .unzip();
        let stabilised = setup.stabilised(&tangent);
        let PreparedMixed {
            mut prepared,
            reduction,
            ..
        } = prepare_constrained_static(
            &self.mesh,
            stabilised.as_ref().unwrap_or(&tangent),
            &setup.couplings,
            &constraints,
            &dofs,
            &values,
            &widen(
                &residual
                    .iter()
                    .zip(&setup.spring_force)
                    .map(|(force, spring)| force - spring)
                    .collect::<Vec<f64>>(),
            ),
            self.preconditioner,
        )?;
        let run = PcgRun::start(
            prepared.system.as_mut(),
            &prepared.rhs,
            self.cg.relative_tolerance,
            self.cg.stopping,
        )?;
        self.active = Some(ActiveSolve {
            system: prepared.system,
            run,
            reduction,
            tangent,
        });
        Ok(())
    }

    fn advance(&mut self, budget: usize) -> Result<SolveProgress, FemError> {
        let limit = self.cg.max_iterations;
        let solve = self.running()?;
        let before = solve.run.iterations();
        let until = before.saturating_add(budget).min(limit);
        let ready = solve.run.advance(solve.system.as_mut(), until)? == PcgStatus::Converged;
        let iterations = solve.run.iterations() - before;
        if !ready && solve.run.iterations() >= limit {
            return Err(FemError::NotConverged {
                iterations: solve.run.iterations(),
                relative_residual: solve.run.relative_residual(),
                target: solve.run.tolerance(),
            });
        }
        Ok(SolveProgress { iterations, ready })
    }

    fn finish(&mut self) -> Result<(Vec<f64>, CsrMatrix), FemError> {
        let ActiveSolve {
            run,
            reduction,
            tangent,
            ..
        } = self.active.take().ok_or_else(|| FemError::NonlinearInput {
            reason: String::from("no tangent solve has been started"),
        })?;
        let (reduced, _outcome) = run.into_solution()?;
        self.corrections += 1;
        Ok((translations(&reduction.expand(&reduced)), tangent))
    }
}

/// Give each node one contact condition and one side (see the module notes):
/// merge a node's slave shares where their normals agree, else keep the
/// larger; then take every slave node out of the others' masters, the
/// remaining weights scaled back to sum to one, dropping the condition of a
/// node that keeps less than [`KEPT_WEIGHT`] of them. Returns the kept slave
/// nodes in their first order, and the nodes these steps touched, sorted.
fn settle_shared_nodes(chosen: Vec<SlaveNode>) -> (Vec<SlaveNode>, Vec<usize>) {
    let mut shared = BTreeSet::new();
    let mut order: Vec<usize> = Vec::new();
    let mut by_node: BTreeMap<usize, SlaveNode> = BTreeMap::new();
    for slave in chosen {
        match by_node.entry(slave.node) {
            Entry::Vacant(entry) => {
                order.push(slave.node);
                entry.insert(slave);
            }
            Entry::Occupied(mut entry) => {
                let kept = entry.get_mut();
                if dot(kept.normal, slave.normal) >= SAME_SURFACE {
                    *kept = merged(kept, &slave);
                } else {
                    shared.insert(slave.node);
                    if slave.area > kept.area {
                        *kept = slave;
                    }
                }
            }
        }
    }
    let slave_nodes: BTreeSet<usize> = by_node.keys().copied().collect();
    let mut unfollowable = Vec::new();
    for slave in by_node.values_mut() {
        let (masters, weights): (Vec<usize>, Vec<f64>) = slave
            .masters
            .iter()
            .zip(&slave.weights)
            .filter(|&(master, _)| !slave_nodes.contains(master))
            .map(|(&master, &weight)| (master, weight))
            .unzip();
        if masters.len() == slave.masters.len() {
            continue;
        }
        shared.extend(
            slave
                .masters
                .iter()
                .filter(|master| slave_nodes.contains(master)),
        );
        let kept: f64 = weights.iter().sum();
        if kept < KEPT_WEIGHT {
            unfollowable.push(slave.node);
            continue;
        }
        slave.masters = masters;
        slave.weights = weights.iter().map(|weight| weight / kept).collect();
    }
    for node in unfollowable {
        by_node.remove(&node);
        shared.insert(node);
    }
    let slaves = order
        .into_iter()
        .filter_map(|node| by_node.remove(&node))
        .collect();
    (slaves, shared.into_iter().collect())
}

/// One node's two shares of one surface as one condition: the areas summed,
/// the normal and the master weights averaged by area.
fn merged(first: &SlaveNode, second: &SlaveNode) -> SlaveNode {
    let area = first.area + second.area;
    let mut weights: BTreeMap<usize, f64> = BTreeMap::new();
    for share in [first, second] {
        for (&master, &weight) in share.masters.iter().zip(&share.weights) {
            *weights.entry(master).or_default() += weight * share.area / area;
        }
    }
    SlaveNode {
        node: first.node,
        normal: snapped_to_unit(std::array::from_fn(|axis| {
            first.area * first.normal[axis] + second.area * second.normal[axis]
        })),
        masters: weights.keys().copied().collect(),
        weights: weights.values().copied().collect(),
        area,
    }
}

/// `vector` scaled to unit length.
fn snapped_to_unit(vector: [f64; 3]) -> [f64; 3] {
    let length = dot(vector, vector).sqrt();
    vector.map(|component| component / length)
}

/// Three DOFs per node to six (translations, then three zero rotations).
fn widen(values: &[f64]) -> Vec<f64> {
    values
        .chunks(3)
        .flat_map(|node| [node[0], node[1], node[2], 0.0, 0.0, 0.0])
        .collect()
}

/// A 3-per-node DOF in the 6-per-node numbering.
fn widen_dof(dof: u32) -> u32 {
    let node = dof / 3;
    to_u32(DOFS_PER_NODE) * node + dof % 3
}

fn norm(values: &[f64]) -> f64 {
    values.iter().map(|value| value * value).sum::<f64>().sqrt()
}

fn dot(lhs: [f64; 3], rhs: [f64; 3]) -> f64 {
    lhs[0] * rhs[0] + lhs[1] * rhs[1] + lhs[2] * rhs[2]
}

fn to_u32(index: usize) -> u32 {
    #[allow(
        clippy::cast_possible_truncation,
        reason = "DOF indices of a TetMesh fit in u32 (MAX_NODES)"
    )]
    let narrow = index as u32;
    narrow
}
