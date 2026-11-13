// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! One linear-elastic load case on a tetrahedral mesh with couplings, and
//! optionally Kirchhoff shell facets over the same node pool — the
//! master–slave reduction `K_r = TᵀKT` of the engine's coupled solve
//! (`solve_solid_shell_core` and `solve_reduced_system` in `shell_core.cpp`),
//! arranged so the multigrid preconditioner can take it.
//!
//! The full numbering has six DOFs per node (6·node + component). A node's
//! translations are unknowns unless a coupling eliminates them; its rotations
//! exist only on shell nodes and coupling reference points (elsewhere a solid
//! node has no rotational stiffness, and they are held at zero). The solid
//! tets stiffen the translations, the shell facets all six DOFs of their
//! nodes. The reduced system keeps the independent DOFs in blocks of three —
//! a node's translations, or its rotations — so the multigrid sees the node
//! blocks it aggregates; a rotation block gets rotation near-null-space
//! modes. A block of which a coupling eliminates only some components keeps
//! those as rows held at zero, and the coupling restores their value after
//! the solve.
//!
//! On a quadratic mesh the edge nodes are nodes of the numbering too
//! (vertices first, then one node per edge, as in [`TetMesh`]). Callers name
//! vertices only, so the solve brings the edge nodes along, as the uncoupled
//! solve extends vertex supports to them:
//!
//! * an edge whose two ends a kinematic coupling grips joins that coupling,
//!   so the surface stays rigid between its corners. The edges are found by
//!   vertex adjacency, not from the picked faces, so an edge off the surface
//!   whose ends the coupling both grips (a chord through the solid) joins
//!   too; on the rigid body its ends already move with, its midpoint
//!   following that motion is consistent;
//! * a distributing coupling keeps its corner nodes, as on linear elements:
//!   it then transfers its point's force and moment exactly as it does
//!   there. Adding edge nodes would move their weighted centroid off the
//!   point (the app places it at the corners' centroid), and the RBE3
//!   equations, which take the point as that centroid, would add a moment;
//! * an edge node whose two ends follow couplings in a translation, and that
//!   no coupling grips itself, follows their mean in it — the linear
//!   interpolation along the edge, e.g. across the face of a tie;
//! * where both ends of an edge are fixed or prescribed in a translation,
//!   the edge node gets the mean of the two values.
//!
//! Shell facets join linear tetrahedra only, as in the engine's coupled
//! solve: a quadratic mesh with shells is refused.

use crate::amg::{Preconditioner, SmoothedAggregation, SymmetricGaussSeidel};
use crate::cg::{solve_pcg_with, CgSettings};
use crate::constraints::{apply_dirichlet, Dirichlet};
use crate::coupling::{Coupling, CouplingConstraints, CouplingKind, DOFS_PER_NODE};
use crate::error::FemError;
use crate::incomplete_cholesky::IncompleteCholesky;
use crate::mesh::{ElementOrder, TetMesh};
use crate::shell::{ShellMesh, SHELL_NODE_DOFS};
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
    /// by the independent DOFs they follow. `stiffness` is the solid one (3
    /// per node), so this holds for a model without shell facets only.
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
/// `stiffness` is what `assemble_stiffness` built for `mesh`, of linear or
/// quadratic elements. `fixed_dofs`/`fixed_values` and `forces` use the
/// 6-per-node numbering over every node, edge nodes included (see the
/// module notes for how vertex couplings and supports reach those):
/// a fixed or prescribed rotation, or a moment, is valid on a coupling
/// reference point only — except a zero rotation on another node, which
/// holds a DOF that is held anyway. Every other node that nothing stiffens
/// (a vertex no element or coupling uses) is held at zero, after checking
/// that nothing loads it.
///
/// # Errors
/// Malformed couplings (see [`CouplingConstraints::build`])
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
    // The relaxed MPC and the shell footprint tie a shell to a solid.
    if let Some(index) = couplings.iter().position(|coupling| {
        matches!(
            coupling.kind,
            CouplingKind::RelaxedMpc { .. } | CouplingKind::ShellFootprint
        )
    }) {
        return Err(FemError::Coupling {
            coupling: index,
            reason: "it ties a shell to a solid, but the model has no shell elements".into(),
        });
    }
    let PreparedMixed {
        prepared,
        reduction,
        ..
    } = prepare_mixed_static(
        mesh,
        stiffness,
        None,
        couplings,
        fixed_dofs,
        fixed_values,
        forces,
        MixedPreconditioner::Choice(preconditioner),
    )?;
    Ok(PreparedCoupled {
        prepared,
        reduction,
    })
}

/// The shell facets of a mixed model and their assembled stiffness
/// (`assemble_shell_stiffness`), over the same node pool as the solid mesh.
#[derive(Clone, Copy)]
pub struct ShellPart<'a> {
    pub mesh: &'a ShellMesh,
    pub stiffness: &'a CsrMatrix,
}

/// The preconditioner a mixed solve asks for.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum MixedPreconditioner {
    /// One of the solid solve's preconditioners.
    Choice(PreconditionerChoice),
    /// IC(0) of `K_r` + shift·diag, the C++ engine's choice for coupled
    /// solves, falling back to symmetric Gauss–Seidel when no shift lets it
    /// factor.
    IncompleteCholesky,
}

/// The preconditioner a mixed solve ended up with.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum AppliedPreconditioner {
    SymmetricGaussSeidel,
    SmoothedAggregation,
    /// IC(0) of `K_r` + shift·diag(`K_r`).
    IncompleteCholesky {
        shift: f64,
    },
    /// IC(0) was asked for, but every shift broke down.
    GaussSeidelAfterIncompleteCholesky,
}

/// A mixed load case ready for CG (see [`prepare_mixed_static`]).
pub struct PreparedMixed {
    /// The reduced system, its preconditioner and right-hand side.
    /// `unused_vertices` counts the nodes held at zero because nothing
    /// stiffens them.
    pub prepared: PreparedStatic,
    pub reduction: CoupledReduction,
    pub preconditioner: AppliedPreconditioner,
}

/// Solve one mixed load case in one go (see [`prepare_mixed_static`]).
///
/// # Errors
/// As [`prepare_mixed_static`], plus a CG breakdown or non-convergence.
#[allow(
    clippy::too_many_arguments,
    reason = "the coupled load case's parts plus the shell facets"
)]
pub fn solve_mixed_static(
    mesh: &TetMesh,
    stiffness: &CsrMatrix,
    shell: Option<ShellPart<'_>>,
    couplings: &[Coupling],
    fixed_dofs: &[u32],
    fixed_values: &[f64],
    forces: &[f64],
    settings: CgSettings,
    preconditioner: MixedPreconditioner,
) -> Result<CoupledSolution, FemError> {
    let PreparedMixed {
        mut prepared,
        reduction,
        ..
    } = prepare_mixed_static(
        mesh,
        stiffness,
        shell,
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

/// Check one mixed solid + shell load case and set up its reduced system for
/// CG: the solid tets of `mesh` (stiffness from `assemble_stiffness`) and, if
/// given, the shell facets of `shell` over the same node pool, joined by
/// `couplings` — the engine's `solve_coupled`. Rotations are unknowns on
/// shell nodes and on the reference points of every coupling but a shell
/// footprint (whose reference is a solid node).
///
/// `fixed_dofs`/`fixed_values` and `forces` use the 6-per-node numbering: a
/// fixed or prescribed rotation, or a moment, is valid on a node with
/// rotations only — except a zero rotation on another node, which holds a
/// DOF that is held anyway. Every node that nothing stiffens (no element or
/// coupling uses it) is held at zero, after checking that nothing loads it.
///
/// `mesh` may be quadratic without shells (see the module notes for its edge
/// nodes); shells join linear tetrahedra only.
///
/// # Errors
/// Shells over a quadratic mesh, a shell mesh over another node pool, malformed
/// couplings (see [`CouplingConstraints::build`]) or a cycle of them,
/// malformed forces or constraints, a constraint on a DOF a coupling
/// eliminates, a rotation load or prescribed rotation on a node without
/// rotations, a load on a DOF nothing stiffens, or a multigrid setup that
/// finds the model under-constrained.
#[allow(
    clippy::too_many_arguments,
    reason = "the coupled load case's parts plus the shell facets"
)]
pub fn prepare_mixed_static(
    mesh: &TetMesh,
    stiffness: &CsrMatrix,
    shell: Option<ShellPart<'_>>,
    couplings: &[Coupling],
    fixed_dofs: &[u32],
    fixed_values: &[f64],
    forces: &[f64],
    preconditioner: MixedPreconditioner,
) -> Result<PreparedMixed, FemError> {
    check_load_case(mesh, stiffness, fixed_dofs, fixed_values, forces)?;
    if let Some(part) = shell {
        if mesh.order() != ElementOrder::Linear {
            return Err(FemError::ShellOnQuadraticMesh);
        }
        check_shell_part(mesh, part)?;
    }
    let solid_used: Vec<bool> = (0..mesh.node_count())
        .map(|node| mesh.is_used(node))
        .collect();
    // With shells the mesh is linear, so its nodes are the shell's vertices.
    let shell_used: Vec<bool> = shell.map_or_else(Vec::new, |part| {
        (0..part.mesh.vertex_count())
            .map(|node| part.mesh.is_used(node))
            .collect()
    });
    let mut has_rotation = shell_used.clone();
    has_rotation.resize(mesh.node_count(), false);
    for coupling in couplings {
        if coupling.kind == CouplingKind::ShellFootprint {
            continue;
        }
        if let Some(flag) = has_rotation.get_mut(coupling.reference) {
            *flag = true;
        }
    }
    let (reduction, blocks) = CoupledReduction::new(mesh, &has_rotation, couplings)?;
    let mut parts = vec![StiffnessPart {
        matrix: stiffness,
        node_dofs: 3,
        used: &solid_used,
    }];
    if let Some(part) = shell {
        parts.push(StiffnessPart {
            matrix: part.stiffness,
            node_dofs: SHELL_NODE_DOFS,
            used: &shell_used,
        });
    }
    let mut matrix = reduced_stiffness(&reduction, &parts, blocks.points.len())?;
    let mut rhs = reduced_load(&reduction, forces)?;
    let (fixed_dofs, fixed_values) = supports_with_edge_nodes(mesh, fixed_dofs, fixed_values);
    let mut prescribed = reduced_constraints(&reduction, &fixed_dofs, &fixed_values)?;
    let held_nodes = hold_unstiffened(&reduction, &blocks, &matrix, &rhs, &mut prescribed)?;
    let (dofs, values): (Vec<u32>, Vec<f64>) = prescribed
        .iter()
        .enumerate()
        .filter_map(|(slot, value)| value.map(|value| (to_u32(slot), value)))
        .unzip();
    let dirichlet = Dirichlet::new(reduction.reduced_count(), &dofs, &values)?;
    apply_dirichlet(&mut matrix, &mut rhs, &dirichlet);

    let constrained: Vec<bool> = prescribed.iter().map(Option::is_some).collect();
    let (system, levels, applied) =
        mixed_preconditioner(matrix, &blocks, &constrained, preconditioner)?;
    Ok(PreparedMixed {
        prepared: PreparedStatic {
            system,
            rhs,
            levels,
            unused_vertices: held_nodes,
        },
        reduction,
        preconditioner: applied,
    })
}

/// A preconditioner over the reduced system, its multigrid levels (empty
/// unless multigrid) and what it ended up as.
type BuiltPreconditioner = (
    Box<dyn Preconditioner>,
    Vec<LevelInfo>,
    AppliedPreconditioner,
);

/// The preconditioner of a mixed solve over the reduced `matrix`.
/// `constrained` marks the reduced unknowns held by a Dirichlet condition.
fn mixed_preconditioner(
    matrix: CsrMatrix,
    blocks: &Blocks,
    constrained: &[bool],
    preconditioner: MixedPreconditioner,
) -> Result<BuiltPreconditioner, FemError> {
    Ok(match preconditioner {
        MixedPreconditioner::Choice(PreconditionerChoice::SymmetricGaussSeidel) => (
            Box::new(SymmetricGaussSeidel::new(matrix)),
            Vec::new(),
            AppliedPreconditioner::SymmetricGaussSeidel,
        ),
        MixedPreconditioner::Choice(PreconditionerChoice::SmoothedAggregation(amg_settings)) => {
            let amg = SmoothedAggregation::with_rotation_nodes(
                matrix,
                &blocks.points,
                &blocks.rotation,
                constrained,
                amg_settings,
            )?;
            let levels = amg.levels();
            (
                Box::new(amg),
                levels,
                AppliedPreconditioner::SmoothedAggregation,
            )
        }
        MixedPreconditioner::IncompleteCholesky => match IncompleteCholesky::new(matrix) {
            Ok(factored) => {
                let shift = factored.shift();
                (
                    Box::new(factored),
                    Vec::new(),
                    AppliedPreconditioner::IncompleteCholesky { shift },
                )
            }
            Err(matrix) => (
                Box::new(SymmetricGaussSeidel::new(matrix)),
                Vec::new(),
                AppliedPreconditioner::GaussSeidelAfterIncompleteCholesky,
            ),
        },
    })
}

/// The shell mesh must be built over the solid mesh's node pool: the same
/// vertices, in the same order.
fn check_shell_part(mesh: &TetMesh, part: ShellPart<'_>) -> Result<(), FemError> {
    let nodes = mesh.vertex_count();
    if part.mesh.vertex_count() != nodes {
        return Err(FemError::CouplingInput {
            reason: format!(
                "the shell mesh has {} vertices, but the solid mesh {nodes} — both must share \
                 one node pool",
                part.mesh.vertex_count()
            ),
        });
    }
    #[allow(
        clippy::float_cmp,
        reason = "one node pool means bit-identical coordinates, not nearby ones"
    )]
    let moved = (0..nodes).find(|&node| part.mesh.vertices()[node] != mesh.vertices()[node]);
    if let Some(node) = moved {
        return Err(FemError::CouplingInput {
            reason: format!(
                "vertex {node} lies at {:?} in the shell mesh but at {:?} in the solid mesh — \
                 both must share one node pool",
                part.mesh.vertices()[node],
                mesh.vertices()[node]
            ),
        });
    }
    if part.stiffness.rows() != SHELL_NODE_DOFS * nodes {
        return Err(FemError::CouplingInput {
            reason: format!(
                "the shell stiffness has {} rows for {nodes} nodes",
                part.stiffness.rows()
            ),
        });
    }
    Ok(())
}

/// Check the parts of a coupled load case against the mesh.
fn check_load_case(
    mesh: &TetMesh,
    stiffness: &CsrMatrix,
    fixed_dofs: &[u32],
    fixed_values: &[f64],
    forces: &[f64],
) -> Result<(), FemError> {
    let nodes = mesh.node_count();
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
    /// unless a coupling eliminates all three, and the rotations of a node
    /// with rotations (`has_rotation`, one flag per node) likewise. On a
    /// quadratic mesh the couplings reach the edge nodes first (see the
    /// module notes).
    fn new(
        mesh: &TetMesh,
        has_rotation: &[bool],
        couplings: &[Coupling],
    ) -> Result<(Self, Blocks), FemError> {
        let points = mesh.node_coordinates();
        let nodes = points.len();
        let extended = couplings_with_edge_nodes(mesh, couplings);
        let mut constraints = CouplingConstraints::build(points, &extended, has_rotation)?;
        let vertices = mesh.vertex_count();
        for (edge, &[first, second]) in mesh.edges().iter().enumerate() {
            constraints.follow_edge_ends(vertices + edge, [first as usize, second as usize])?;
        }
        constraints.resolve_chains()?;

        let mut slot_of = vec![NO_SLOT; DOFS_PER_NODE * nodes];
        let mut dof_of_slot: Vec<usize> = Vec::new();
        let mut blocks = Blocks {
            points: Vec::new(),
            rotation: Vec::new(),
        };
        for (node, (&point, &rotates)) in points.iter().zip(has_rotation).enumerate() {
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

/// One assembled stiffness over the node pool, `node_dofs` DOFs per node
/// (3 for the solid tets, 6 for the shell facets): row `node_dofs·node + c`
/// is full DOF `6·node + c`, and the matrix stores `node_dofs`-square node
/// blocks. `used[node]` says whether any element of this part uses the node.
struct StiffnessPart<'a> {
    matrix: &'a CsrMatrix,
    node_dofs: usize,
    used: &'a [bool],
}

impl StiffnessPart<'_> {
    /// The full (6 per node) DOF of a row or column of this part.
    fn full_dof(&self, index: usize) -> usize {
        DOFS_PER_NODE * (index / self.node_dofs) + index % self.node_dofs
    }
}

/// `K_r = Σ TᵀKT` over the reduced blocks and every stiffness part: the
/// pattern from the node graphs of the parts through the coupling equations,
/// then the values.
fn reduced_stiffness(
    reduction: &CoupledReduction,
    parts: &[StiffnessPart<'_>],
    blocks: usize,
) -> Result<CsrMatrix, FemError> {
    let nodes = reduction.slot_of.len() / DOFS_PER_NODE;
    // Blocks each node's DOFs reach, translations only or all six: its own,
    // or those it follows.
    let reach = |components: usize| -> Vec<Vec<u32>> {
        (0..nodes)
            .map(|node| {
                let mut list = Vec::new();
                for component in 0..components {
                    reduction.for_each_term(DOFS_PER_NODE * node + component, |slot, _| {
                        list.push(to_u32(slot / 3));
                    });
                }
                list.sort_unstable();
                list.dedup();
                list
            })
            .collect()
    };
    let translation_blocks = reach(3);
    let all_blocks = if parts.iter().any(|part| part.node_dofs == DOFS_PER_NODE) {
        reach(DOFS_PER_NODE)
    } else {
        Vec::new()
    };
    let mut adjacency: Vec<Vec<u32>> = (0..blocks).map(|block| vec![to_u32(block)]).collect();
    let mut reached: Vec<u32> = Vec::new();
    for part in parts {
        let blocks_of_node = if part.node_dofs == DOFS_PER_NODE {
            &all_blocks
        } else {
            &translation_blocks
        };
        for (node, own) in blocks_of_node.iter().enumerate() {
            // A node no element of this part uses has all-zero rows here: it
            // adds no entry. Skipping it matters for a distributing reference
            // point, which would otherwise join every pair of its coupled
            // nodes.
            if own.is_empty() || !part.used[node] {
                continue;
            }
            reached.clear();
            // The pattern stores node blocks: every node_dofs-th column of
            // the node's first row is one neighbour.
            let row = part.matrix.row_range(part.node_dofs * node);
            for &column in part.matrix.columns()[row].iter().step_by(part.node_dofs) {
                reached.extend_from_slice(&blocks_of_node[column as usize / part.node_dofs]);
            }
            reached.sort_unstable();
            reached.dedup();
            for &block in own {
                adjacency[block as usize].extend_from_slice(&reached);
            }
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
    for part in parts {
        let stiffness = part.matrix;
        for row in 0..part.node_dofs * nodes {
            row_terms.clear();
            reduction.for_each_term(part.full_dof(row), |slot, coefficient| {
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
                    part.full_dof(stiffness.columns()[index] as usize),
                    |slot, coefficient| {
                        column_terms.push((slot, coefficient));
                    },
                );
                for &(lhs, lhs_coefficient) in &row_terms {
                    for &(rhs, rhs_coefficient) in &column_terms {
                        let at = matrix
                            .find(lhs, rhs)
                            .ok_or_else(|| FemError::CouplingInput {
                                reason: "the reduced stiffness pattern misses an entry \
                                         (internal error)"
                                    .into(),
                            })?;
                        matrix.values_mut()[at] += lhs_coefficient * rhs_coefficient * value;
                    }
                }
            }
        }
    }
    Ok(matrix)
}

/// On a quadratic mesh, each kinematic coupling with every edge node whose two
/// ends it grips (see the module notes); an edge node the coupling already
/// names keeps its place. Distributing couplings, and every coupling on a
/// linear mesh, unchanged.
fn couplings_with_edge_nodes(mesh: &TetMesh, couplings: &[Coupling]) -> Vec<Coupling> {
    let edges = mesh.edges();
    if edges.is_empty() {
        return couplings.to_vec();
    }
    let vertices = mesh.vertex_count();
    // Edges at each vertex, as (edge, other end), in CSR form.
    let mut start = vec![0usize; vertices + 1];
    for &[first, second] in edges {
        start[first as usize + 1] += 1;
        start[second as usize + 1] += 1;
    }
    for vertex in 0..vertices {
        start[vertex + 1] += start[vertex];
    }
    let mut fill = start.clone();
    let mut incident = vec![(0usize, 0usize); start[vertices]];
    for (edge, &[first, second]) in edges.iter().enumerate() {
        let (first, second) = (first as usize, second as usize);
        incident[fill[first]] = (edge, second);
        fill[first] += 1;
        incident[fill[second]] = (edge, first);
        fill[second] += 1;
    }
    // Whether a node is in the coupling being extended; cleared again after
    // each coupling.
    let mut member = vec![false; mesh.node_count()];
    couplings
        .iter()
        .map(|coupling| {
            let mut extended = coupling.clone();
            if coupling.kind == CouplingKind::Distributing {
                return extended;
            }
            for &node in &coupling.nodes {
                if let Some(flag) = member.get_mut(node) {
                    *flag = true;
                }
            }
            for &node in &coupling.nodes {
                if node >= vertices {
                    continue;
                }
                for &(edge, other) in &incident[start[node]..start[node + 1]] {
                    let edge_node = vertices + edge;
                    if other < node || !member[other] || member[edge_node] {
                        continue;
                    }
                    extended.nodes.push(edge_node);
                    member[edge_node] = true;
                }
            }
            for &node in &extended.nodes {
                if let Some(flag) = member.get_mut(node) {
                    *flag = false;
                }
            }
            extended
        })
        .collect()
}

/// The caller's supports plus, on a quadratic mesh, the translations of every
/// edge node whose two ends prescribe the same component, at the mean of the
/// two values — the rule of the uncoupled solve (`prepare_static`). An edge
/// node DOF the caller prescribes keeps the caller's value. DOFs out of range
/// pass through for `reduced_constraints` to refuse.
fn supports_with_edge_nodes(
    mesh: &TetMesh,
    fixed_dofs: &[u32],
    fixed_values: &[f64],
) -> (Vec<u32>, Vec<f64>) {
    let mut dofs = fixed_dofs.to_vec();
    let mut values = fixed_values.to_vec();
    if mesh.edges().is_empty() {
        return (dofs, values);
    }
    // First value per node translation; a conflicting second value is refused
    // by `reduced_constraints`, so which one is kept here does not matter.
    let mut prescribed = vec![[None::<f64>; 3]; mesh.node_count()];
    for (&dof, &value) in fixed_dofs.iter().zip(fixed_values) {
        let (node, component) = (dof as usize / DOFS_PER_NODE, dof as usize % DOFS_PER_NODE);
        if component < 3 {
            if let Some(slot) = prescribed.get_mut(node) {
                slot[component].get_or_insert(value);
            }
        }
    }
    for (edge, &[first, second]) in mesh.edges().iter().enumerate() {
        let node = mesh.vertex_count() + edge;
        let (lhs, rhs) = (prescribed[first as usize], prescribed[second as usize]);
        for (component, own) in prescribed[node].iter().enumerate() {
            if let (None, Some(lhs), Some(rhs)) = (own, lhs[component], rhs[component]) {
                dofs.push(to_u32(DOFS_PER_NODE * node + component));
                values.push(f64::midpoint(lhs, rhs));
            }
        }
    }
    (dofs, values)
}

fn to_u32(index: usize) -> u32 {
    #[allow(
        clippy::cast_possible_truncation,
        reason = "the node count is capped so that 6 DOFs per node fit in u32"
    )]
    let narrow = index as u32;
    narrow
}
