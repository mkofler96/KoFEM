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
//! * a distributing coupling over a surface (a picked face, see
//!   [`CouplingKind::DistributingSurface`]) weights its nodes by their share
//!   of the surface's area, the nodal shares of a uniform pressure: on a
//!   quadratic face those sit on the edge nodes, so the coupling grips them
//!   and not the corners. A centred force is then exactly a uniform traction
//!   on the surface, on linear and quadratic faces alike;
//! * any other distributing coupling (a tie's node-to-patch coupling) keeps
//!   the nodes and weights it names;
//! * an edge node whose two ends follow couplings in a translation, and that
//!   no coupling grips itself, follows their mean in it — the linear
//!   interpolation along the edge, e.g. across the face of a tie;
//! * where every corner of a boundary face is fixed or prescribed in a
//!   translation, the face's edge nodes get the mean of their two ends, as
//!   in the uncoupled solve; an edge through the interior stays free.
//!
//! Shell facets join linear tetrahedra only, as in the engine's coupled
//! solve: a quadratic mesh with shells is refused.

use std::collections::BTreeMap;

use crate::amg::{NodeBlock, Preconditioner, SmoothedAggregation, SymmetricGaussSeidel};
use crate::cg::{solve_pcg_with, CgSettings};
use crate::constraints::{apply_dirichlet, Dirichlet};
use crate::count::index_as_u32;
use crate::coupling::{Coupling, CouplingConstraints, CouplingKind, DOFS_PER_NODE};
use crate::error::FemError;
use crate::incomplete_cholesky::IncompleteCholesky;
use crate::mesh::{cross, dot, sub, ElementOrder, TetMesh};
use crate::shell::{ShellMesh, SHELL_NODE_DOFS};
use crate::sparse::CsrMatrix;
use crate::static_solve::{extend_to_boundary_nodes, PreconditionerChoice, PreparedStatic};
use crate::surface::BoundaryFaces;
use crate::LevelInfo;

/// "No reduced unknown" in [`CoupledReduction`]'s slot table.
const NO_SLOT: u32 = u32::MAX;

/// A node whose displacement along a unit `normal` follows other nodes with
/// an offset, and is free in the tangent plane:
///
/// ```text
/// n · u_node = Σₖ wₖ n · u_k + offset .
/// ```
///
/// The reduction gives the node Wohlmuth's rotated basis: its block holds
/// the displacement along n (held, and given by the equation) and along two
/// tangents (free unknowns). A support on the node may act only along a
/// coordinate axis orthogonal to n; it then holds that tangent. An active
/// contact node is such a constraint ([`crate::contact`]), its offset the
/// gap still open.
#[derive(Debug, Clone, PartialEq)]
pub struct NormalConstraint {
    pub node: usize,
    pub normal: [f64; 3],
    pub masters: Vec<usize>,
    pub weights: Vec<f64>,
    pub offset: f64,
}

/// One translation DOF of a node under a [`NormalConstraint`] in reduced
/// unknowns: Σ coefficient · u\[slot\] + offset.
#[derive(Debug, Clone)]
struct OffsetRow {
    terms: Vec<(usize, f64)>,
    offset: f64,
}

/// How the full 6-per-node DOFs map onto the reduced system: the reduced
/// unknown of each independent DOF, the coupling equations that give
/// every dependent DOF, and the rows of the nodes under a
/// [`NormalConstraint`] (`u = T·u_r + c`, c the offsets).
#[derive(Debug, Clone)]
pub struct CoupledReduction {
    constraints: CouplingConstraints,
    /// Reduced unknown of each full DOF's block position, or `NO_SLOT` for a
    /// rotation of a node that has none. A dependent DOF inside a kept block
    /// has a slot too, held at zero in the solve. The block of a node under a
    /// normal constraint holds the components along its frame instead.
    slot_of: Vec<u32>,
    /// The full DOF of each reduced unknown.
    dof_of_slot: Vec<usize>,
    /// The translation DOFs of the nodes under a normal constraint.
    offset_rows: BTreeMap<usize, OffsetRow>,
    /// The frame of each node under a normal constraint: its block's
    /// components.
    frames: BTreeMap<usize, Frame>,
}

/// Wohlmuth's rotated basis at a node under a normal constraint: the unit
/// normal and two tangents, and for each tangent the coordinate axis it is,
/// with its sign, where a support holds that axis.
#[derive(Debug, Clone, Copy)]
struct Frame {
    axes: [[f64; 3]; 3],
    supported_tangents: [Option<(usize, f64)>; 2],
}

/// What a support on a translation of a node under a normal constraint
/// holds.
enum FramedSupport {
    /// The node has no normal constraint.
    Unframed,
    /// The tangent in this reduced unknown, which is ±the support's axis.
    Tangent { slot: usize, sign: f64 },
    /// Nothing: the support's axis has a normal component.
    AcrossNormal,
}

impl CoupledReduction {
    /// Calls `visit(slot, coefficient)` for each term of a full DOF in reduced
    /// unknowns: itself, its coupling equation, or its normal constraint's
    /// row; nothing for a rotation of a node that has none.
    fn for_each_term(&self, dof: usize, mut visit: impl FnMut(usize, f64)) {
        if let Some(row) = self.offset_rows.get(&dof) {
            for &(slot, coefficient) in &row.terms {
                visit(slot, coefficient);
            }
        } else if let Some(row) = self.constraints.row(dof) {
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

    /// The offset c of a full DOF in `u = T·u_r + c`: zero but on a node
    /// under a normal constraint.
    fn offset(&self, dof: usize) -> f64 {
        self.offset_rows.get(&dof).map_or(0.0, |row| row.offset)
    }

    /// All 6·node DOFs from a reduced solution: independent DOFs directly,
    /// dependent ones through their coupling or normal constraint, absent
    /// rotations zero.
    #[must_use]
    pub fn expand(&self, reduced: &[f64]) -> Vec<f64> {
        let mut full = vec![0.0; self.slot_of.len()];
        for (dof, value) in full.iter_mut().enumerate() {
            let mut sum = self.offset(dof);
            self.for_each_term(dof, |slot, coefficient| sum += coefficient * reduced[slot]);
            *value = sum;
        }
        full
    }

    /// The generalised residual Tᵀr of a full residual `residual` (6 per
    /// node), one entry per reduced unknown.
    ///
    /// # Errors
    /// A residual of the wrong length.
    pub fn reduce(&self, residual: &[f64]) -> Result<Vec<f64>, FemError> {
        if residual.len() != self.slot_of.len() {
            return Err(FemError::ForceLength {
                len: residual.len(),
                count: self.slot_of.len(),
            });
        }
        let mut reduced = vec![0.0; self.reduced_count()];
        for (dof, &value) in residual.iter().enumerate() {
            if value != 0.0 {
                self.for_each_term(dof, |slot, coefficient| {
                    reduced[slot] += coefficient * value;
                });
            }
        }
        Ok(reduced)
    }

    /// Reduced unknowns back on the full DOFs they stand for (6 per node):
    /// an independent DOF's own value; on a node under a normal constraint,
    /// its tangential components turned back into x, y, z (the normal one is
    /// held); zero on a dependent DOF.
    #[must_use]
    pub fn place(&self, reduced: &[f64]) -> Vec<f64> {
        let mut out = vec![0.0; self.slot_of.len()];
        for (slot, &dof) in self.dof_of_slot.iter().enumerate() {
            if !self.constraints.is_dependent(dof) && !self.offset_rows.contains_key(&dof) {
                out[dof] = reduced[slot];
            }
        }
        for (&node, frame) in &self.frames {
            let first = DOFS_PER_NODE * node;
            for tangent in 1..3 {
                let value = reduced[self.slot_of[first + tangent] as usize];
                for axis in 0..3 {
                    out[first + axis] += frame.axes[tangent][axis] * value;
                }
            }
        }
        out
    }

    /// Generalised reaction at every independent DOF, Tᵀ(K·u − f), from the
    /// full DOFs `dofs` and full loads `forces` (both 6 per node): the force
    /// (or moment) a support must apply there. Zero at free DOFs, up to the
    /// solver tolerance; zero at dependent DOFs, whose reaction is carried
    /// by the independent DOFs they follow. `stiffness` is the solid one (3
    /// per node), so this holds for a model without shell facets only; see
    /// [`CoupledReduction::mixed_reactions`] for one with them.
    ///
    /// # Errors
    /// Vectors of the wrong length.
    pub fn reactions(
        &self,
        stiffness: &CsrMatrix,
        dofs: &[f64],
        forces: &[f64],
    ) -> Result<Vec<f64>, FemError> {
        self.mixed_reactions(stiffness, None, dofs, forces)
    }

    /// As [`CoupledReduction::reactions`], for a mixed model: `solid` is the
    /// solid stiffness (3 per node) and `shell`, if the model has shell
    /// facets, the shell stiffness (6 per node) over the same nodes.
    ///
    /// # Errors
    /// Vectors or matrices of the wrong size.
    pub fn mixed_reactions(
        &self,
        solid: &CsrMatrix,
        shell: Option<&CsrMatrix>,
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
        if solid.rows() != 3 * nodes {
            return Err(FemError::CouplingInput {
                reason: format!("the stiffness has {} rows for {nodes} nodes", solid.rows()),
            });
        }
        let translations: Vec<f64> = (0..3 * nodes)
            .map(|index| dofs[DOFS_PER_NODE * (index / 3) + index % 3])
            .collect();
        let mut solid_internal = vec![0.0; 3 * nodes];
        solid.mul_vec(&translations, &mut solid_internal);
        let mut internal = vec![0.0; count];
        for (index, value) in solid_internal.iter().enumerate() {
            internal[DOFS_PER_NODE * (index / 3) + index % 3] = *value;
        }
        if let Some(shell) = shell {
            if shell.rows() != count {
                return Err(FemError::CouplingInput {
                    reason: format!(
                        "the shell stiffness has {} rows for {nodes} nodes",
                        shell.rows()
                    ),
                });
            }
            let mut shell_internal = vec![0.0; count];
            shell.mul_vec(dofs, &mut shell_internal);
            for (total, value) in internal.iter_mut().zip(&shell_internal) {
                *total += value;
            }
        }
        let residual: Vec<f64> = internal
            .iter()
            .zip(forces)
            .map(|(own, force)| own - force)
            .collect();
        let reduced = self.reduce(&residual)?;
        Ok(self.place(&reduced))
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
    refuse_shell_couplings(couplings)?;
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

/// The relaxed MPC and the shell footprint tie a shell to a solid: a model
/// without shell elements cannot have them.
fn refuse_shell_couplings(couplings: &[Coupling]) -> Result<(), FemError> {
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
    Ok(())
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
    prepare_reduced(
        mesh,
        stiffness,
        shell,
        couplings,
        &[],
        fixed_dofs,
        fixed_values,
        forces,
        preconditioner,
    )
}

/// Check one solid load case with normal constraints ([`NormalConstraint`],
/// with offsets) and set up its reduced system for CG: the reduction of
/// [`prepare_coupled_static`], in which each constrained node also follows
/// its masters along its normal. The right-hand side is `Tᵀ(f − K·c)`, c the
/// offsets, so [`CoupledReduction::expand`] of the solution satisfies every
/// constraint exactly.
///
/// # Errors
/// As [`prepare_coupled_static`], plus a normal constraint on a node a
/// coupling makes dependent, constrained twice, with a zero normal, or
/// following a node that is constrained itself, and a support along a
/// constrained node's normal ([`FemError::ConstraintOnCoupledDof`]).
#[allow(
    clippy::too_many_arguments,
    reason = "the coupled load case's parts plus the normal constraints"
)]
pub fn prepare_constrained_static(
    mesh: &TetMesh,
    stiffness: &CsrMatrix,
    couplings: &[Coupling],
    normal_constraints: &[NormalConstraint],
    fixed_dofs: &[u32],
    fixed_values: &[f64],
    forces: &[f64],
    preconditioner: PreconditionerChoice,
) -> Result<PreparedMixed, FemError> {
    refuse_shell_couplings(couplings)?;
    prepare_reduced(
        mesh,
        stiffness,
        None,
        couplings,
        normal_constraints,
        fixed_dofs,
        fixed_values,
        forces,
        MixedPreconditioner::Choice(preconditioner),
    )
}

/// [`prepare_mixed_static`] with normal constraints.
#[allow(
    clippy::too_many_arguments,
    reason = "the mixed load case's parts plus the normal constraints"
)]
fn prepare_reduced(
    mesh: &TetMesh,
    stiffness: &CsrMatrix,
    shell: Option<ShellPart<'_>>,
    couplings: &[Coupling],
    normal_constraints: &[NormalConstraint],
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
    let couplings = &surface_couplings(mesh, shell, couplings)?;
    let ReductionSetup {
        reduction,
        blocks,
        solid_used,
        shell_used,
        fixed_dofs,
        fixed_values,
    } = ReductionSetup::new(
        mesh,
        shell,
        couplings,
        normal_constraints,
        fixed_dofs,
        fixed_values,
    )?;
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
    let mut rhs = if reduction.offset_rows.is_empty() {
        reduced_load(&reduction, forces)?
    } else {
        reduced_load(&reduction, &offset_load(&reduction, &parts, forces))?
    };
    let mut prescribed = reduced_constraints(&reduction, &fixed_dofs, &fixed_values)?;
    let held_nodes = hold_unstiffened(&reduction, &blocks, &matrix, &rhs, &mut prescribed)?;
    let (dofs, values): (Vec<u32>, Vec<f64>) = prescribed
        .iter()
        .enumerate()
        .filter_map(|(slot, value)| value.map(|value| (index_as_u32(slot), value)))
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
            eliminated: None,
        },
        reduction,
        preconditioner: applied,
    })
}

/// The reduction of a mixed load case and what building it needed: which
/// nodes the solid and shell parts use, and the supports extended to the
/// boundary nodes.
struct ReductionSetup {
    reduction: CoupledReduction,
    blocks: Blocks,
    solid_used: Vec<bool>,
    shell_used: Vec<bool>,
    fixed_dofs: Vec<u32>,
    fixed_values: Vec<f64>,
}

impl ReductionSetup {
    /// `couplings` with their surface couplings resolved
    /// ([`surface_couplings`]).
    fn new(
        mesh: &TetMesh,
        shell: Option<ShellPart<'_>>,
        couplings: &[Coupling],
        normal_constraints: &[NormalConstraint],
        fixed_dofs: &[u32],
        fixed_values: &[f64],
    ) -> Result<Self, FemError> {
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
            // A footprint's and a tie's reference is a solid node.
            if matches!(
                coupling.kind,
                CouplingKind::ShellFootprint | CouplingKind::Tie { .. }
            ) {
                continue;
            }
            // So is a gap tie's distributing reference: a node of the other
            // face, which only its translation joins. A free point, which no
            // element uses, carries rotations a moment can load.
            if coupling.kind == CouplingKind::Distributing
                && solid_used.get(coupling.reference).copied().unwrap_or(false)
                && !shell_used.get(coupling.reference).copied().unwrap_or(false)
            {
                continue;
            }
            if let Some(flag) = has_rotation.get_mut(coupling.reference) {
                *flag = true;
            }
        }
        let (fixed_dofs, fixed_values) =
            supports_with_boundary_nodes(mesh, fixed_dofs, fixed_values);
        let mut supported = vec![false; DOFS_PER_NODE * mesh.node_count()];
        for &dof in &fixed_dofs {
            if let Some(flag) = supported.get_mut(dof as usize) {
                *flag = true;
            }
        }
        let (reduction, blocks) = CoupledReduction::new(
            mesh,
            &has_rotation,
            couplings,
            normal_constraints,
            &supported,
        )?;
        Ok(Self {
            reduction,
            blocks,
            solid_used,
            shell_used,
            fixed_dofs,
            fixed_values,
        })
    }
}

/// The reduction of [`prepare_constrained_static`] without its system, and
/// which reduced unknowns the supports and the normal constraints hold —
/// to measure a residual against the constraints (Tᵀr off the held
/// unknowns) between solves.
///
/// # Errors
/// As [`prepare_constrained_static`], for the parts it checks.
pub fn constrained_reduction(
    mesh: &TetMesh,
    couplings: &[Coupling],
    normal_constraints: &[NormalConstraint],
    fixed_dofs: &[u32],
    fixed_values: &[f64],
) -> Result<(CoupledReduction, Vec<bool>), FemError> {
    refuse_shell_couplings(couplings)?;
    let couplings = &surface_couplings(mesh, None, couplings)?;
    let setup = ReductionSetup::new(
        mesh,
        None,
        couplings,
        normal_constraints,
        fixed_dofs,
        fixed_values,
    )?;
    let held = reduced_constraints(&setup.reduction, &setup.fixed_dofs, &setup.fixed_values)?
        .iter()
        .map(Option::is_some)
        .collect();
    Ok((setup.reduction, held))
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
            let amg = SmoothedAggregation::with_node_blocks(
                matrix,
                &blocks.points,
                &blocks.kinds,
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
    /// What each block's unknowns are, for multigrid.
    kinds: Vec<NodeBlock>,
}

impl CoupledReduction {
    /// The couplings' equations and the reduced blocks: a node's translations
    /// unless a coupling eliminates all three, and the rotations of a node
    /// with rotations (`has_rotation`, one flag per node) likewise. On a
    /// quadratic mesh the couplings reach the edge nodes first (see the
    /// module notes).
    ///
    /// Each node under a normal constraint keeps its translation block, in
    /// the frame of [`frame_of`] (`supported` flags the full DOFs a support
    /// holds), and follows its masters through their own terms.
    fn new(
        mesh: &TetMesh,
        has_rotation: &[bool],
        couplings: &[Coupling],
        normal_constraints: &[NormalConstraint],
        supported: &[bool],
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
            kinds: Vec::new(),
        };
        let frames = constraint_frames(&constraints, normal_constraints, supported)?;
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
                    *slot = index_as_u32(dof_of_slot.len());
                    dof_of_slot.push(dof);
                }
                blocks.points.push(point);
                blocks.rotation.push(rotation);
                blocks.kinds.push(match (rotation, frames.get(&node)) {
                    (true, _) => NodeBlock::Rotation,
                    (false, Some(frame)) => NodeBlock::Frame(frame.axes),
                    (false, None) => NodeBlock::Translation,
                });
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
        let mut reduction = Self {
            constraints,
            slot_of,
            dof_of_slot,
            offset_rows: BTreeMap::new(),
            frames,
        };
        reduction.offset_rows = reduction.normal_rows(normal_constraints)?;
        Ok((reduction, blocks))
    }

    /// The rows of the translation DOFs of every node under a normal
    /// constraint, in the reduced unknowns of its own frame and its masters'
    /// terms:
    ///
    /// ```text
    /// u = t₁·u[t₁] + t₂·u[t₂] + n · (Σₖ wₖ n · u_k + offset).
    /// ```
    fn normal_rows(
        &self,
        normal_constraints: &[NormalConstraint],
    ) -> Result<BTreeMap<usize, OffsetRow>, FemError> {
        let mut rows = BTreeMap::new();
        for constraint in normal_constraints {
            let fail = |reason: String| FemError::CouplingInput { reason };
            let node = constraint.node;
            let frame = self.frames[&node].axes;
            let normal = frame[0];
            if constraint.masters.len() != constraint.weights.len() {
                return Err(fail(format!(
                    "the normal constraint of node {node} has {} masters but {} weights",
                    constraint.masters.len(),
                    constraint.weights.len()
                )));
            }
            if !constraint.offset.is_finite()
                || constraint.weights.iter().any(|weight| !weight.is_finite())
            {
                return Err(fail(format!(
                    "the normal constraint of node {node} has a non-finite weight or offset"
                )));
            }
            // n · u_k in reduced unknowns, over every master k.
            let mut along_normal: BTreeMap<usize, f64> = BTreeMap::new();
            for (&master, &weight) in constraint.masters.iter().zip(&constraint.weights) {
                if master == node || self.frames.contains_key(&master) {
                    return Err(fail(format!(
                        "node {node} follows node {master} along its normal, but node {master} \
                         follows a normal itself — a node is either side of a normal constraint, \
                         not both"
                    )));
                }
                if master >= self.slot_of.len() / DOFS_PER_NODE {
                    return Err(fail(format!(
                        "node {node} follows node {master} along its normal, which is out of range"
                    )));
                }
                for (axis, &component) in normal.iter().enumerate() {
                    self.for_each_term(DOFS_PER_NODE * master + axis, |slot, coefficient| {
                        *along_normal.entry(slot).or_default() += weight * component * coefficient;
                    });
                }
            }
            let first = DOFS_PER_NODE * node;
            let [_, tangent_slot, bitangent_slot] =
                [0, 1, 2].map(|position| self.slot_of[first + position] as usize);
            for axis in 0..3 {
                let mut terms: BTreeMap<usize, f64> = BTreeMap::new();
                for (&slot, &value) in &along_normal {
                    *terms.entry(slot).or_default() += normal[axis] * value;
                }
                *terms.entry(tangent_slot).or_default() += frame[1][axis];
                *terms.entry(bitangent_slot).or_default() += frame[2][axis];
                rows.insert(
                    first + axis,
                    OffsetRow {
                        terms: terms
                            .into_iter()
                            .filter(|&(_, coefficient)| coefficient != 0.0)
                            .collect(),
                        offset: normal[axis] * constraint.offset,
                    },
                );
            }
        }
        Ok(rows)
    }

    /// What a support on full DOF `dof` holds if the DOF is a translation of
    /// a node under a normal constraint.
    fn framed_support(&self, dof: usize) -> FramedSupport {
        let (node, axis) = (dof / DOFS_PER_NODE, dof % DOFS_PER_NODE);
        let Some(frame) = self.frames.get(&node) else {
            return FramedSupport::Unframed;
        };
        if axis >= 3 {
            return FramedSupport::Unframed;
        }
        frame
            .supported_tangents
            .iter()
            .zip(1..)
            .find_map(|(held, tangent)| match *held {
                Some((held_axis, sign)) if held_axis == axis => Some(FramedSupport::Tangent {
                    slot: self.slot_of[DOFS_PER_NODE * node + tangent] as usize,
                    sign,
                }),
                _ => None,
            })
            .unwrap_or(FramedSupport::AcrossNormal)
    }
}

/// The frame (n, t₁, t₂) of each node under a normal constraint: n the unit
/// normal; t₁ the first coordinate axis a support holds that is orthogonal to
/// n, else the axis least aligned with n made orthogonal to it; t₂ = n × t₁,
/// which is ±the second such axis where a support holds two (n is then the
/// third axis). A support along an axis with a normal component gets no
/// tangent: [`reduced_constraints`] refuses it.
///
/// # Errors
/// A node constrained twice, outside the mesh, with a zero or non-finite
/// normal, or one a coupling makes dependent.
fn constraint_frames(
    constraints: &CouplingConstraints,
    normal_constraints: &[NormalConstraint],
    supported: &[bool],
) -> Result<BTreeMap<usize, Frame>, FemError> {
    let nodes = supported.len() / DOFS_PER_NODE;
    let mut frames = BTreeMap::new();
    for constraint in normal_constraints {
        let node = constraint.node;
        let fail = |reason: String| FemError::CouplingInput { reason };
        if node >= nodes {
            return Err(fail(format!(
                "node {node} of a normal constraint is out of range (the model has {nodes} nodes)"
            )));
        }
        if (0..3).any(|axis| constraints.is_dependent(DOFS_PER_NODE * node + axis)) {
            return Err(fail(format!(
                "node {node} follows a normal and a coupling or tie at once — a node can follow \
                 one of them only"
            )));
        }
        let length = dot(constraint.normal, constraint.normal).sqrt();
        if !(length.is_finite() && length > 0.0) {
            return Err(fail(format!(
                "the normal of node {node} is {:?}, not a direction",
                constraint.normal
            )));
        }
        let normal = constraint.normal.map(|component| component / length);
        let axis_vector = |axis: usize| {
            let mut vector = [0.0; 3];
            vector[axis] = 1.0;
            vector
        };
        let held: Vec<usize> = (0..3)
            .filter(|&axis| supported[DOFS_PER_NODE * node + axis] && normal[axis] == 0.0)
            .collect();
        let tangent = if let Some(&axis) = held.first() {
            axis_vector(axis)
        } else {
            let axis = (0..3)
                .min_by(|&first, &second| normal[first].abs().total_cmp(&normal[second].abs()))
                .unwrap_or(0);
            let raw = axis_vector(axis);
            let along = dot(raw, normal);
            let projected = sub(raw, normal.map(|component| along * component));
            let size = dot(projected, projected).sqrt();
            projected.map(|component| component / size)
        };
        let bitangent = cross(normal, tangent);
        let supported_tangents = [
            held.first().map(|&axis| (axis, 1.0)),
            held.get(1).map(|&axis| (axis, bitangent[axis].signum())),
        ];
        let frame = Frame {
            axes: [normal, tangent, bitangent],
            supported_tangents,
        };
        if frames.insert(node, frame).is_some() {
            return Err(fail(format!(
                "node {node} has two normal constraints — it can follow one surface only"
            )));
        }
    }
    Ok(frames)
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

/// `f − K·c`: the loads less the force of the offsets c over every stiffness
/// part, so that the reduced system solves for `u − c`.
fn offset_load(
    reduction: &CoupledReduction,
    parts: &[StiffnessPart<'_>],
    forces: &[f64],
) -> Vec<f64> {
    let mut out = forces.to_vec();
    for part in parts {
        let size = part.matrix.rows();
        let offsets: Vec<f64> = (0..size)
            .map(|index| reduction.offset(part.full_dof(index)))
            .collect();
        let mut force = vec![0.0; size];
        part.matrix.mul_vec(&offsets, &mut force);
        for (index, value) in force.into_iter().enumerate() {
            out[part.full_dof(index)] -= value;
        }
    }
    out
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
        let what = if value == 0.0 { "fixed" } else { "prescribed" };
        let (slot, value) = match reduction.framed_support(index) {
            FramedSupport::Tangent { slot, sign } => (index_as_u32(slot), sign * value),
            FramedSupport::AcrossNormal => {
                return Err(FemError::ConstraintOnCoupledDof {
                    node,
                    component,
                    what,
                });
            }
            FramedSupport::Unframed => (reduction.slot_of[index], value),
        };
        if reduction.constraints.is_dependent(index) {
            return Err(FemError::ConstraintOnCoupledDof {
                node,
                component,
                what,
            });
        }
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
    // The normal component of a node under a normal constraint is its
    // equation's.
    for &node in reduction.frames.keys() {
        prescribed[reduction.slot_of[DOFS_PER_NODE * node] as usize] = Some(0.0);
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
                        list.push(index_as_u32(slot / 3));
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
    let mut adjacency: Vec<Vec<u32>> = (0..blocks).map(|block| vec![index_as_u32(block)]).collect();
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

/// Each surface coupling as the distributing coupling it stands for (see
/// [`CouplingKind::DistributingSurface`]), every other coupling unchanged.
/// A surface coupling's weights are its nodes' shares of the area of the
/// boundary triangles whose corners it names, and of the shell facets whose
/// corners it names; a named node on no such face carries no area and drops
/// out.
///
/// # Errors
/// [`FemError::Coupling`] for a coupled node out of range, or a surface
/// coupling whose nodes include no whole face.
fn surface_couplings(
    mesh: &TetMesh,
    shell: Option<ShellPart<'_>>,
    couplings: &[Coupling],
) -> Result<Vec<Coupling>, FemError> {
    if !couplings
        .iter()
        .any(|coupling| coupling.kind == CouplingKind::DistributingSurface)
    {
        return Ok(couplings.to_vec());
    }
    let boundary = BoundaryFaces::new(mesh);
    let mut member = vec![false; mesh.node_count()];
    couplings
        .iter()
        .enumerate()
        .map(|(index, coupling)| {
            if coupling.kind != CouplingKind::DistributingSurface {
                return Ok(coupling.clone());
            }
            let fail = |reason: String| FemError::Coupling {
                coupling: index,
                reason,
            };
            for &node in &coupling.nodes {
                let flag = member.get_mut(node).ok_or_else(|| {
                    fail(format!(
                        "coupled node {node} is out of range (the model has {} nodes)",
                        mesh.node_count()
                    ))
                })?;
                *flag = true;
            }
            let grips = |vertex: u32| member[vertex as usize];
            let mut shares: BTreeMap<usize, f64> =
                boundary.area_shares(mesh, grips).into_iter().collect();
            if let Some(part) = shell {
                for (facet, corners) in part.mesh.triangles().iter().enumerate() {
                    if !corners.iter().all(|&corner| grips(corner)) {
                        continue;
                    }
                    let [first, second, third] = part.mesh.corners(facet);
                    let doubled = cross(sub(second, first), sub(third, first));
                    let share = dot(doubled, doubled).sqrt() / 6.0;
                    for &corner in corners {
                        *shares.entry(corner as usize).or_insert(0.0) += share;
                    }
                }
            }
            for &node in &coupling.nodes {
                member[node] = false;
            }
            if shares.is_empty() {
                return Err(fail(
                    "its nodes include no whole face of the boundary, so there is no surface \
                     area to weight them by — pick the faces of a surface, or make the \
                     coupling kinematic"
                        .into(),
                ));
            }
            let (nodes, weights) = shares.into_iter().unzip();
            Ok(Coupling {
                reference: coupling.reference,
                nodes,
                weights,
                kind: CouplingKind::Distributing,
            })
        })
        .collect()
}

/// On a quadratic mesh, each kinematic coupling with every edge node whose two
/// ends it grips (see the module notes); an edge node the coupling already
/// names keeps its place. Every other coupling (a tie names its edge nodes
/// itself, see [`crate::tie::node_ties`]), and every coupling on a linear
/// mesh, unchanged.
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
            if !matches!(coupling.kind, CouplingKind::Kinematic { .. }) {
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

/// The caller's supports plus, on a quadratic mesh, the translations they
/// imply for the edge and face nodes of the supported boundary faces — the
/// rule of the uncoupled solve (`prepare_static`). A node DOF the caller
/// prescribes keeps the caller's value. DOFs out of range pass through for
/// `reduced_constraints` to refuse.
fn supports_with_boundary_nodes(
    mesh: &TetMesh,
    fixed_dofs: &[u32],
    fixed_values: &[f64],
) -> (Vec<u32>, Vec<f64>) {
    let mut dofs = fixed_dofs.to_vec();
    let mut values = fixed_values.to_vec();
    extend_to_boundary_nodes(
        mesh,
        DOFS_PER_NODE,
        fixed_dofs,
        fixed_values,
        &mut dofs,
        &mut values,
    );
    (dofs, values)
}
