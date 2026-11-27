// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Which rigid-body motion a model's supports leave free (KOF-388).
//!
//! A body that can still slide or spin has a singular stiffness matrix, and the
//! solve fails somewhere inside the preconditioner or the CG loop with a message
//! about numbers, not about the model. This check runs before the solve and says
//! which body is loose and how, from the connectivity and the supports alone.
//!
//! Each piece of mesh that hangs together through its elements (a component)
//! moves rigidly with six parameters: a translation `t` and a rotation `ω` about
//! the component's centroid `c`, so a node at `x` moves by `t + ω × (x − c)` and
//! a node with rotation DOFs (a shell node, a reference point) also turns by
//! `ω`. Every support asks one DOF of that motion to vanish; every link asks two
//! components to move alike at a point:
//!
//! - a coupling ties its dependent nodes to the reference point on the DOFs of
//!   its mask (rotations only where a node has them),
//! - a tie ties each node of one surface to the components of the other on the
//!   translations.
//!
//! The rigid motions left free are the null space of these equations. Each
//! equation is scaled to unit norm and folded into a small triangular factor
//! per component (or per linked pair) as it is read, so the whole check is one
//! pass over the supports and links plus dense algebra on six unknowns per
//! component. Components that their own supports hold are eliminated first,
//! and the hold is passed on through their links, so the dense step usually
//! sees only the loose components.
//!
//! What it does not see is a mechanism inside one component (a hinge in a
//! single body's mesh): the mesh is assumed to be stiff where it is connected.

use std::collections::{HashMap, HashSet};

use crate::count::count_as_f64;
use crate::error::FemError;

/// Six rigid-body modes: three translations, three rotations.
const MODES: usize = 6;

/// A singular value of the unit-row constraint matrix below this fraction of
/// the largest (and of 1) marks a free motion. Free motions come out at
/// rounding level (~1e-16); a real hold is no weaker than the lever arm of a
/// support relative to the model size, so the gap between the two is wide.
const FREE_TOLERANCE: f64 = 1e-9;

/// A component whose free motions are below this, as a fraction of a unit free
/// motion of its cluster, does not move in it.
const MOTION_TOLERANCE: f64 = 1e-6;

/// Two components that must move alike at points: each `secondary` node moves
/// with every component a `primary` node is in, on the DOFs of `dof_mask`
/// (bit d for DOF d: 0..2 translations, 3..5 rotations).
pub struct RigidLink {
    pub primary: Vec<u32>,
    pub secondary: Vec<u32>,
    pub dof_mask: u8,
}

/// What the check reads, all in node indices.
pub struct RigidBodyModel<'a> {
    /// Node coordinates, three per node.
    pub positions: &'a [f64],
    /// Element connectivity as offsets into `element_nodes`, one more than
    /// there are elements, starting at 0.
    pub element_offsets: &'a [u32],
    pub element_nodes: &'a [u32],
    /// The label of each element (the body it belongs to), reported back for
    /// a loose component.
    pub element_labels: &'a [u32],
    /// Nodes that carry rotation DOFs: shell nodes and reference points.
    pub rotational_nodes: &'a [u32],
    pub links: &'a [RigidLink],
    /// Supported DOFs, `6·node + dof`, fixed or prescribed alike. A rotation
    /// support on a node without rotation DOFs restrains nothing.
    pub fixed_dofs: &'a [u32],
}

/// A loose component: the labels of its elements and the motion still free,
/// as orthonormal directions. A free rotation about an axis through any point
/// is reported by the axis direction. A direction along a coordinate axis is
/// exactly that unit axis.
#[derive(Debug, Clone, PartialEq)]
pub struct FreeMotion {
    pub labels: Vec<u32>,
    pub translations: Vec<[f64; 3]>,
    pub rotation_axes: Vec<[f64; 3]>,
}

fn invalid(reason: String) -> FemError {
    FemError::RigidBodyInput { reason }
}

/// The loose components of a model, ordered by their first label. Empty when
/// the supports hold every component that has elements.
///
/// # Errors
/// [`FemError::RigidBodyInput`] when an array is inconsistent: positions not a
/// multiple of three or not finite, offsets that do not describe the element
/// nodes, a label count that is not the element count, a node index out of
/// range, or a DOF mask beyond six DOFs.
pub fn free_rigid_motions(model: &RigidBodyModel<'_>) -> Result<Vec<FreeMotion>, FemError> {
    let node_count = validate(model)?;
    let components = Components::new(model, node_count);
    let mut rows = RowSets::default();
    rows.add_supports(model, &components);
    rows.add_links(model, &components);
    let held = rows.propagate_holds(components.count);
    Ok(rows.free_motions(&components, &held))
}

fn validate(model: &RigidBodyModel<'_>) -> Result<usize, FemError> {
    let RigidBodyModel {
        positions,
        element_offsets,
        element_nodes,
        element_labels,
        rotational_nodes,
        links,
        fixed_dofs,
    } = model;
    if !positions.len().is_multiple_of(3) {
        return Err(invalid(format!(
            "{} position values is not a multiple of 3",
            positions.len()
        )));
    }
    if let Some(index) = positions.iter().position(|value| !value.is_finite()) {
        return Err(invalid(format!(
            "node {} has a coordinate that is not a finite number",
            index / 3
        )));
    }
    let node_count = positions.len() / 3;
    if element_offsets.first() != Some(&0) {
        return Err(invalid("element offsets must start at 0".to_owned()));
    }
    if element_offsets.windows(2).any(|pair| pair[1] < pair[0]) {
        return Err(invalid("element offsets must not decrease".to_owned()));
    }
    if element_offsets.last().map(|&last| last as usize) != Some(element_nodes.len()) {
        return Err(invalid(format!(
            "element offsets end at {:?}, but there are {} element nodes",
            element_offsets.last(),
            element_nodes.len()
        )));
    }
    if element_labels.len() + 1 != element_offsets.len() {
        return Err(invalid(format!(
            "{} labels for {} elements",
            element_labels.len(),
            element_offsets.len() - 1
        )));
    }
    let check = |nodes: &[u32], what: &str| -> Result<(), FemError> {
        match nodes.iter().find(|&&node| node as usize >= node_count) {
            Some(node) => Err(invalid(format!(
                "{what} names node {node}, but the model has {node_count} nodes"
            ))),
            None => Ok(()),
        }
    };
    check(element_nodes, "an element")?;
    check(rotational_nodes, "the rotational node list")?;
    for (index, link) in links.iter().enumerate() {
        check(&link.primary, &format!("link {index}"))?;
        check(&link.secondary, &format!("link {index}"))?;
        if link.dof_mask > 0b11_1111 {
            return Err(invalid(format!(
                "link {index} has DOF mask {:#b}, beyond the six DOFs of a node",
                link.dof_mask
            )));
        }
    }
    if let Some(dof) = fixed_dofs
        .iter()
        .find(|&&dof| dof as usize / MODES >= node_count)
    {
        return Err(invalid(format!(
            "support DOF {dof} is on node {}, but the model has {node_count} nodes",
            *dof as usize / MODES
        )));
    }
    Ok(node_count)
}

// ── Components ────────────────────────────────────────────────────────────────

/// Union–find over nodes with path halving.
struct DisjointSets {
    parent: Vec<usize>,
}

impl DisjointSets {
    fn new(count: usize) -> Self {
        Self {
            parent: (0..count).collect(),
        }
    }

    fn root(&mut self, mut node: usize) -> usize {
        while self.parent[node] != node {
            self.parent[node] = self.parent[self.parent[node]];
            node = self.parent[node];
        }
        node
    }

    fn join(&mut self, first: usize, second: usize) {
        let (first, second) = (self.root(first), self.root(second));
        if first != second {
            self.parent[second] = first;
        }
    }
}

/// The mesh split into the pieces its elements hold together. A node in no
/// element (a reference point) is a component of its own.
struct Components {
    count: usize,
    of_node: Vec<usize>,
    centers: Vec<[f64; 3]>,
    labels: Vec<Vec<u32>>,
    rotational: Vec<bool>,
    positions: Vec<[f64; 3]>,
    /// The model size the rotations are scaled by, so that a translation and
    /// a rotation of one unit move the model by comparable amounts.
    scale: f64,
}

impl Components {
    fn new(model: &RigidBodyModel<'_>, node_count: usize) -> Self {
        let mut sets = DisjointSets::new(node_count);
        for element in model.element_offsets.windows(2) {
            let nodes = &model.element_nodes[element[0] as usize..element[1] as usize];
            if let Some((&first, rest)) = nodes.split_first() {
                for &node in rest {
                    sets.join(first as usize, node as usize);
                }
            }
        }
        let mut index_of_root = vec![usize::MAX; node_count];
        let mut of_node = vec![0; node_count];
        let mut count = 0;
        for (node, slot) in of_node.iter_mut().enumerate() {
            let root = sets.root(node);
            if index_of_root[root] == usize::MAX {
                index_of_root[root] = count;
                count += 1;
            }
            *slot = index_of_root[root];
        }
        let positions: Vec<[f64; 3]> = model.positions.as_chunks::<3>().0.to_vec();
        let mut sums = vec![[0.0; 3]; count];
        let mut sizes = vec![0_usize; count];
        for (node, point) in positions.iter().enumerate() {
            let component = of_node[node];
            sizes[component] += 1;
            for axis in 0..3 {
                sums[component][axis] += point[axis];
            }
        }
        let centers = sums
            .iter()
            .zip(&sizes)
            .map(|(sum, &size)| {
                let size = count_as_f64(size);
                [sum[0] / size, sum[1] / size, sum[2] / size]
            })
            .collect();
        let mut label_sets = vec![Vec::new(); count];
        for (element, &label) in model.element_labels.iter().enumerate() {
            let first = model.element_offsets[element] as usize;
            if first < model.element_offsets[element + 1] as usize {
                label_sets[of_node[model.element_nodes[first] as usize]].push(label);
            }
        }
        let labels = label_sets
            .into_iter()
            .map(|mut list: Vec<u32>| {
                list.sort_unstable();
                list.dedup();
                list
            })
            .collect();
        let mut rotational = vec![false; node_count];
        for &node in model.rotational_nodes {
            rotational[node as usize] = true;
        }
        Self {
            count,
            of_node,
            centers,
            labels,
            rotational,
            scale: model_size(&positions),
            positions,
        }
    }

    /// Row of DOF `dof` of the rigid motion of `component`, evaluated at
    /// `point`, over the parameters (t, s) with s = scale·ω.
    fn motion_row(&self, component: usize, point: [f64; 3], dof: usize) -> [f64; MODES] {
        let center = self.centers[component];
        let arm = [
            (point[0] - center[0]) / self.scale,
            (point[1] - center[1]) / self.scale,
            (point[2] - center[2]) / self.scale,
        ];
        let mut row = [0.0; MODES];
        match dof {
            // u = t + ω × arm: the d-th component of ω × arm, per ω_k.
            0 => row = [1.0, 0.0, 0.0, 0.0, arm[2], -arm[1]],
            1 => row = [0.0, 1.0, 0.0, -arm[2], 0.0, arm[0]],
            2 => row = [0.0, 0.0, 1.0, arm[1], -arm[0], 0.0],
            // θ = ω; the 1/scale is dropped as each row is normalized anyway.
            _ => row[dof] = 1.0,
        }
        row
    }
}

/// The diagonal of the model's bounding box; 1 for a model of one point, where
/// any length is as good as another.
fn model_size(positions: &[[f64; 3]]) -> f64 {
    let mut low = [f64::INFINITY; 3];
    let mut high = [f64::NEG_INFINITY; 3];
    for point in positions {
        for axis in 0..3 {
            low[axis] = low[axis].min(point[axis]);
            high[axis] = high[axis].max(point[axis]);
        }
    }
    let diagonal = (0..3)
        .map(|axis| (high[axis] - low[axis]).powi(2))
        .sum::<f64>()
        .sqrt();
    if diagonal.is_finite() && diagonal > 0.0 {
        diagonal
    } else {
        1.0
    }
}

// ── Constraint rows, folded as they are read ─────────────────────────────────

/// The upper-triangular factor `R` of a stack of rows (`RᵀR = Σ rowᵀ·row`), kept
/// by Givens rotations so a million rows cost no memory.
#[derive(Clone)]
struct Triangle<const N: usize> {
    rows: [[f64; N]; N],
}

impl<const N: usize> Triangle<N> {
    fn new() -> Self {
        Self {
            rows: [[0.0; N]; N],
        }
    }

    /// Add one row, scaled to unit norm (a zero row adds nothing).
    fn add(&mut self, mut row: [f64; N]) {
        let norm = row.iter().map(|value| value * value).sum::<f64>().sqrt();
        if norm == 0.0 {
            return;
        }
        for value in &mut row {
            *value /= norm;
        }
        for pivot in 0..N {
            if row[pivot] == 0.0 {
                continue;
            }
            let diagonal = self.rows[pivot][pivot];
            let radius = diagonal.hypot(row[pivot]);
            let (cos, sin) = (diagonal / radius, row[pivot] / radius);
            for column in pivot..N {
                let (upper, lower) = (self.rows[pivot][column], row[column]);
                self.rows[pivot][column] = cos * upper + sin * lower;
                row[column] = cos * lower - sin * upper;
            }
        }
    }

    fn is_full_rank(&self) -> bool {
        let columns = (0..N)
            .map(|column| (0..N).map(|row| self.rows[row][column]).collect())
            .collect();
        free_columns(&svd(columns).sigma).is_empty()
    }
}

#[derive(Default)]
struct RowSets {
    /// Rows on one component: its supports, and links to held components.
    own: HashMap<usize, Triangle<MODES>>,
    /// Rows linking two components, keyed (lower, higher) and laid out as the
    /// lower one's six parameters, then the higher one's.
    pairs: HashMap<(usize, usize), Triangle<{ 2 * MODES }>>,
}

impl RowSets {
    fn add_supports(&mut self, model: &RigidBodyModel<'_>, components: &Components) {
        for &dof in model.fixed_dofs {
            let (node, local) = (dof as usize / MODES, dof as usize % MODES);
            if local >= 3 && !components.rotational[node] {
                continue;
            }
            let component = components.of_node[node];
            let row = components.motion_row(component, components.positions[node], local);
            self.own
                .entry(component)
                .or_insert_with(Triangle::new)
                .add(row);
        }
    }

    fn add_links(&mut self, model: &RigidBodyModel<'_>, components: &Components) {
        for link in model.links {
            let primary_rotational = link
                .primary
                .iter()
                .any(|&node| components.rotational[node as usize]);
            let mut primaries: Vec<usize> = link
                .primary
                .iter()
                .map(|&node| components.of_node[node as usize])
                .collect();
            primaries.sort_unstable();
            primaries.dedup();
            for &node in &link.secondary {
                let node = node as usize;
                let secondary = components.of_node[node];
                let rotational = primary_rotational || components.rotational[node];
                for &primary in &primaries {
                    if primary == secondary {
                        continue;
                    }
                    let (lower, higher) = (primary.min(secondary), primary.max(secondary));
                    let pair = self
                        .pairs
                        .entry((lower, higher))
                        .or_insert_with(Triangle::new);
                    let point = components.positions[node];
                    for dof in 0..MODES {
                        if link.dof_mask & (1 << dof) == 0 || (dof >= 3 && !rotational) {
                            continue;
                        }
                        // Both components move the point alike: lower − higher = 0.
                        let first = components.motion_row(lower, point, dof);
                        let second = components.motion_row(higher, point, dof);
                        let mut row = [0.0; 2 * MODES];
                        for mode in 0..MODES {
                            row[mode] = first[mode];
                            row[MODES + mode] = -second[mode];
                        }
                        pair.add(row);
                    }
                }
            }
        }
    }

    /// Mark every component its own rows hold, and pass each hold on: a link to
    /// a held component is a support of the other one.
    fn propagate_holds(&mut self, count: usize) -> Vec<bool> {
        let mut held = vec![false; count];
        let mut partners: HashMap<usize, Vec<(usize, usize)>> = HashMap::new();
        for &(lower, higher) in self.pairs.keys() {
            partners.entry(lower).or_default().push((lower, higher));
            partners.entry(higher).or_default().push((lower, higher));
        }
        let mut queue: Vec<usize> = self
            .own
            .iter()
            .filter(|(_, triangle)| triangle.is_full_rank())
            .map(|(&component, _)| component)
            .collect();
        for &component in &queue {
            held[component] = true;
        }
        while let Some(component) = queue.pop() {
            let Some(keys) = partners.get(&component) else {
                continue;
            };
            for &(lower, higher) in keys {
                let (other, offset) = if lower == component {
                    (higher, MODES)
                } else {
                    (lower, 0)
                };
                if held[other] {
                    continue;
                }
                let Some(pair) = self.pairs.get(&(lower, higher)) else {
                    continue;
                };
                let own = self.own.entry(other).or_insert_with(Triangle::new);
                for row in &pair.rows {
                    let mut restricted = [0.0; MODES];
                    restricted.copy_from_slice(&row[offset..offset + MODES]);
                    own.add(restricted);
                }
                if own.is_full_rank() {
                    held[other] = true;
                    queue.push(other);
                }
            }
        }
        held
    }

    /// The loose components that have elements, with their free motions.
    fn free_motions(&self, components: &Components, held: &[bool]) -> Vec<FreeMotion> {
        let mut sets = DisjointSets::new(components.count);
        for &(lower, higher) in self.pairs.keys() {
            if !held[lower] && !held[higher] {
                sets.join(lower, higher);
            }
        }
        let mut clusters: HashMap<usize, Vec<usize>> = HashMap::new();
        for (component, &is_held) in held.iter().enumerate() {
            if !is_held {
                clusters
                    .entry(sets.root(component))
                    .or_default()
                    .push(component);
            }
        }
        let mut motions = Vec::new();
        for members in clusters.values() {
            if members
                .iter()
                .any(|&member| !components.labels[member].is_empty())
            {
                motions.extend(self.cluster_motions(members, components));
            }
        }
        motions.sort_by(|first, second| first.labels.cmp(&second.labels));
        motions
    }

    /// The null space of a cluster of loose components, read per component.
    fn cluster_motions(&self, members: &[usize], components: &Components) -> Vec<FreeMotion> {
        let column_of: HashMap<usize, usize> = members
            .iter()
            .enumerate()
            .map(|(index, &member)| (member, MODES * index))
            .collect();
        let width = MODES * members.len();
        let mut rows: Vec<Vec<f64>> = Vec::new();
        for &member in members {
            if let Some(own) = self.own.get(&member) {
                for row in &own.rows {
                    let mut wide = vec![0.0; width];
                    wide[column_of[&member]..column_of[&member] + MODES].copy_from_slice(row);
                    rows.push(wide);
                }
            }
        }
        let inside: HashSet<usize> = members.iter().copied().collect();
        for (&(lower, higher), pair) in &self.pairs {
            if !inside.contains(&lower) || !inside.contains(&higher) {
                continue;
            }
            for row in &pair.rows {
                let mut wide = vec![0.0; width];
                wide[column_of[&lower]..column_of[&lower] + MODES].copy_from_slice(&row[..MODES]);
                wide[column_of[&higher]..column_of[&higher] + MODES].copy_from_slice(&row[MODES..]);
                rows.push(wide);
            }
        }
        let columns = (0..width)
            .map(|column| rows.iter().map(|row| row[column]).collect())
            .collect();
        let decomposition = svd(columns);
        let null: Vec<&Vec<f64>> = free_columns(&decomposition.sigma)
            .into_iter()
            .map(|column| &decomposition.right[column])
            .collect();
        if null.is_empty() {
            return Vec::new();
        }
        members
            .iter()
            .filter(|&&member| !components.labels[member].is_empty())
            .filter_map(|&member| {
                let start = column_of[&member];
                let block = null
                    .iter()
                    .map(|vector| vector[start..start + MODES].to_vec())
                    .collect();
                describe(block).map(|directions| FreeMotion {
                    labels: components.labels[member].clone(),
                    translations: directions.translations,
                    rotation_axes: directions.rotation_axes,
                })
            })
            .collect()
    }
}

// ── Dense algebra ─────────────────────────────────────────────────────────────

/// `A = U·Σ·Vᵀ`, from the columns of `A`: `av` holds the columns of `A·V`
/// (`= U·Σ`), `sigma` their norms, `right` the columns of `V`.
struct Svd {
    av: Vec<Vec<f64>>,
    sigma: Vec<f64>,
    right: Vec<Vec<f64>>,
}

/// One-sided Jacobi SVD (Hestenes): rotate pairs of columns until all are
/// orthogonal. Accurate for the small singular values the check decides on,
/// unlike an eigen-solve of `AᵀA`, which squares them into the rounding.
fn svd(mut columns: Vec<Vec<f64>>) -> Svd {
    let width = columns.len();
    let mut right: Vec<Vec<f64>> = (0..width)
        .map(|column| {
            let mut unit = vec![0.0; width];
            unit[column] = 1.0;
            unit
        })
        .collect();
    for _sweep in 0..60 {
        let mut rotated = false;
        for first in 0..width {
            for second in first + 1..width {
                let alpha: f64 = columns[first].iter().map(|value| value * value).sum();
                let beta: f64 = columns[second].iter().map(|value| value * value).sum();
                let gamma: f64 = columns[first]
                    .iter()
                    .zip(&columns[second])
                    .map(|(left, right)| left * right)
                    .sum();
                if gamma == 0.0 || gamma.abs() <= 1e-15 * (alpha * beta).sqrt() {
                    continue;
                }
                rotated = true;
                let zeta = (beta - alpha) / (2.0 * gamma);
                let tangent = zeta.signum() / (zeta.abs() + zeta.hypot(1.0));
                let cos = 1.0 / tangent.hypot(1.0);
                let sin = cos * tangent;
                for matrix in [&mut columns, &mut right] {
                    let (head, tail) = matrix.split_at_mut(second);
                    for (left, right) in head[first].iter_mut().zip(tail[0].iter_mut()) {
                        let (old_left, old_right) = (*left, *right);
                        *left = cos * old_left - sin * old_right;
                        *right = sin * old_left + cos * old_right;
                    }
                }
            }
        }
        if !rotated {
            break;
        }
    }
    let sigma = columns
        .iter()
        .map(|column| column.iter().map(|value| value * value).sum::<f64>().sqrt())
        .collect();
    Svd {
        av: columns,
        sigma,
        right,
    }
}

/// The columns whose singular value marks a free motion.
fn free_columns(sigma: &[f64]) -> Vec<usize> {
    let largest = sigma.iter().copied().fold(1.0, f64::max);
    (0..sigma.len())
        .filter(|&column| sigma[column] <= FREE_TOLERANCE * largest)
        .collect()
}

/// Free directions of one component, as [`FreeMotion`] reports them.
struct Directions {
    translations: Vec<[f64; 3]>,
    rotation_axes: Vec<[f64; 3]>,
}

/// The free translations and rotation axes in a component's block of a null
/// space (one six-vector per null vector); `None` when the block does not move.
fn describe(block: Vec<Vec<f64>>) -> Option<Directions> {
    let decomposition = svd(block);
    let largest = decomposition.sigma.iter().copied().fold(0.0, f64::max);
    if largest <= MOTION_TOLERANCE {
        return None;
    }
    // An orthonormal basis of the motions this component can make.
    let motions: Vec<Vec<f64>> = decomposition
        .av
        .iter()
        .zip(&decomposition.sigma)
        .filter(|&(_, &sigma)| sigma > MOTION_TOLERANCE * largest)
        .map(|(column, &sigma)| column.iter().map(|value| value / sigma).collect())
        .collect();
    let rotations = svd(motions.iter().map(|motion| motion[3..].to_vec()).collect());
    let mut rotation_axes = Vec::new();
    let mut translations = Vec::new();
    for (column, &sigma) in rotations.sigma.iter().enumerate() {
        if sigma > MOTION_TOLERANCE {
            let axis = &rotations.av[column];
            rotation_axes.push([axis[0] / sigma, axis[1] / sigma, axis[2] / sigma]);
        } else {
            // A combination of the motions that turns nothing: a translation.
            let mut direction = [0.0; 3];
            for (motion, weight) in motions.iter().zip(&rotations.right[column]) {
                for axis in 0..3 {
                    direction[axis] += weight * motion[axis];
                }
            }
            translations.push(normalized(direction));
        }
    }
    Some(Directions {
        translations: axis_basis(&translations),
        rotation_axes: axis_basis(&rotation_axes),
    })
}

fn normalized(vector: [f64; 3]) -> [f64; 3] {
    let norm = vector.iter().map(|value| value * value).sum::<f64>().sqrt();
    [vector[0] / norm, vector[1] / norm, vector[2] / norm]
}

/// An orthonormal basis of the span of `vectors` (orthonormal already), made of
/// coordinate axes as far as the span contains them, then the rest with its
/// sign chosen so the largest component is positive.
fn axis_basis(vectors: &[[f64; 3]]) -> Vec<[f64; 3]> {
    let mut basis: Vec<[f64; 3]> = Vec::new();
    for axis in 0..3 {
        let inside: f64 = vectors
            .iter()
            .map(|vector| vector[axis] * vector[axis])
            .sum();
        if inside > 1.0 - 1e-9 {
            let mut unit = [0.0; 3];
            unit[axis] = 1.0;
            basis.push(unit);
        }
    }
    for vector in vectors {
        if basis.len() == vectors.len() {
            break;
        }
        let mut rest = *vector;
        for unit in &basis {
            let along: f64 = (0..3).map(|axis| rest[axis] * unit[axis]).sum();
            for axis in 0..3 {
                rest[axis] -= along * unit[axis];
            }
        }
        let norm = rest.iter().map(|value| value * value).sum::<f64>().sqrt();
        if norm > MOTION_TOLERANCE {
            let mut direction = normalized(rest);
            let largest = direction.iter().copied().fold(0.0, |best: f64, value| {
                if value.abs() > best.abs() {
                    value
                } else {
                    best
                }
            });
            for value in &mut direction {
                if largest < 0.0 {
                    *value = -*value;
                }
                if value.abs() < 1e-12 {
                    *value = 0.0;
                }
            }
            basis.push(direction);
        }
    }
    basis
}
