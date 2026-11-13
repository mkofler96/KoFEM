// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Surface-to-point couplings as master–slave DOF equations, ported from the
//! engine's `coupling_constraints.cpp`.
//!
//! DOFs are numbered 6·node + component, components 0..2 the translations and
//! 3..5 the rotations. A coupling ties a reference node to a set of other
//! nodes; building the constraints turns each into equations "dependent DOF =
//! linear combination of other DOFs", and [`CouplingConstraints::resolve_chains`]
//! rewrites them until every one references independent DOFs only, which a
//! one-pass reduction `K_r = TᵀKT` needs.
//!
//! * Distributing (RBE3): the reference node's six DOFs are dependent — the
//!   weighted mean translation of the coupled nodes and their weighted
//!   least-squares rotation. It adds no stiffness, so the coupled surface
//!   stays flexible, but the point can only be loaded, never fixed or driven.
//! * Kinematic (RBE2): the coupled nodes are dependent and follow the
//!   reference node as a rigid body, `u_i = u_R + θ_R × r_i`. The point stays
//!   independent, so it can be fixed, loaded or tied onward; the coupled
//!   surface becomes rigid.
//! * Relaxed MPC: the shell-to-solid seam variant of the distributing
//!   coupling (Lu, Zhang & Yang 2023) — a shell node follows the
//!   distance-weighted centroid of its solid patch and a relaxed
//!   least-squares rotation of it, so the tie stays local.
//! * Shell footprint: a solid node on the footprint of a shell edge follows
//!   that edge with Kirchhoff section kinematics, `u = Σ Nᵢ (uᵢ + θᵢ × r)`.

use std::collections::BTreeMap;

use crate::error::FemError;

/// Unknowns per node in the coupling numbering: three translations, then
/// three rotations.
pub const DOFS_PER_NODE: usize = 6;

/// All six DOFs: what a kinematic coupling ties unless told otherwise.
pub const ALL_DOFS: u8 = 0x3f;

/// How a coupling joins its reference node to its coupled nodes.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum CouplingKind {
    /// RBE3: the reference node follows the weighted mean of the coupled nodes.
    Distributing,
    /// RBE2: the coupled nodes follow the reference node rigidly. Bit c of
    /// `dof_mask` ties DOF c (0..2 translations, 3..5 rotations) of every
    /// coupled node. A rotation bit only acts on a coupled node that has
    /// rotational DOFs (another reference node); a solid node has none.
    Kinematic { dof_mask: u8 },
    /// Relaxed shell-to-solid MPC (Lu, Zhang & Yang, "A Relaxed MPC Method
    /// for Non-rigid Shell to Solid Coupling", J. Phys.: Conf. Ser. 2528
    /// 012064, 2023), generalised to a non-conforming seam: the reference
    /// (shell) node's translations follow the 1/(d² + ε²)-weighted centroid
    /// of its coupled solid nodes, and its rotations `relaxation` times their
    /// weighted least-squares rotation about it. Anchoring on the centroid
    /// rather than the nearest node keeps an equidistant pair of wall-face
    /// nodes from welding the mid-surface to one face (KOF-212).
    RelaxedMpc { relaxation: f64 },
    /// Shell footprint: the reference node is a solid node on a shell edge's
    /// footprint, and its translations follow the two edge nodes (the
    /// coupled nodes, with partition-of-unity `weights`) as a Kirchhoff
    /// section, `u = Σ wᵢ (uᵢ + θᵢ × (x − Σ wⱼ xⱼ))`. Its rotations are not
    /// tied: a solid node has none.
    ShellFootprint,
}

/// One coupling over node indices.
#[derive(Debug, Clone, PartialEq)]
pub struct Coupling {
    pub reference: usize,
    pub nodes: Vec<usize>,
    /// One weight per coupled node; empty means equal weights. Only a
    /// distributing coupling reads them.
    pub weights: Vec<f64>,
    pub kind: CouplingKind,
}

/// Index of "no row" in [`CouplingConstraints`]' row table.
const NO_ROW: u32 = u32::MAX;

/// Master–slave equations over 6·nodes DOFs: each dependent DOF equals a
/// linear combination (DOF, coefficient) of other DOFs.
#[derive(Debug, Clone)]
pub struct CouplingConstraints {
    /// Row of each DOF in `rows`, or `NO_ROW` for an independent DOF.
    row_of: Vec<u32>,
    rows: Vec<Vec<(usize, f64)>>,
    /// The dependent DOF of each row.
    dof_of_row: Vec<usize>,
}

impl CouplingConstraints {
    /// Express every coupling as master–slave equations. `points` holds one
    /// coordinate triple per node; `has_rotation[n]` marks the nodes whose
    /// rotations are unknowns of the system (coupling reference nodes) — a
    /// rotation cannot be tied on a node that has none.
    ///
    /// # Errors
    /// [`FemError::Coupling`] for an out-of-range or repeated node, too few
    /// coupled nodes, bad weights, a kinematic coupling that ties nothing, or
    /// a distributing patch whose rotation cannot be measured (nodes on one
    /// line through the reference point); [`FemError::CouplingDofConflict`] for a DOF two couplings
    /// both eliminate.
    pub fn build(
        points: &[[f64; 3]],
        couplings: &[Coupling],
        has_rotation: &[bool],
    ) -> Result<Self, FemError> {
        let node_count = points.len();
        if has_rotation.len() != node_count {
            return Err(FemError::CouplingInput {
                reason: format!(
                    "{} rotation flags for {node_count} nodes",
                    has_rotation.len()
                ),
            });
        }
        let mut constraints = Self {
            row_of: vec![NO_ROW; DOFS_PER_NODE * node_count],
            rows: Vec::new(),
            dof_of_row: Vec::new(),
        };
        for (index, coupling) in couplings.iter().enumerate() {
            let fail = |reason: String| FemError::Coupling {
                coupling: index,
                reason,
            };
            let reference = coupling.reference;
            if reference >= node_count {
                return Err(fail(format!(
                    "reference node {reference} is out of range (the model has {node_count} nodes)"
                )));
            }
            for &node in &coupling.nodes {
                if node >= node_count {
                    return Err(fail(format!(
                        "coupled node {node} is out of range (the model has {node_count} nodes)"
                    )));
                }
                if node == reference {
                    return Err(fail(format!(
                        "node {node} is coupled to itself as its own reference node"
                    )));
                }
            }
            match coupling.kind {
                CouplingKind::Kinematic { dof_mask } => {
                    constraints.add_kinematic(points, coupling, dof_mask, has_rotation, &fail)?;
                }
                CouplingKind::Distributing => {
                    constraints.add_distributing(points, coupling, &fail)?;
                }
                CouplingKind::RelaxedMpc { relaxation } => {
                    constraints.add_relaxed_mpc(points, coupling, relaxation, &fail)?;
                }
                CouplingKind::ShellFootprint => {
                    constraints.add_shell_footprint(points, coupling, has_rotation, &fail)?;
                }
            }
        }
        Ok(constraints)
    }

    fn add_kinematic(
        &mut self,
        points: &[[f64; 3]],
        coupling: &Coupling,
        dof_mask: u8,
        has_rotation: &[bool],
        fail: &impl Fn(String) -> FemError,
    ) -> Result<(), FemError> {
        // u_i = u_R + θ_R × r: component c gains +θ_PLUS[c]·r[MINUS[c]] and
        // −θ_MINUS[c]·r[PLUS[c]] (x: +θy·rz − θz·ry, and cyclically).
        const PLUS: [usize; 3] = [1, 2, 0];
        const MINUS: [usize; 3] = [2, 0, 1];
        if coupling.nodes.is_empty() {
            return Err(fail(
                "a kinematic coupling needs at least one coupled node".into(),
            ));
        }
        if dof_mask & ALL_DOFS == 0 {
            return Err(fail("the kinematic coupling ties no DOF at all".into()));
        }
        let reference = coupling.reference;
        let origin = points[reference];
        let base = DOFS_PER_NODE * reference;
        for &node in &coupling.nodes {
            let offset = sub(points[node], origin);
            for component in 0..3 {
                if dof_mask & (1 << component) == 0 {
                    continue;
                }
                self.add_row(
                    node,
                    component,
                    vec![
                        (base + component, 1.0),
                        (base + 3 + PLUS[component], offset[MINUS[component]]),
                        (base + 3 + MINUS[component], -offset[PLUS[component]]),
                    ],
                )?;
            }
            if !has_rotation[node] {
                continue;
            }
            for axis in 0..3 {
                if dof_mask & (1 << (3 + axis)) != 0 {
                    self.add_row(node, 3 + axis, vec![(base + 3 + axis, 1.0)])?;
                }
            }
        }
        Ok(())
    }

    fn add_distributing(
        &mut self,
        points: &[[f64; 3]],
        coupling: &Coupling,
        fail: &impl Fn(String) -> FemError,
    ) -> Result<(), FemError> {
        let weights = patch_weights(coupling, "distributing", fail)?;
        let total: f64 = weights.iter().sum();
        let origin = points[coupling.reference];
        let offsets: Vec<[f64; 3]> = coupling
            .nodes
            .iter()
            .map(|&node| sub(points[node], origin))
            .collect();
        // S = Σ wᵢ rᵢ and the weighted inertia H = Σ wᵢ (|rᵢ|² I − rᵢ rᵢᵀ).
        let mut moment = [0.0; 3];
        let mut inertia = [[0.0; 3]; 3];
        for (offset, &weight) in offsets.iter().zip(&weights) {
            let squared = dot(*offset, *offset);
            for row in 0..3 {
                moment[row] += weight * offset[row];
                for column in 0..3 {
                    let identity = if row == column { squared } else { 0.0 };
                    inertia[row][column] += weight * (identity - offset[row] * offset[column]);
                }
            }
        }
        let inverse = invert(&inertia).ok_or_else(|| {
            fail(
                "the coupled nodes lie on one line through the reference point, so no rotation \
                 can be measured from them — pick a surface, or make the coupling kinematic"
                    .into(),
            )
        })?;
        let skew_moment = skew(moment);
        let mut rows = <[Vec<(usize, f64)>; DOFS_PER_NODE]>::default();
        for ((&node, offset), &weight) in coupling.nodes.iter().zip(&offsets).zip(&weights) {
            let share = weight / total;
            // U_R = Σ (wᵢ/W) uᵢ.
            for (component, row) in rows.iter_mut().take(3).enumerate() {
                row.push((DOFS_PER_NODE * node + component, share));
            }
            // Θ_R = H⁻¹ · Σ (wᵢ [rᵢ]× − (wᵢ/W) [S]×) uᵢ.
            let skew_offset = skew(*offset);
            let mut inner = [[0.0; 3]; 3];
            for row in 0..3 {
                for column in 0..3 {
                    inner[row][column] =
                        weight * skew_offset[row][column] - share * skew_moment[row][column];
                }
            }
            let map = multiply(&inverse, &inner);
            for (axis, row) in rows.iter_mut().skip(3).enumerate() {
                for (component, &coefficient) in map[axis].iter().enumerate() {
                    row.push((DOFS_PER_NODE * node + component, coefficient));
                }
            }
        }
        for (component, row) in rows.into_iter().enumerate() {
            self.add_row(coupling.reference, component, row)?;
        }
        Ok(())
    }

    /// The relaxed shell-to-solid MPC (see [`CouplingKind::RelaxedMpc`]),
    /// as `coupling_constraints.cpp` builds it.
    fn add_relaxed_mpc(
        &mut self,
        points: &[[f64; 3]],
        coupling: &Coupling,
        relaxation: f64,
        fail: &impl Fn(String) -> FemError,
    ) -> Result<(), FemError> {
        if !relaxation.is_finite() {
            return Err(fail(format!(
                "the relaxation must be finite, got {relaxation}"
            )));
        }
        let mut weights = patch_weights(coupling, "shell-to-solid MPC", fail)?;
        let origin = points[coupling.reference];
        let radius = coupling
            .nodes
            .iter()
            .map(|&node| norm(sub(points[node], origin)))
            .fold(0.0, f64::max);
        if radius <= 0.0 {
            return Err(fail(format!(
                "every coupled node sits on the reference point {}, so the patch has no extent \
                 and no rotation can be measured from it",
                coupling.reference
            )));
        }
        // ε softens the kernel at d → 0 and is a fraction of the patch's own
        // radius, so the weighting is scale-free.
        let softening = (0.05 * radius).powi(2);
        for (weight, &node) in weights.iter_mut().zip(&coupling.nodes) {
            let offset = sub(points[node], origin);
            *weight /= dot(offset, offset) + softening;
        }
        let total: f64 = weights.iter().sum();
        if !(total.is_finite() && total > 0.0) {
            return Err(fail("the weights sum to zero".into()));
        }
        // Anchor on the weighted centroid: Σ wᵢ rᵢ = 0 about it, which drops
        // the translation out of the least-squares rotation.
        let mut anchor = [0.0; 3];
        for (&weight, &node) in weights.iter().zip(&coupling.nodes) {
            for (axis, value) in anchor.iter_mut().enumerate() {
                *value += weight / total * points[node][axis];
            }
        }
        let offsets: Vec<[f64; 3]> = coupling
            .nodes
            .iter()
            .map(|&node| sub(points[node], anchor))
            .collect();
        let mut inertia = [[0.0; 3]; 3];
        for (offset, &weight) in offsets.iter().zip(&weights) {
            let squared = dot(*offset, *offset);
            for row in 0..3 {
                for column in 0..3 {
                    let identity = if row == column { squared } else { 0.0 };
                    inertia[row][column] += weight * (identity - offset[row] * offset[column]);
                }
            }
        }
        let inverse = invert(&inertia).ok_or_else(|| {
            fail(
                "the coupled solid nodes lie on one line, so no rotation can be measured from \
                 them"
                    .into(),
            )
        })?;
        let mut rows = <[Vec<(usize, f64)>; DOFS_PER_NODE]>::default();
        for ((&node, offset), &weight) in coupling.nodes.iter().zip(&offsets).zip(&weights) {
            // U_R = Σ (wᵢ/W) uᵢ.
            for (component, row) in rows.iter_mut().take(3).enumerate() {
                row.push((DOFS_PER_NODE * node + component, weight / total));
            }
            // Θ_R = ψ · H⁻¹ · Σ wᵢ [rᵢ]× uᵢ.
            let map = multiply(&inverse, &skew(*offset));
            for (axis, row) in rows.iter_mut().skip(3).enumerate() {
                for (component, &coefficient) in map[axis].iter().enumerate() {
                    row.push((
                        DOFS_PER_NODE * node + component,
                        relaxation * weight * coefficient,
                    ));
                }
            }
        }
        for (component, row) in rows.into_iter().enumerate() {
            self.add_row(coupling.reference, component, row)?;
        }
        Ok(())
    }

    /// The shell footprint (see [`CouplingKind::ShellFootprint`]), as
    /// `coupling_constraints.cpp` builds it.
    fn add_shell_footprint(
        &mut self,
        points: &[[f64; 3]],
        coupling: &Coupling,
        has_rotation: &[bool],
        fail: &impl Fn(String) -> FemError,
    ) -> Result<(), FemError> {
        if coupling.nodes.len() != 2 || coupling.weights.len() != 2 {
            return Err(fail(format!(
                "a shell footprint needs two shell edge nodes and two weights, got {} and {}",
                coupling.nodes.len(),
                coupling.weights.len()
            )));
        }
        let mut anchor = [0.0; 3];
        let mut total = 0.0;
        for (&node, &weight) in coupling.nodes.iter().zip(&coupling.weights) {
            if !has_rotation[node] {
                return Err(fail(format!(
                    "edge node {node} is not a shell node, so it has no rotation for the \
                     section to follow"
                )));
            }
            if !(weight.is_finite() && (0.0..=1.0).contains(&weight)) {
                return Err(fail(format!(
                    "footprint weights must lie in [0, 1], got {weight}"
                )));
            }
            total += weight;
            for (axis, value) in anchor.iter_mut().enumerate() {
                *value += weight * points[node][axis];
            }
        }
        if (total - 1.0).abs() > 1e-10 {
            return Err(fail(format!(
                "footprint weights must sum to one, got {total}"
            )));
        }
        // u_S = Σ Nᵢ (uᵢ + θᵢ × r) = Σ Nᵢ (uᵢ − [r]× θᵢ): partition of unity
        // and interpolation of the anchor reproduce rigid motion, and the
        // transpose transfers the same resultant and moment.
        let rotation = skew(sub(points[coupling.reference], anchor));
        for (component, rotation_row) in rotation.iter().enumerate() {
            let mut row = Vec::with_capacity(8);
            for (&node, &weight) in coupling.nodes.iter().zip(&coupling.weights) {
                row.push((DOFS_PER_NODE * node + component, weight));
                for (axis, &entry) in rotation_row.iter().enumerate() {
                    row.push((DOFS_PER_NODE * node + 3 + axis, -weight * entry));
                }
            }
            self.add_row(coupling.reference, component, row)?;
        }
        Ok(())
    }

    fn add_row(
        &mut self,
        node: usize,
        component: usize,
        row: Vec<(usize, f64)>,
    ) -> Result<(), FemError> {
        let dof = DOFS_PER_NODE * node + component;
        if self.row_of[dof] != NO_ROW {
            return Err(FemError::CouplingDofConflict { node, component });
        }
        self.row_of[dof] = to_u32(self.rows.len());
        self.rows.push(row);
        self.dof_of_row.push(dof);
        Ok(())
    }

    /// Make the translations of `node` follow the mean of the two `ends`
    /// wherever both ends follow a coupling and `node` does not already:
    /// the linear interpolation along an edge whose mid-edge node lies at
    /// its middle. A component in which either end is independent stays
    /// independent. Returns how many components were tied.
    ///
    /// # Errors
    /// [`FemError::CouplingInput`] for a node or end out of range.
    pub fn follow_edge_ends(&mut self, node: usize, ends: [usize; 2]) -> Result<usize, FemError> {
        let node_count = self.row_of.len() / DOFS_PER_NODE;
        if let Some(&outside) = [node, ends[0], ends[1]]
            .iter()
            .find(|&&index| index >= node_count)
        {
            return Err(FemError::CouplingInput {
                reason: format!(
                    "edge node {node} between {} and {}: node {outside} is out of range \
                     (the model has {node_count} nodes)",
                    ends[0], ends[1]
                ),
            });
        }
        let mut tied = 0;
        for component in 0..3 {
            let dof = |index: usize| DOFS_PER_NODE * index + component;
            if self.is_dependent(dof(node))
                || !self.is_dependent(dof(ends[0]))
                || !self.is_dependent(dof(ends[1]))
            {
                continue;
            }
            self.add_row(
                node,
                component,
                vec![(dof(ends[0]), 0.5), (dof(ends[1]), 0.5)],
            )?;
            tied += 1;
        }
        Ok(tied)
    }

    /// Substitute dependent DOFs out of each other's rows until every row
    /// references independent DOFs only. Couplings compose — a reference
    /// point can idealise a surface and at the same time be tied to a second
    /// point — and the one-pass reduction needs each row in independent DOFs.
    ///
    /// # Errors
    /// [`FemError::CouplingCycle`] when constraints depend on each other in a
    /// loop, which has no elimination order.
    pub fn resolve_chains(&mut self) -> Result<(), FemError> {
        #[derive(Clone, Copy, PartialEq)]
        enum State {
            Unvisited,
            InProgress,
            Resolved,
        }
        let mut state = vec![State::Unvisited; self.rows.len()];
        let mut stack: Vec<usize> = Vec::new();
        for start in 0..self.rows.len() {
            if state[start] == State::Resolved {
                continue;
            }
            stack.push(start);
            while let Some(&row) = stack.last() {
                match state[row] {
                    State::Resolved => {
                        stack.pop();
                    }
                    State::InProgress => {
                        // Every dependent DOF this row references is resolved
                        // by now, so one substitution leaves independent DOFs.
                        let mut flat: BTreeMap<usize, f64> = BTreeMap::new();
                        for &(dof, coefficient) in &self.rows[row] {
                            match self.row_of[dof] {
                                NO_ROW => *flat.entry(dof).or_default() += coefficient,
                                other => {
                                    for &(inner, factor) in &self.rows[other as usize] {
                                        *flat.entry(inner).or_default() += coefficient * factor;
                                    }
                                }
                            }
                        }
                        self.rows[row] = flat.into_iter().collect();
                        state[row] = State::Resolved;
                        stack.pop();
                    }
                    State::Unvisited => {
                        state[row] = State::InProgress;
                        let own = self.dof_of_row[row];
                        for &(dof, _) in &self.rows[row] {
                            let other = self.row_of[dof];
                            if other == NO_ROW {
                                continue;
                            }
                            match state[other as usize] {
                                State::InProgress => {
                                    return Err(FemError::CouplingCycle {
                                        first: own / DOFS_PER_NODE,
                                        second: dof / DOFS_PER_NODE,
                                    })
                                }
                                State::Unvisited => stack.push(other as usize),
                                State::Resolved => {}
                            }
                        }
                    }
                }
            }
        }
        Ok(())
    }

    /// DOFs in the numbering (6 per node).
    #[must_use]
    pub fn dof_count(&self) -> usize {
        self.row_of.len()
    }

    /// The combination `dof` equals, or `None` for an independent DOF.
    #[must_use]
    pub fn row(&self, dof: usize) -> Option<&[(usize, f64)]> {
        match self.row_of[dof] {
            NO_ROW => None,
            row => Some(&self.rows[row as usize]),
        }
    }

    #[must_use]
    pub fn is_dependent(&self, dof: usize) -> bool {
        self.row_of[dof] != NO_ROW
    }
}

/// The weights of a patch coupling (distributing or relaxed MPC): one per
/// coupled node, finite and non-negative, not all zero; equal when absent.
fn patch_weights(
    coupling: &Coupling,
    what: &str,
    fail: &impl Fn(String) -> FemError,
) -> Result<Vec<f64>, FemError> {
    let count = coupling.nodes.len();
    if count < 3 {
        return Err(fail(format!(
            "a {what} coupling needs at least 3 coupled nodes, got {count}"
        )));
    }
    let weights = if coupling.weights.is_empty() {
        vec![1.0; count]
    } else if coupling.weights.len() == count {
        coupling.weights.clone()
    } else {
        return Err(fail(format!(
            "{} weights for {count} coupled nodes",
            coupling.weights.len()
        )));
    };
    if let Some(&weight) = weights
        .iter()
        .find(|&&weight| !(weight.is_finite() && weight >= 0.0))
    {
        return Err(fail(format!(
            "weights must be finite and non-negative, got {weight}"
        )));
    }
    if weights.iter().sum::<f64>() <= 0.0 {
        return Err(fail("the weights sum to zero".into()));
    }
    Ok(weights)
}

fn to_u32(index: usize) -> u32 {
    #[allow(
        clippy::cast_possible_truncation,
        reason = "at most one row per DOF, and DOFs fit in u32 (checked by the caller)"
    )]
    let narrow = index as u32;
    narrow
}

fn sub(lhs: [f64; 3], rhs: [f64; 3]) -> [f64; 3] {
    [lhs[0] - rhs[0], lhs[1] - rhs[1], lhs[2] - rhs[2]]
}

fn dot(lhs: [f64; 3], rhs: [f64; 3]) -> f64 {
    lhs[0] * rhs[0] + lhs[1] * rhs[1] + lhs[2] * rhs[2]
}

fn norm(vector: [f64; 3]) -> f64 {
    dot(vector, vector).sqrt()
}

/// [a]×, so that [a]×·b = a × b.
fn skew(vector: [f64; 3]) -> [[f64; 3]; 3] {
    [
        [0.0, -vector[2], vector[1]],
        [vector[2], 0.0, -vector[0]],
        [-vector[1], vector[0], 0.0],
    ]
}

fn multiply(lhs: &[[f64; 3]; 3], rhs: &[[f64; 3]; 3]) -> [[f64; 3]; 3] {
    let mut out = [[0.0; 3]; 3];
    for row in 0..3 {
        for column in 0..3 {
            out[row][column] = (0..3)
                .map(|inner| lhs[row][inner] * rhs[inner][column])
                .sum();
        }
    }
    out
}

/// Inverse of a symmetric positive semi-definite 3×3 matrix, or `None` when
/// it is singular relative to its own size (a patch of collinear points).
fn invert(matrix: &[[f64; 3]; 3]) -> Option<[[f64; 3]; 3]> {
    let cofactor = |row: usize, column: usize| -> f64 {
        let (r0, r1) = ((row + 1) % 3, (row + 2) % 3);
        let (c0, c1) = ((column + 1) % 3, (column + 2) % 3);
        matrix[r0][c0] * matrix[r1][c1] - matrix[r0][c1] * matrix[r1][c0]
    };
    let determinant: f64 = (0..3)
        .map(|column| matrix[0][column] * cofactor(0, column))
        .sum();
    let trace = matrix[0][0] + matrix[1][1] + matrix[2][2];
    // A collinear patch has one zero principal inertia: det ≈ 0 against
    // (trace/3)³, the determinant of an isotropic patch of the same size.
    if !(determinant.is_finite() && determinant > 1e-12 * (trace / 3.0).powi(3)) {
        return None;
    }
    let mut out = [[0.0; 3]; 3];
    for (row, line) in out.iter_mut().enumerate() {
        for (column, value) in line.iter_mut().enumerate() {
            // The inverse is the transposed cofactor matrix over the determinant.
            *value = cofactor(column, row) / determinant;
        }
    }
    Some(out)
}
