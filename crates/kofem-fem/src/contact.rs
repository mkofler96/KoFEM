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
//! at the start (gⱼ ≤ 0), so a body that only contact holds is supported
//! from the first solve.
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
//! References: S. Hüeber, B. I. Wohlmuth, "A primal–dual active set strategy
//! for non-linear multibody contact problems", CMAME 194 (2005) 3147–3166;
//! A. Popp, M. W. Gee, W. A. Wall, "A finite deformation mortar contact
//! formulation using a primal–dual active set strategy", IJNME 79 (2009)
//! 1354–1391.

use std::collections::BTreeSet;

use crate::amg::Preconditioner;
use crate::cg::{CgSettings, PcgRun, PcgStatus};
use crate::constraints::Dirichlet;
use crate::coupled_static::{
    constrained_reduction, prepare_constrained_static, CoupledReduction, NormalConstraint,
    PreparedMixed,
};
use crate::coupling::{Coupling, DOFS_PER_NODE};
use crate::error::FemError;
use crate::mesh::{ElementOrder, TetMesh};
use crate::mortar::{mortar_integrals, MortarFace, SlaveIntegrals};
use crate::nonlinear::{Settled, SolveProgress, TangentSolver};
use crate::sparse::CsrMatrix;
use crate::static_solve::PreconditionerChoice;
use crate::surface::BoundaryFaces;
use crate::tie::{tie_couplings, translations, TieReport, VertexTies};

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
        }
        Ok(Self { pairs: both_ways })
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
    /// The ties-only reduction and its held unknowns, to take the reactions
    /// out of a residual.
    tie_reduction: CoupledReduction,
    tie_held: Vec<bool>,
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
            ties: setup.ties,
        })
    }

    /// The ties as couplings, the slave normals as the supports leave them,
    /// the initial gaps and the first active set: the nodes that touch.
    fn set_up(&self, supports: &Dirichlet) -> Result<Setup, FemError> {
        let (fixed_dofs, fixed_values): (Vec<u32>, Vec<f64>) = supports
            .prescribed()
            .map(|(dof, value)| (to_u32(dof), value))
            .unzip();
        let (couplings, ties) = match &self.ties {
            Some(ties) => tie_couplings(&self.mesh, ties, &fixed_dofs, &fixed_values)?,
            None => (Vec::new(), TieReport::default()),
        };
        let slaves = self.slave_sides(supports)?;
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
                closed: initial_gap <= 0.0,
                gap: initial_gap,
                pressure: 0.0,
            });
        }
        let wide_dofs: Vec<u32> = fixed_dofs.iter().map(|&dof| widen_dof(dof)).collect();
        let (tie_reduction, tie_held) =
            constrained_reduction(&self.mesh, &couplings, &[], &wide_dofs, &fixed_values)?;
        Ok(Setup {
            slaves,
            couplings,
            ties,
            nodes,
            held,
            tie_reduction,
            tie_held,
        })
    }

    /// The slave nodes of every pair, each pair the preferred way round
    /// unless its supports hold a slave node along its whole normal while a
    /// master of it can still move — the master would pass through, so the
    /// other side is the slave then.
    ///
    /// # Errors
    /// [`FemError::Contact`] when neither way round avoids that, or when a
    /// node ends up a slave twice, or both a slave and a master.
    fn slave_sides(&self, supports: &Dirichlet) -> Result<Vec<SlaveNode>, FemError> {
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
        for (index, ways) in self.interface.pairs.iter().enumerate() {
            let side = ways
                .iter()
                .filter(|side| !side.is_empty())
                .find(|side| stuck(side).is_none())
                .ok_or_else(|| {
                    let node = ways.iter().find_map(|side| stuck(side)).unwrap_or_default();
                    contact_error(format!(
                        "contact pair {index}: supports hold both surfaces along the contact \
                         normal (at node {node}) where the other surface can still move — \
                         release the support on one of them"
                    ))
                })?;
            chosen.extend(side.iter().cloned());
        }
        let mut slaves = BTreeSet::new();
        for slave in &chosen {
            if !slaves.insert(slave.node) {
                return Err(contact_error(format!(
                    "node {} is on two slave surfaces — a node can be in contact with one \
                     surface only",
                    slave.node
                )));
            }
        }
        if let Some(node) = chosen
            .iter()
            .flat_map(|slave| &slave.masters)
            .find(|master| slaves.contains(master))
        {
            return Err(contact_error(format!(
                "node {node} is on a slave surface and on a master surface — a node can be one \
                 side of contact only"
            )));
        }
        Ok(chosen)
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
    /// penetrate; returns whether the set is unsettled: it changed, or a
    /// closed node's gap is not yet zero (an overlap at the start). Below
    /// `tolerance` (the solve's) times the largest displacement or pressure,
    /// a gap or a pressure carries no sign.
    fn update_active_set(&mut self, tolerance: f64, displacements: &[f64]) -> bool {
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
        let mut pending = self
            .nodes
            .iter()
            .any(|active| active.closed && active.gap.abs() > gap_tolerance);
        for active in &mut self.nodes {
            let flip = if active.closed {
                active.pressure < -pressure_tolerance
            } else {
                active.gap < -gap_tolerance
            };
            if flip {
                active.closed = !active.closed;
                active.pressure = 0.0;
                pending = true;
            }
        }
        pending
    }

    /// The force on the free DOFs of moving each closed node by its gap
    /// along its normal: what the closed nodes still impose.
    fn imposed_load(&self, tangent: &CsrMatrix, supports: &Dirichlet) -> f64 {
        let count = tangent.rows();
        let mut imposed = vec![0.0; count];
        for active in self.nodes.iter().filter(|active| active.closed) {
            let node = self.slaves[active.index].node;
            for axis in 0..3 {
                imposed[3 * node + axis] = active.normal[axis] * active.gap;
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
        let free = setup.measure(displacements, &widen(&residual))?;
        let pending = setup.update_active_set(self.cg.relative_tolerance, displacements);
        let load = setup.imposed_load(tangent, supports);
        Ok(Settled {
            residual: free,
            pending,
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
        let PreparedMixed {
            mut prepared,
            reduction,
            ..
        } = prepare_constrained_static(
            &self.mesh,
            &tangent,
            &setup.couplings,
            &constraints,
            &dofs,
            &values,
            &widen(&residual),
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
        Ok((translations(&reduction.expand(&reduced)), tangent))
    }
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
