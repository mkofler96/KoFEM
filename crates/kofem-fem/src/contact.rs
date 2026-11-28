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
//! the solve is refused with that motion ([`FemError::ContactUnheld`]). Only
//! the part of that force that nothing on the body can react is measured:
//! the closed nodes' normals and the supported DOFs react the rest, which
//! still holds the springs' share of the motions they hold.
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
//! A contact made from picked surfaces ([`ContactCg::from_picked_surfaces`])
//! holds its two bodies wherever they meet, not only on the faces picked.
//! After each correction, a boundary node of one body found behind an outer
//! face of the other, by more than [`OVERLAP_TOLERANCE`] of the model size
//! and less than the face's size, and not already on a contact with that
//! face, makes the contacts grow. Only a node with a face of its own turned
//! toward the face it is behind counts ([`FACING`]), not one round the other
//! body's edge. The surface around the node that faces the other body joins
//! its side, and the surface around the face it passed the other side, each
//! spread over neighbouring faces of one smooth surface within
//! [`SEARCH_FACES`] face sizes of a face of the other body that faces it, so
//! a contact grows over a whole symmetric surface, not one side of it. The
//! contact that already has the passed face grows; a face no contact has
//! starts a contact of its own, so one contact does not mix surfaces turned
//! different ways, and no face ends up in two. Faces whose corners all lie on
//! a grown side join it, so it has no holes. The mortar integrals are then
//! taken anew; slave nodes keep their state and new ones start closed where
//! they overlap, the springs come back into the balance until the set has
//! settled again, and the iterations go on from the displacements reached.
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
use crate::mesh::{cross, ElementOrder, TetMesh};
use crate::mortar::{mortar_integrals, MortarFace, SlaveIntegrals};
use crate::nonlinear::{Settled, SolveProgress, TangentSolver};
use crate::rigid_body::{
    free_rigid_motions, line_direction, normalized, DisjointSets, RigidBodyModel, RigidLink,
    FREE_TOLERANCE,
};
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

/// Below this many times the solve's tolerance and the load, or the
/// round-off in a body's internal force, a resultant is round-off and says
/// nothing about a motion.
const RESULTANT_FLOOR: f64 = 10.0;

/// A node behind an outer face of the other body by more than this fraction
/// of the model size overlaps it (see the module notes); less is round-off.
const OVERLAP_TOLERANCE: f64 = 1e-6;

/// Faces whose normals are at least this far apart (cos 120°) face each
/// other: a contact grows over those only, not round a body's edge.
const FACING: f64 = -0.5;

/// A point this far outside an edge of a face, as a fraction of the edge's
/// length, still lies over the face.
const EDGE_TOLERANCE: f64 = 1e-6;

/// How far from the other body, in face sizes, a contact grows over a
/// surface that faces it.
const SEARCH_FACES: f64 = 2.0;

/// Two slave normals of one node at most this far apart (cos 10°) are one
/// surface picked as two contacts; further apart, the node is a corner.
const SAME_SURFACE: f64 = 0.984_807_753;

/// A slave node that keeps less than this share of its master weights once
/// the other contacts' slave nodes are taken out of them mostly faces the
/// other contact's slave side, and gives up its condition. A node half-way
/// across a master face from the shared edge keeps half.
const KEPT_WEIGHT: f64 = 0.25;

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

/// The rigid motion a load drives a body in that nothing holds: along a line,
/// or about an axis through the body. Both are unit vectors given the way
/// the rigid-body check gives its directions: a coordinate axis exactly,
/// otherwise with the largest component positive.
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
    /// Outer faces the contacts grew over where their bodies overlapped
    /// outside the picked surfaces.
    pub grown_faces: usize,
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

    /// The force and moment / size of a unit force along `direction` at
    /// `point`.
    fn wrench(&self, point: [f64; 3], direction: [f64; 3]) -> [f64; 6] {
        let arm: [f64; 3] = std::array::from_fn(|axis| point[axis] - self.center[axis]);
        let moment = cross(arm, direction);
        [
            direction[0],
            direction[1],
            direction[2],
            moment[0] / self.size,
            moment[1] / self.size,
            moment[2] / self.size,
        ]
    }

    /// The motion a resultant nothing reacts drives: along its force, or
    /// about its moment where that is the larger.
    fn motion(unheld: [f64; 6]) -> UnheldMotion {
        let force = [unheld[0], unheld[1], unheld[2]];
        let moment = [unheld[3], unheld[4], unheld[5]];
        if dot(force, force) >= dot(moment, moment) {
            UnheldMotion::Along(line_direction(force))
        } else {
            UnheldMotion::About(line_direction(moment))
        }
    }

    /// The round-off in the body's internal force `tangent · displacements`:
    /// machine precision times Σ |Kᵢⱼ| |uⱼ| over its rows. A body carried
    /// rigidly across a gap has internal forces that cancel to this.
    fn round_off(&self, tangent: &CsrMatrix, displacements: &[f64]) -> f64 {
        let columns = tangent.columns();
        let values = tangent.values();
        let magnitude: f64 = self
            .nodes
            .iter()
            .flat_map(|&node| (0..3).map(move |axis| 3 * node + axis))
            .flat_map(|row| tangent.row_range(row))
            .map(|entry| (values[entry] * displacements[columns[entry] as usize]).abs())
            .sum();
        f64::EPSILON * magnitude
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

/// `resultant` less its part in the span of `held`, an orthonormal basis.
fn unheld_part(resultant: [f64; 6], held: &[[f64; 6]]) -> [f64; 6] {
    let mut rest = resultant;
    for basis in held {
        let along: f64 = (0..6).map(|index| rest[index] * basis[index]).sum();
        for index in 0..6 {
            rest[index] -= along * basis[index];
        }
    }
    rest
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
    /// For a contact from picked surfaces, what it needs to grow.
    growth: Option<Growth>,
}

/// The picked surfaces of each contact pair and the outer faces of their
/// bodies, for growing the contacts where the bodies overlap.
struct Growth {
    /// The picked vertices of each pair's two sides, for a pair that does
    /// not grow.
    picked: Vec<[Vec<u32>; 2]>,
    /// The body (mesh component) of each pair's two sides; `None` for a pair
    /// whose sides share a body, which does not grow.
    bodies: Vec<Option<[usize; 2]>>,
    /// The outer faces of each body, by component.
    faces: BTreeMap<usize, Vec<OuterFace>>,
    /// Each growing pair's two sides, as indices into its bodies' faces.
    sides: Vec<[BTreeSet<usize>; 2]>,
    /// Faces the pairs held as picked.
    picked_faces: usize,
    grown_faces: usize,
}

/// An outer face of a body, turned to face out of its element.
struct OuterFace {
    face: MortarFace,
    /// Whether the corner order as given turns the face's normal inwards.
    inward: bool,
    /// The outward unit normal on the undeformed geometry.
    normal: [f64; 3],
    /// The longest distance between two corners.
    size: f64,
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
            growth: None,
        }
    }

    /// A contact solve over pairs of picked surfaces, each side given by its
    /// vertices, that grows where the two bodies overlap elsewhere (see the
    /// module notes). Ties and settings as for [`ContactCg::new`].
    ///
    /// # Errors
    /// [`FemError::Contact`] where [`ContactPair::between`] or
    /// [`ContactInterface::new`] refuse the surfaces.
    pub fn from_picked_surfaces(
        mesh: &TetMesh,
        sides: &[(Vec<u32>, Vec<u32>)],
        ties: Option<VertexTies>,
        cg: CgSettings,
        preconditioner: PreconditionerChoice,
    ) -> Result<Self, FemError> {
        let boundary = BoundaryFaces::new(mesh);
        let picked: Vec<[Vec<u32>; 2]> = sides
            .iter()
            .map(|(first, second)| [first.clone(), second.clone()])
            .collect();
        let component = mesh_components(mesh);
        let body_of = |side: &[u32]| -> Option<usize> {
            let mut bodies = side.iter().map(|&vertex| component[vertex as usize]);
            let first = bodies.next()?;
            bodies.all(|body| body == first).then_some(first)
        };
        let bodies: Vec<Option<[usize; 2]>> = picked
            .iter()
            .map(|[first, second]| match (body_of(first), body_of(second)) {
                (Some(first), Some(second)) if first != second => Some([first, second]),
                _ => None,
            })
            .collect();
        let mut faces: BTreeMap<usize, Vec<OuterFace>> = BTreeMap::new();
        for &body in bodies.iter().flatten().flatten() {
            faces.entry(body).or_insert_with(|| {
                boundary
                    .mortar_faces(mesh, |vertex| component[vertex as usize] == body)
                    .into_iter()
                    .map(OuterFace::from)
                    .collect()
            });
        }
        let sides: Vec<[BTreeSet<usize>; 2]> = picked
            .iter()
            .zip(&bodies)
            .map(|(vertices, bodies)| {
                let Some(bodies) = bodies else {
                    return [BTreeSet::new(), BTreeSet::new()];
                };
                std::array::from_fn(|side| {
                    let members: BTreeSet<u32> = vertices[side].iter().copied().collect();
                    faces[&bodies[side]]
                        .iter()
                        .enumerate()
                        .filter(|(_, outer)| {
                            outer
                                .face
                                .nodes
                                .iter()
                                .all(|&node| members.contains(&to_u32(node)))
                        })
                        .map(|(index, _)| index)
                        .collect()
                })
            })
            .collect();
        let growth = Growth {
            picked,
            bodies,
            faces,
            picked_faces: sides.iter().flatten().map(BTreeSet::len).sum(),
            sides,
            grown_faces: 0,
        };
        let interface = growth.interface(mesh, &boundary)?;
        let mut solver = Self::new(mesh, interface, ties, cg, preconditioner);
        solver.growth = Some(growth);
        Ok(solver)
    }

    /// Grow the contacts where their bodies overlap at `displacements` (see
    /// the module notes) and set up their mortar integrals anew; returns
    /// whether any grew.
    fn grow(&mut self, displacements: &[f64]) -> Result<bool, FemError> {
        let Some(growth) = self.growth.as_mut() else {
            return Ok(false);
        };
        let points = self.mesh.vertices();
        let at = |node: usize| -> [f64; 3] {
            std::array::from_fn(|axis| points[node][axis] + displacements[3 * node + axis])
        };
        let tolerance = OVERLAP_TOLERANCE * model_size(points);
        let mut grew = false;
        let body_pairs: BTreeSet<[usize; 2]> = growth
            .bodies
            .iter()
            .flatten()
            .map(|&[first, second]| [first.min(second), first.max(second)])
            .collect();
        for [first, second] in body_pairs {
            for (own, other) in [(first, second), (second, first)] {
                for (node, face) in growth.overlaps(own, other, &at, tolerance) {
                    if growth.faces_toward(own, other, node, face)
                        && !growth.within_contact(own, other, node, face)
                    {
                        grew |= growth.take_overlap(own, other, node, face);
                    }
                }
            }
        }
        if !grew {
            return Ok(false);
        }
        growth.close_sides();
        let boundary = BoundaryFaces::new(&self.mesh);
        self.interface = growth.interface(&self.mesh, &boundary)?;
        growth.grown_faces = growth
            .sides
            .iter()
            .flatten()
            .map(BTreeSet::len)
            .sum::<usize>()
            .saturating_sub(growth.picked_faces);
        Ok(true)
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
            grown_faces: self.growth.as_ref().map_or(0, |growth| growth.grown_faces),
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
    /// Continue from `previous`, the set-up before the contacts grew: a slave
    /// node it had keeps its state, a new one starts closed where it overlaps
    /// at `displacements`. The springs come back into the balance until the
    /// grown set has settled, so nothing drifts along a free motion while it
    /// does.
    fn carry_over(&mut self, previous: &Setup, displacements: &[f64]) {
        let before: BTreeMap<usize, bool> = previous
            .nodes
            .iter()
            .map(|active| (previous.slaves[active.index].node, active.closed))
            .collect();
        for active in &mut self.nodes {
            let slave = &self.slaves[active.index];
            let mut moved = 0.0;
            for axis in 0..3 {
                let followed: f64 = slave
                    .masters
                    .iter()
                    .zip(&slave.weights)
                    .map(|(&master, &weight)| weight * displacements[3 * master + axis])
                    .sum();
                moved += active.normal[axis] * (followed - displacements[3 * slave.node + axis]);
            }
            active.gap = active.initial_gap + moved;
            active.closed = before
                .get(&slave.node)
                .copied()
                .unwrap_or(active.gap <= 0.0);
        }
        self.load_scale = previous.load_scale;
    }

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

    /// Refuse a loose body whose out-of-balance resultant under `free`, less
    /// what holds the body, kept more than [`STALLED`] of the last one, both
    /// measured under one active set with the springs out of the balance (see
    /// the module notes). Resultants below `floor`, or below
    /// [`RESULTANT_FLOOR`] times the round-off in a body's internal force
    /// under `tangent` and `displacements`, are round-off.
    fn check_held(
        &mut self,
        free: &[f64],
        points: &[[f64; 3]],
        supports: &Dirichlet,
        (tangent, displacements): (&CsrMatrix, &[f64]),
        floor: f64,
    ) -> Result<(), FemError> {
        let held: Vec<Vec<[f64; 6]>> = self
            .loose
            .iter()
            .map(|body| self.holding(body, points, supports))
            .collect();
        for (body, held) in self.loose.iter_mut().zip(&held) {
            let now = unheld_part(body.resultant_of(free, points), held);
            let floor = floor.max(RESULTANT_FLOOR * body.round_off(tangent, displacements));
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

    /// An orthonormal basis of the resultants (force, moment / size) that can
    /// act on `body` without moving it: a closed node's pressure along its
    /// normal, on the body's slave node or its masters, and a support's
    /// reaction on each DOF it holds.
    fn holding(
        &self,
        body: &LooseBody,
        points: &[[f64; 3]],
        supports: &Dirichlet,
    ) -> Vec<[f64; 6]> {
        let on_body = |node: usize| body.nodes.binary_search(&node).is_ok();
        let pressures = self
            .nodes
            .iter()
            .filter(|active| active.closed)
            .map(|active| {
                let slave = &self.slaves[active.index];
                let mut wrench = [0.0; 6];
                let mut add = |node: usize, weight: f64| {
                    let unit = body.wrench(points[node], active.normal);
                    for index in 0..6 {
                        wrench[index] += weight * unit[index];
                    }
                };
                if on_body(slave.node) {
                    add(slave.node, 1.0);
                }
                for (&master, &weight) in slave.masters.iter().zip(&slave.weights) {
                    if on_body(master) {
                        add(master, weight);
                    }
                }
                wrench
            });
        let reactions = body.nodes.iter().flat_map(|&node| {
            (0..3)
                .filter(move |&axis| supports.value(3 * node + axis).is_some())
                .map(move |axis| {
                    let mut direction = [0.0; 3];
                    direction[axis] = 1.0;
                    body.wrench(points[node], direction)
                })
        });
        let mut basis: Vec<[f64; 6]> = Vec::new();
        for wrench in pressures.chain(reactions) {
            if basis.len() == 6 {
                break;
            }
            let length = norm(&wrench);
            if length == 0.0 {
                continue;
            }
            let rest = unheld_part(wrench, &basis);
            let left = norm(&rest);
            if left > FREE_TOLERANCE * length {
                basis.push(rest.map(|value| value / left));
            }
        }
        basis
    }

    /// `residual` less the springs' force: what the iterate leaves out of
    /// balance.
    fn balance(&self, residual: &[f64]) -> Vec<f64> {
        residual
            .iter()
            .zip(&self.spring_force)
            .map(|(force, spring)| force - spring)
            .collect()
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
        let grew = self.corrections > 0 && self.grow(displacements)?;
        if grew || self.setup.is_none() {
            let mut setup = self.set_up(supports)?;
            if let Some(previous) = self.setup.take() {
                setup.carry_over(&previous, displacements);
            }
            self.setup = Some(setup);
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
        let balance = setup.balance(&residual);
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
            setup.check_held(
                &free,
                self.mesh.vertices(),
                supports,
                (tangent, displacements),
                floor,
            )?;
        } else if self.corrections > 0 {
            // The springs' share is still in this iterate and its reactions:
            // the next corrections take it out.
            setup.released = true;
            setup.spring_force.fill(0.0);
            free = setup.measure(displacements, &widen(&residual))?;
            let floor = RESULTANT_FLOOR * self.cg.relative_tolerance * setup.load_scale;
            setup.check_held(
                &free,
                self.mesh.vertices(),
                supports,
                (tangent, displacements),
                floor,
            )?;
            release = true;
        }
        Ok(Settled {
            residual: free,
            pending: update.flipped || update.overlap || release || grew,
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
            &widen(&setup.balance(&residual)),
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
    let weighted: [f64; 3] = std::array::from_fn(|axis| {
        first.area * first.normal[axis] + second.area * second.normal[axis]
    });
    SlaveNode {
        node: first.node,
        normal: normalized(weighted),
        masters: weights.keys().copied().collect(),
        weights: weights.values().copied().collect(),
        area,
    }
}

impl From<MortarFace> for OuterFace {
    fn from(face: MortarFace) -> Self {
        let normal = newell(&face.points);
        let center = centroid(&face.points);
        let outward: f64 = (0..3)
            .map(|axis| normal[axis] * (center[axis] - face.element_centroid[axis]))
            .sum();
        let mut size: f64 = 0.0;
        for first in &face.points {
            for second in &face.points {
                let gap: [f64; 3] = std::array::from_fn(|axis| first[axis] - second[axis]);
                size = size.max(dot(gap, gap).sqrt());
            }
        }
        let size = size;
        let length = dot(normal, normal).sqrt();
        let sign = if outward < 0.0 { -1.0 } else { 1.0 };
        Self {
            face,
            inward: outward < 0.0,
            normal: normal.map(|component| sign * component / length),
            size,
        }
    }
}

impl OuterFace {
    /// How far `point` is behind the face at the positions `at`, if it lies
    /// over the face (its projection inside it); positive behind.
    fn depth_behind(&self, point: [f64; 3], at: &impl Fn(usize) -> [f64; 3]) -> Option<f64> {
        let corners: Vec<[f64; 3]> = self.face.nodes.iter().map(|&node| at(node)).collect();
        let mut normal = newell(&corners);
        if self.inward {
            normal = normal.map(|component| -component);
        }
        let length = dot(normal, normal).sqrt();
        if length == 0.0 {
            return None;
        }
        let normal = normal.map(|component| component / length);
        let center = centroid(&corners);
        let offset: [f64; 3] = std::array::from_fn(|axis| point[axis] - center[axis]);
        let depth = -dot(normal, offset);
        // Over the face: on the inner side of every edge, seen along the
        // normal. A point on an edge, as where two bodies' edges line up,
        // is over it too: [`EDGE_TOLERANCE`] keeps round-off from deciding.
        let inside = (0..corners.len()).all(|index| {
            let start = corners[index];
            let end = corners[(index + 1) % corners.len()];
            let edge: [f64; 3] = std::array::from_fn(|axis| end[axis] - start[axis]);
            let to_point: [f64; 3] = std::array::from_fn(|axis| point[axis] - start[axis]);
            dot(cross(edge, to_point), normal) >= -EDGE_TOLERANCE * dot(edge, edge)
        });
        inside.then_some(depth)
    }
}

impl Growth {
    /// The boundary nodes of body `own` behind an outer face of body `other`
    /// by more than `tolerance` and less than the face's size, with the index
    /// of the deepest such face.
    fn overlaps(
        &self,
        own: usize,
        other: usize,
        at: &impl Fn(usize) -> [f64; 3],
        tolerance: f64,
    ) -> Vec<(usize, usize)> {
        let (Some(own_faces), Some(other_faces)) = (self.faces.get(&own), self.faces.get(&other))
        else {
            return Vec::new();
        };
        let mut low = [f64::INFINITY; 3];
        let mut high = [f64::NEG_INFINITY; 3];
        for face in other_faces {
            for &node in &face.face.nodes {
                let point = at(node);
                for axis in 0..3 {
                    low[axis] = low[axis].min(point[axis]);
                    high[axis] = high[axis].max(point[axis]);
                }
            }
        }
        let nodes: BTreeSet<usize> = own_faces
            .iter()
            .flat_map(|face| face.face.nodes.iter().copied())
            .collect();
        let mut found = Vec::new();
        for node in nodes {
            let point = at(node);
            if (0..3).any(|axis| point[axis] < low[axis] || point[axis] > high[axis]) {
                continue;
            }
            let deepest = other_faces
                .iter()
                .enumerate()
                .filter_map(|(index, face)| {
                    face.depth_behind(point, at)
                        .filter(|&depth| depth > tolerance && depth < face.size)
                        .map(|depth| (index, depth))
                })
                .max_by(|first, second| first.1.total_cmp(&second.1));
            if let Some((face, _)) = deepest {
                found.push((node, face));
            }
        }
        found
    }

    /// Whether node `node` of body `own` has a face of its own turned toward
    /// face `face` of body `other` ([`FACING`]): a node behind a face it
    /// turns away from, as round a body's edge, is no contact.
    fn faces_toward(&self, own: usize, other: usize, node: usize, face: usize) -> bool {
        let (Some(own_faces), Some(other_faces)) = (self.faces.get(&own), self.faces.get(&other))
        else {
            return false;
        };
        let passed = &other_faces[face];
        own_faces.iter().any(|candidate| {
            candidate.face.nodes.contains(&node) && dot(candidate.normal, passed.normal) <= FACING
        })
    }

    /// The pairs between bodies `own` and `other`, with which of their sides
    /// is `own`'s and which `other`'s.
    fn pairs_between(&self, own: usize, other: usize) -> Vec<(usize, usize, usize)> {
        (0..self.sides.len())
            .filter_map(|pair| match self.bodies[pair]? {
                [first, second] if first == own && second == other => Some((pair, 0, 1)),
                [first, second] if first == other && second == own => Some((pair, 1, 0)),
                _ => None,
            })
            .collect()
    }

    /// Whether node `node` is a corner of a face on side `side` of pair
    /// `pair`.
    fn side_has_node(&self, pair: usize, side: usize, node: usize) -> bool {
        let Some(bodies) = self.bodies[pair] else {
            return false;
        };
        let faces = &self.faces[&bodies[side]];
        self.sides[pair][side]
            .iter()
            .any(|&index| faces[index].face.nodes.contains(&node))
    }

    /// Whether face `index` of body `body` is on a side of a pair other than
    /// `pair`.
    fn in_other_pair(&self, pair: usize, body: usize, index: usize) -> bool {
        (0..self.sides.len()).any(|other| {
            other != pair
                && self.bodies[other].is_some_and(|bodies| {
                    (0..2).any(|side| {
                        bodies[side] == body && self.sides[other][side].contains(&index)
                    })
                })
        })
    }

    /// Whether node `node` of body `own` and face `face` of body `other` are
    /// both on contacts between the two already, the same or two that meet:
    /// an overlap there is the mortar method's own.
    fn within_contact(&self, own: usize, other: usize, node: usize, face: usize) -> bool {
        let pairs = self.pairs_between(own, other);
        pairs
            .iter()
            .any(|&(pair, own_side, _)| self.side_has_node(pair, own_side, node))
            && pairs
                .iter()
                .any(|&(pair, _, other_side)| self.sides[pair][other_side].contains(&face))
    }

    /// Take node `node` of body `own` found at face `face` of body `other`
    /// into a contact between the two (see the module notes); returns
    /// whether a contact grew.
    fn take_overlap(&mut self, own: usize, other: usize, node: usize, face: usize) -> bool {
        let pairs = self.pairs_between(own, other);
        let holding = pairs
            .iter()
            .find(|&&(pair, _, other_side)| self.sides[pair][other_side].contains(&face))
            .copied();
        // A face no contact has starts a contact of its own (index one past
        // the last), so one contact does not mix surfaces turned different
        // ways.
        let (pair, own_side, other_side, new_pair) = match holding {
            Some((pair, own_side, other_side)) => (pair, own_side, other_side, false),
            None if pairs.is_empty() => return false,
            None => (self.sides.len(), 0, 1, true),
        };
        if !new_pair && self.side_has_node(pair, own_side, node) {
            // Inside the contact already: the mortar method's own overlap.
            return false;
        }
        let own_faces = &self.faces[&own];
        let other_faces = &self.faces[&other];
        let passed = &other_faces[face];
        // The surface around the node that faces the other body, and the
        // surface around the passed face that faces back: grown as a whole,
        // so a contact does not grow over one side of a symmetric surface
        // and leave the other.
        let seeds: Vec<usize> = own_faces
            .iter()
            .enumerate()
            .filter(|(_, candidate)| candidate.face.nodes.contains(&node))
            .filter(|(_, candidate)| dot(candidate.normal, passed.normal) <= FACING)
            .map(|(index, _)| index)
            .collect();
        let added: Vec<usize> = facing_surface(own_faces, &seeds, other_faces)
            .into_iter()
            .filter(|&index| !self.in_other_pair(pair, own, index))
            .collect();
        let added_other: Vec<usize> = if new_pair {
            facing_surface(other_faces, &[face], own_faces)
                .into_iter()
                .filter(|&index| !self.in_other_pair(pair, other, index))
                .collect()
        } else {
            Vec::new()
        };
        if new_pair {
            if added.is_empty() || added_other.is_empty() {
                return false;
            }
            self.picked.push([Vec::new(), Vec::new()]);
            self.bodies.push(Some([own, other]));
            self.sides.push([BTreeSet::new(), BTreeSet::new()]);
        }
        let before = self.sides[pair][own_side].len() + self.sides[pair][other_side].len();
        self.sides[pair][own_side].extend(added);
        self.sides[pair][other_side].extend(added_other);
        self.sides[pair][own_side].len() + self.sides[pair][other_side].len() > before
    }

    /// Fill the holes growing leaves: a face of a side's body whose corners
    /// are all on the side, turned within [`FACING`] of a side face it
    /// shares a corner with, joins the side unless another pair has it.
    fn close_sides(&mut self) {
        for pair in 0..self.sides.len() {
            let Some(bodies) = self.bodies[pair] else {
                continue;
            };
            for side in 0..2 {
                let faces = &self.faces[&bodies[side]];
                let on_side = &self.sides[pair][side];
                let corners: BTreeSet<usize> = on_side
                    .iter()
                    .flat_map(|&index| faces[index].face.nodes.iter().copied())
                    .collect();
                let holes: Vec<usize> = faces
                    .iter()
                    .enumerate()
                    .filter(|(index, candidate)| {
                        !on_side.contains(index)
                            && candidate
                                .face
                                .nodes
                                .iter()
                                .all(|node| corners.contains(node))
                            && on_side.iter().any(|&member| {
                                faces[member]
                                    .face
                                    .nodes
                                    .iter()
                                    .any(|node| candidate.face.nodes.contains(node))
                                    && dot(faces[member].normal, candidate.normal) >= -FACING
                            })
                    })
                    .map(|(index, _)| index)
                    .filter(|&index| !self.in_other_pair(pair, bodies[side], index))
                    .collect();
                self.sides[pair][side].extend(holes);
            }
        }
    }

    /// The contact interface of the pairs as they stand: a growing pair's
    /// faces, the finer side the slave; a pair that does not grow from its
    /// picked vertices.
    fn interface(
        &self,
        mesh: &TetMesh,
        boundary: &BoundaryFaces,
    ) -> Result<ContactInterface, FemError> {
        let pairs = (0..self.picked.len())
            .map(|index| {
                let named = |error: FemError| match error {
                    FemError::Contact { reason } => {
                        contact_error(format!("contact pair {index}: {reason}"))
                    }
                    other => other,
                };
                let Some(bodies) = self.bodies[index] else {
                    let [first, second] = &self.picked[index];
                    return ContactPair::between(mesh, boundary, first, second).map_err(named);
                };
                let [first, second]: [Vec<MortarFace>; 2] = std::array::from_fn(|side| {
                    self.sides[index][side]
                        .iter()
                        .map(|&face| self.faces[&bodies[side]][face].face.clone())
                        .collect()
                });
                if let Some(name) = [&first, &second]
                    .iter()
                    .position(|faces| faces.is_empty())
                    .map(|side| if side == 0 { "A" } else { "B" })
                {
                    return Err(named(contact_error(format!(
                        "side {name} of the contact names no whole boundary face — pick the \
                         faces of a solid's surface"
                    ))));
                }
                Ok(if mean_area(&first) <= mean_area(&second) {
                    ContactPair {
                        slave: first,
                        master: second,
                    }
                } else {
                    ContactPair {
                        slave: second,
                        master: first,
                    }
                })
            })
            .collect::<Result<Vec<_>, _>>()?;
        ContactInterface::new(mesh, &pairs)
    }
}

/// The faces of `faces` reached from `seeds` across shared corners, each
/// turned within [`SAME_SURFACE`] of the face it was reached from (one smooth
/// surface) and within [`SEARCH_FACES`] of its size of a face of `opposite`
/// that faces it ([`FACING`]), on the undeformed geometry.
fn facing_surface(faces: &[OuterFace], seeds: &[usize], opposite: &[OuterFace]) -> BTreeSet<usize> {
    let center = |face: &OuterFace| centroid(&face.face.points);
    let near_opposite = |face: &OuterFace| {
        let own = center(face);
        let reach = SEARCH_FACES * face.size;
        opposite.iter().any(|other| {
            let gap: [f64; 3] = std::array::from_fn(|axis| own[axis] - center(other)[axis]);
            dot(face.normal, other.normal) <= FACING && dot(gap, gap).sqrt() <= reach + other.size
        })
    };
    let mut reached: BTreeSet<usize> = seeds.iter().copied().collect();
    let mut queue: Vec<usize> = seeds.to_vec();
    while let Some(current) = queue.pop() {
        let from = &faces[current];
        for (index, candidate) in faces.iter().enumerate() {
            if reached.contains(&index)
                || !candidate
                    .face
                    .nodes
                    .iter()
                    .any(|node| from.face.nodes.contains(node))
                || dot(candidate.normal, from.normal) < SAME_SURFACE
                || !near_opposite(candidate)
            {
                continue;
            }
            reached.insert(index);
            queue.push(index);
        }
    }
    reached
}

/// The mean area of `faces`.
fn mean_area(faces: &[MortarFace]) -> f64 {
    faces
        .iter()
        .map(|face| polygon_area(&face.points))
        .sum::<f64>()
        / count_as_f64(faces.len())
}

/// The piece of the mesh its elements hold together that each vertex is in.
fn mesh_components(mesh: &TetMesh) -> Vec<usize> {
    let mut sets = DisjointSets::new(mesh.vertex_count());
    for element in 0..mesh.element_count() {
        if let Some((&first, rest)) = mesh.element_nodes(element).split_first() {
            for &node in rest {
                sets.join(first as usize, node as usize);
            }
        }
    }
    (0..mesh.vertex_count())
        .map(|node| sets.root(node))
        .collect()
}

/// The diagonal of the bounding box of `points`; 1 for a degenerate one.
fn model_size(points: &[[f64; 3]]) -> f64 {
    let mut low = [f64::INFINITY; 3];
    let mut high = [f64::NEG_INFINITY; 3];
    for point in points {
        for axis in 0..3 {
            low[axis] = low[axis].min(point[axis]);
            high[axis] = high[axis].max(point[axis]);
        }
    }
    let extent: [f64; 3] = std::array::from_fn(|axis| high[axis] - low[axis]);
    let size = dot(extent, extent).sqrt();
    if size.is_finite() && size > 0.0 {
        size
    } else {
        1.0
    }
}

/// Twice the area vector of a polygon (Newell).
fn newell(points: &[[f64; 3]]) -> [f64; 3] {
    let mut normal = [0.0; 3];
    for (index, current) in points.iter().enumerate() {
        let next = points[(index + 1) % points.len()];
        normal[0] += (current[1] - next[1]) * (current[2] + next[2]);
        normal[1] += (current[2] - next[2]) * (current[0] + next[0]);
        normal[2] += (current[0] - next[0]) * (current[1] + next[1]);
    }
    normal
}

fn centroid(points: &[[f64; 3]]) -> [f64; 3] {
    let count = count_as_f64(points.len());
    std::array::from_fn(|axis| points.iter().map(|point| point[axis]).sum::<f64>() / count)
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
