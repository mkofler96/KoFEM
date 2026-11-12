// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! One linear-elastic load case on a tetrahedral mesh with surface-to-point
//! couplings — the master–slave reduction `K_r = TᵀKT` of the engine's coupled
//! solve (`solve_reduced_system` in `shell_core.cpp`), arranged so the
//! multigrid preconditioner can take it.
//!
//! The full numbering has six DOFs per node (6·node + component). A node's
//! translations are unknowns unless a coupling eliminates them; its rotations
//! exist only on coupling reference points (elsewhere a solid node has no
//! rotational stiffness, and they are held at zero). The reduced system keeps
//! the independent DOFs in blocks of three — a node's translations, or a
//! reference point's rotations — so the multigrid sees the node blocks it
//! aggregates; a rotation block gets rotation near-null-space modes. A block
//! of which a coupling eliminates only some components keeps those as rows
//! held at zero, and the coupling restores their value after the solve.

use crate::amg::{Preconditioner, SmoothedAggregation, SymmetricGaussSeidel};
use crate::cg::{solve_pcg_with, CgSettings};
use crate::constraints::{apply_dirichlet, Dirichlet};
use crate::coupling::{Coupling, CouplingConstraints, DOFS_PER_NODE};
use crate::error::FemError;
use crate::mesh::{ElementOrder, TetMesh};
use crate::sparse::CsrMatrix;
use crate::static_solve::{PreconditionerChoice, PreparedStatic};
use crate::LevelInfo;

/// "No reduced unknown" in [`CoupledReduction`]'s slot table.
const NO_SLOT: u32 = u32::MAX;

/// How the full 6-per-node DOFs map onto the reduced system: the reduced
/// unknown of each independent DOF, and the coupling equations that give
/// every dependent DOF.
#[derive(Debug, Clone)]
pub struct CoupledReduction {
    constraints: CouplingConstraints,
    /// Reduced unknown of each full DOF's block position, or `NO_SLOT` for a
    /// rotation of a node that has none. A dependent DOF inside a kept block
    /// has a slot too, held at zero in the solve.
    slot_of: Vec<u32>,
    /// The full DOF of each reduced unknown.
    dof_of_slot: Vec<usize>,
}

impl CoupledReduction {
    /// Calls `visit(slot, coefficient)` for each term of a full DOF in reduced
    /// unknowns: itself, or its coupling equation; nothing for a rotation of a
    /// node that has none.
    fn for_each_term(&self, dof: usize, mut visit: impl FnMut(usize, f64)) {
        if let Some(row) = self.constraints.row(dof) {
            for &(independent, coefficient) in row {
                visit(self.slot_of[independent] as usize, coefficient);
            }
        } else if self.slot_of[dof] != NO_SLOT {
            visit(self.slot_of[dof] as usize, 1.0);
        }
    }

    /// Unknowns of the reduced system.
    #[must_use]
    pub fn reduced_count(&self) -> usize {
        self.dof_of_slot.len()
    }

    /// All 6·node DOFs from a reduced solution: independent DOFs directly,
    /// dependent ones through their coupling, absent rotations zero.
    #[must_use]
    pub fn expand(&self, reduced: &[f64]) -> Vec<f64> {
        let mut full = vec![0.0; self.slot_of.len()];
        for (dof, value) in full.iter_mut().enumerate() {
            let mut sum = 0.0;
            self.for_each_term(dof, |slot, coefficient| sum += coefficient * reduced[slot]);
            *value = sum;
        }
        full
    }

    /// Generalised reaction at every independent DOF, Tᵀ(K·u − f), from the
    /// full DOFs `dofs` and full loads `forces` (both 6 per node): the force
    /// (or moment) a support must apply there. Zero at free DOFs, up to the
    /// solver tolerance; zero at dependent DOFs, whose reaction is carried
    /// by the independent DOFs they follow.
    ///
    /// # Errors
    /// Vectors of the wrong length.
    pub fn reactions(
        &self,
        stiffness: &CsrMatrix,
        dofs: &[f64],
        forces: &[f64],
    ) -> Result<Vec<f64>, FemError> {
        let count = self.slot_of.len();
        if dofs.len() != count {
            return Err(FemError::DisplacementLength {
                len: dofs.len(),
                count,
            });
        }
        if forces.len() != count {
            return Err(FemError::ForceLength {
                len: forces.len(),
                count,
            });
        }
        let nodes = count / DOFS_PER_NODE;
        if stiffness.rows() != 3 * nodes {
            return Err(FemError::CouplingInput {
                reason: format!(
                    "the stiffness has {} rows for {nodes} nodes",
                    stiffness.rows()
                ),
            });
        }
        let translations: Vec<f64> = (0..3 * nodes)
            .map(|index| dofs[DOFS_PER_NODE * (index / 3) + index % 3])
            .collect();
        let mut internal = vec![0.0; 3 * nodes];
        stiffness.mul_vec(&translations, &mut internal);
        let mut reduced = vec![0.0; self.reduced_count()];
        for (dof, &force) in forces.iter().enumerate() {
            let (node, component) = (dof / DOFS_PER_NODE, dof % DOFS_PER_NODE);
            let own = if component < 3 {
                internal[3 * node + component]
            } else {
                0.0
            };
            let residual = own - force;
            if residual != 0.0 {
                self.for_each_term(dof, |slot, coefficient| {
                    reduced[slot] += coefficient * residual;
                });
            }
        }
        let mut out = vec![0.0; count];
        for (slot, &dof) in self.dof_of_slot.iter().enumerate() {
            if !self.constraints.is_dependent(dof) {
                out[dof] = reduced[slot];
            }
        }
        Ok(out)
    }
}

/// A coupled load case ready for CG (see [`prepare_coupled_static`]).
pub struct PreparedCoupled {
    /// The reduced system, its preconditioner and right-hand side.
    /// `unused_vertices` counts the nodes held at zero because nothing
    /// stiffens them.
    pub prepared: PreparedStatic,
    pub reduction: CoupledReduction,
}

#[derive(Debug, Clone)]
pub struct CoupledSolution {
    /// Six DOFs per node, translations then rotations; rotations are zero on
    /// nodes that have none.
    pub dofs: Vec<f64>,
    pub iterations: usize,
    pub relative_residual: f64,
    /// Multigrid levels (unknowns, non-zeros), finest first; empty for
    /// Gauss–Seidel.
    pub levels: Vec<LevelInfo>,
}

/// Solve one coupled load case in one go (see [`prepare_coupled_static`]).
///
/// # Errors
/// As [`prepare_coupled_static`], plus a CG breakdown or non-convergence.
#[allow(
    clippy::too_many_arguments,
    reason = "the load case's parts, as the uncoupled solve_static takes them, plus the couplings"
)]
pub fn solve_coupled_static(
    mesh: &TetMesh,
    stiffness: &CsrMatrix,
    couplings: &[Coupling],
    fixed_dofs: &[u32],
    fixed_values: &[f64],
    forces: &[f64],
    settings: CgSettings,
    preconditioner: PreconditionerChoice,
) -> Result<CoupledSolution, FemError> {
    let PreparedCoupled {
        mut prepared,
        reduction,
    } = prepare_coupled_static(
        mesh,
        stiffness,
        couplings,
        fixed_dofs,
        fixed_values,
        forces,
        preconditioner,
    )?;
    let (reduced, outcome) = solve_pcg_with(prepared.system.as_mut(), &prepared.rhs, settings)?;
    Ok(CoupledSolution {
        dofs: reduction.expand(&reduced),
        iterations: outcome.iterations,
        relative_residual: outcome.relative_residual,
        levels: prepared.levels,
    })
}

/// Check one coupled load case and set up its reduced system for CG.
///
/// `stiffness` is what `assemble_stiffness` built for the linear `mesh`.
/// `fixed_dofs`/`fixed_values` and `forces` use the 6-per-node numbering:
/// a fixed or prescribed rotation, or a moment, is valid on a coupling
/// reference point only — except a zero rotation on another node, which
/// holds a DOF that is held anyway. Every other node that nothing stiffens
/// (a vertex no element or coupling uses) is held at zero, after checking
/// that nothing loads it.
///
/// # Errors
/// A quadratic mesh, malformed couplings (see [`CouplingConstraints::build`])
/// or a cycle of them, malformed forces or constraints, a constraint on a DOF
/// a coupling eliminates, a rotation load or prescribed rotation on a node
/// without rotations, a load on a DOF nothing stiffens, or a multigrid setup
/// that finds the model under-constrained.
pub fn prepare_coupled_static(
    mesh: &TetMesh,
    stiffness: &CsrMatrix,
    couplings: &[Coupling],
    fixed_dofs: &[u32],
    fixed_values: &[f64],
    forces: &[f64],
    preconditioner: PreconditionerChoice,
) -> Result<PreparedCoupled, FemError> {
    check_load_case(mesh, stiffness, fixed_dofs, fixed_values, forces)?;
    let (reduction, blocks) = CoupledReduction::new(mesh, couplings)?;
    let mut matrix = reduced_stiffness(&reduction, mesh, stiffness, blocks.points.len())?;
    let mut rhs = reduced_load(&reduction, forces)?;
    let mut prescribed = reduced_constraints(&reduction, fixed_dofs, fixed_values)?;
    let held_nodes = hold_unstiffened(&reduction, &blocks, &matrix, &rhs, &mut prescribed)?;
    let (dofs, values): (Vec<u32>, Vec<f64>) = prescribed
        .iter()
        .enumerate()
        .filter_map(|(slot, value)| value.map(|value| (to_u32(slot), value)))
        .unzip();
    let dirichlet = Dirichlet::new(reduction.reduced_count(), &dofs, &values)?;
    apply_dirichlet(&mut matrix, &mut rhs, &dirichlet);

    let (system, levels): (Box<dyn Preconditioner>, Vec<LevelInfo>) = match preconditioner {
        PreconditionerChoice::SymmetricGaussSeidel => {
            (Box::new(SymmetricGaussSeidel::new(matrix)), Vec::new())
        }
        PreconditionerChoice::SmoothedAggregation(amg_settings) => {
            let constrained: Vec<bool> = prescribed.iter().map(Option::is_some).collect();
            let amg = SmoothedAggregation::with_rotation_nodes(
                matrix,
                &blocks.points,
                &blocks.rotation,
                &constrained,
                amg_settings,
            )?;
            let levels = amg.levels();
            (Box::new(amg), levels)
        }
    };
    Ok(PreparedCoupled {
        prepared: PreparedStatic {
            system,
            rhs,
            levels,
            unused_vertices: held_nodes,
        },
        reduction,
    })
}

/// Check the parts of a coupled load case against the mesh.
fn check_load_case(
    mesh: &TetMesh,
    stiffness: &CsrMatrix,
    fixed_dofs: &[u32],
    fixed_values: &[f64],
    forces: &[f64],
) -> Result<(), FemError> {
    if mesh.order() != ElementOrder::Linear {
        return Err(FemError::CouplingOnQuadraticMesh);
    }
    let nodes = mesh.vertex_count();
    let max_nodes = u32::MAX as usize / DOFS_PER_NODE;
    if nodes > max_nodes {
        return Err(FemError::TooManyNodes {
            count: nodes,
            max: max_nodes,
        });
    }
    if stiffness.rows() != 3 * nodes {
        return Err(FemError::CouplingInput {
            reason: format!(
                "the stiffness has {} rows for {nodes} nodes",
                stiffness.rows()
            ),
        });
    }
    let dof_count = DOFS_PER_NODE * nodes;
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
    Ok(())
}

/// The node blocks of the reduced system, three unknowns each.
struct Blocks {
    /// Position of each block's node.
    points: Vec<[f64; 3]>,
    /// Whether a block holds a reference point's rotations.
    rotation: Vec<bool>,
}

impl CoupledReduction {
    /// The couplings' equations and the reduced blocks: a node's translations
    /// unless a coupling eliminates all three, and a reference point's
    /// rotations likewise.
    fn new(mesh: &TetMesh, couplings: &[Coupling]) -> Result<(Self, Blocks), FemError> {
        let nodes = mesh.vertex_count();
        let mut has_rotation = vec![false; nodes];
        for coupling in couplings {
            if let Some(flag) = has_rotation.get_mut(coupling.reference) {
                *flag = true;
            }
        }
        let mut constraints =
            CouplingConstraints::build(mesh.vertices(), couplings, &has_rotation)?;
        constraints.resolve_chains()?;

        let mut slot_of = vec![NO_SLOT; DOFS_PER_NODE * nodes];
        let mut dof_of_slot: Vec<usize> = Vec::new();
        let mut blocks = Blocks {
            points: Vec::new(),
            rotation: Vec::new(),
        };
        for (node, (&point, &rotates)) in mesh.vertices().iter().zip(&has_rotation).enumerate() {
            for rotation in [false, true] {
                if rotation && !rotates {
                    continue;
                }
                let first = DOFS_PER_NODE * node + if rotation { 3 } else { 0 };
                if (first..first + 3).all(|dof| constraints.is_dependent(dof)) {
                    continue;
                }
                for (dof, slot) in slot_of.iter_mut().enumerate().skip(first).take(3) {
                    *slot = to_u32(dof_of_slot.len());
                    dof_of_slot.push(dof);
                }
                blocks.points.push(point);
                blocks.rotation.push(rotation);
            }
        }
        for dof in 0..slot_of.len() {
            let Some(row) = constraints.row(dof) else {
                continue;
            };
            if let Some(&(missing, _)) = row
                .iter()
                .find(|&&(other, _)| slot_of[other] == NO_SLOT || constraints.is_dependent(other))
            {
                return Err(FemError::CouplingInput {
                    reason: format!(
                        "node {} DOF {} follows DOF {} of node {}, which is not an unknown \
                         of the system (internal error)",
                        dof / DOFS_PER_NODE,
                        dof % DOFS_PER_NODE,
                        missing % DOFS_PER_NODE,
                        missing / DOFS_PER_NODE
                    ),
                });
            }
        }
        Ok((
            Self {
                constraints,
                slot_of,
                dof_of_slot,
            },
            blocks,
        ))
    }
}

/// `f_r = Tᵀf`. A moment on a node without rotations has nowhere to act.
fn reduced_load(reduction: &CoupledReduction, forces: &[f64]) -> Result<Vec<f64>, FemError> {
    let mut rhs = vec![0.0; reduction.reduced_count()];
    for (dof, &force) in forces.iter().enumerate() {
        if force == 0.0 {
            continue;
        }
        if !reduction.constraints.is_dependent(dof) && reduction.slot_of[dof] == NO_SLOT {
            return Err(FemError::RotationWithoutDof {
                node: dof / DOFS_PER_NODE,
                component: dof % DOFS_PER_NODE,
                what: "moment",
            });
        }
        reduction.for_each_term(dof, |slot, coefficient| rhs[slot] += coefficient * force);
    }
    Ok(rhs)
}

/// The prescribed value of each reduced unknown: the caller's conditions,
/// then zero for the dependent components of a kept block (the coupling
/// restores their value after the solve).
fn reduced_constraints(
    reduction: &CoupledReduction,
    fixed_dofs: &[u32],
    fixed_values: &[f64],
) -> Result<Vec<Option<f64>>, FemError> {
    let dof_count = reduction.slot_of.len();
    let mut prescribed: Vec<Option<f64>> = vec![None; reduction.reduced_count()];
    for (&dof, &value) in fixed_dofs.iter().zip(fixed_values) {
        let index = dof as usize;
        if index >= dof_count {
            return Err(FemError::DofOutOfRange {
                dof,
                count: dof_count,
            });
        }
        if !value.is_finite() {
            return Err(FemError::NonFinite {
                what: "a prescribed displacement",
                value,
            });
        }
        let (node, component) = (index / DOFS_PER_NODE, index % DOFS_PER_NODE);
        if reduction.constraints.is_dependent(index) {
            return Err(FemError::ConstraintOnCoupledDof {
                node,
                component,
                what: if value == 0.0 { "fixed" } else { "prescribed" },
            });
        }
        let slot = reduction.slot_of[index];
        if slot == NO_SLOT {
            // A rotation of a node without rotations is held at zero anyway.
            if value != 0.0 {
                return Err(FemError::RotationWithoutDof {
                    node,
                    component,
                    what: "prescribed rotation",
                });
            }
            continue;
        }
        let entry = &mut prescribed[slot as usize];
        #[allow(
            clippy::float_cmp,
            reason = "a DOF prescribed twice is consistent only with the identical value"
        )]
        match *entry {
            Some(first) if first != value => {
                return Err(FemError::ConflictingConstraint {
                    dof,
                    first,
                    second: value,
                });
            }
            _ => *entry = Some(value),
        }
    }
    for (slot, &dof) in reduction.dof_of_slot.iter().enumerate() {
        if reduction.constraints.is_dependent(dof) {
            prescribed[slot] = Some(0.0);
        }
    }
    Ok(prescribed)
}

/// Hold at zero every free unknown nothing stiffens — its whole row is zero,
/// as `K_r` is positive semi-definite — unless it is loaded. Returns how many
/// nodes had all three translations held.
fn hold_unstiffened(
    reduction: &CoupledReduction,
    blocks: &Blocks,
    matrix: &CsrMatrix,
    rhs: &[f64],
    prescribed: &mut [Option<f64>],
) -> Result<usize, FemError> {
    let mut held_nodes = 0;
    for (block, &rotation) in blocks.rotation.iter().enumerate() {
        let mut held = 0;
        for slot in 3 * block..3 * block + 3 {
            if prescribed[slot].is_some() || matrix.diagonal(slot) != 0.0 {
                continue;
            }
            if rhs[slot] != 0.0 {
                let dof = reduction.dof_of_slot[slot];
                return Err(FemError::LoadWithoutStiffness {
                    node: dof / DOFS_PER_NODE,
                    component: dof % DOFS_PER_NODE,
                });
            }
            prescribed[slot] = Some(0.0);
            held += 1;
        }
        if held == 3 && !rotation {
            held_nodes += 1;
        }
    }
    Ok(held_nodes)
}

/// `K_r = TᵀKT` over the reduced blocks: the pattern from the node graph of K
/// through the coupling equations, then the values.
fn reduced_stiffness(
    reduction: &CoupledReduction,
    mesh: &TetMesh,
    stiffness: &CsrMatrix,
    blocks: usize,
) -> Result<CsrMatrix, FemError> {
    let nodes = mesh.vertex_count();
    // Blocks each node's translations reach: its own, or those it follows.
    let blocks_of_node: Vec<Vec<u32>> = (0..nodes)
        .map(|node| {
            let mut list = Vec::new();
            for component in 0..3 {
                reduction.for_each_term(DOFS_PER_NODE * node + component, |slot, _| {
                    list.push(to_u32(slot / 3));
                });
            }
            list.sort_unstable();
            list.dedup();
            list
        })
        .collect();
    let mut adjacency: Vec<Vec<u32>> = (0..blocks).map(|block| vec![to_u32(block)]).collect();
    let mut reached: Vec<u32> = Vec::new();
    for (node, own) in blocks_of_node.iter().enumerate() {
        // A node no element uses has an all-zero stiffness row: it adds no
        // entry. Skipping it matters for a distributing reference point, which
        // would otherwise join every pair of its coupled nodes.
        if own.is_empty() || !mesh.is_used(node) {
            continue;
        }
        reached.clear();
        // The pattern stores 3×3 node blocks: every third column of the
        // node's first row is one neighbour.
        let row = stiffness.row_range(3 * node);
        for &column in stiffness.columns()[row].iter().step_by(3) {
            reached.extend_from_slice(&blocks_of_node[column as usize / 3]);
        }
        reached.sort_unstable();
        reached.dedup();
        for &block in own {
            adjacency[block as usize].extend_from_slice(&reached);
        }
    }
    for list in &mut adjacency {
        list.sort_unstable();
        list.dedup();
    }
    let mut matrix = CsrMatrix::from_node_pattern(&adjacency);
    drop(adjacency);

    let mut row_terms: Vec<(usize, f64)> = Vec::new();
    let mut column_terms: Vec<(usize, f64)> = Vec::new();
    for row in 0..3 * nodes {
        row_terms.clear();
        reduction.for_each_term(full_dof(row), |slot, coefficient| {
            row_terms.push((slot, coefficient));
        });
        if row_terms.is_empty() {
            continue;
        }
        for index in stiffness.row_range(row) {
            let value = stiffness.values()[index];
            if value == 0.0 {
                continue;
            }
            column_terms.clear();
            reduction.for_each_term(
                full_dof(stiffness.columns()[index] as usize),
                |slot, coefficient| {
                    column_terms.push((slot, coefficient));
                },
            );
            for &(lhs, lhs_coefficient) in &row_terms {
                for &(rhs, rhs_coefficient) in &column_terms {
                    let at = matrix
                        .find(lhs, rhs)
                        .ok_or_else(|| FemError::CouplingInput {
                            reason:
                                "the reduced stiffness pattern misses an entry (internal error)"
                                    .into(),
                        })?;
                    matrix.values_mut()[at] += lhs_coefficient * rhs_coefficient * value;
                }
            }
        }
    }
    Ok(matrix)
}

/// The full (6 per node) DOF of a 3-per-node stiffness row.
fn full_dof(row: usize) -> usize {
    DOFS_PER_NODE * (row / 3) + row % 3
}

fn to_u32(index: usize) -> u32 {
    #[allow(
        clippy::cast_possible_truncation,
        reason = "the node count is capped so that 6 DOFs per node fit in u32"
    )]
    let narrow = index as u32;
    narrow
}
