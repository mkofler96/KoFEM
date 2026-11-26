// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! The linear solve of each Newton correction, behind one seam: the driver
//! hands over the tangent, the out-of-balance force and the correction the
//! supports prescribe, steps the solve in iteration budgets, and takes back
//! the full-length correction. How the constraints enter the system
//! (elimination here, a reduction with offsets for contact) and which Krylov
//! method solves it are the solver's business. So are the reactions of the
//! constraints beyond the supports — contact pressures, tie forces — which
//! [`TangentSolver::settle`] takes out of the out-of-balance force before the
//! driver measures it, and the set of those constraints (contact's active
//! set), which may change from one iterate to the next.

use crate::amg::Preconditioner;
use crate::cg::{CgSettings, PcgRun, PcgStatus};
use crate::constraints::{apply_dirichlet, Dirichlet};
use crate::error::FemError;
use crate::mesh::TetMesh;
use crate::sparse::CsrMatrix;
use crate::static_solve::{precondition, PreconditionerChoice};

/// What one [`TangentSolver::advance`] did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SolveProgress {
    /// Iterations run in this call; at most the budget.
    pub iterations: usize,
    /// Whether the correction is solved, for [`TangentSolver::finish`].
    pub ready: bool,
}

/// What [`TangentSolver::settle`] found at an iterate.
#[derive(Debug, Clone, PartialEq)]
pub struct Settled {
    /// The out-of-balance force less the reactions of the solver's own
    /// constraints, one entry per DOF: what vanishes at equilibrium.
    pub residual: Vec<f64>,
    /// Whether the solver's constraints are not settled at this iterate:
    /// their set changed (a contact node opened or closed), or the iterate
    /// does not satisfy them yet (an overlap still to push apart). It is then
    /// no solution, whatever its residual.
    pub pending: bool,
    /// The force the solver's constraints impose at this iterate: the
    /// tangent times the displacement they still prescribe (contact closing
    /// a gap or pushing an overlap apart), on the free DOFs. A scale for the
    /// residual where loads and supports give none, as the prescribed
    /// displacements' force is.
    pub load: f64,
}

/// One linear solve per Newton correction: tangent · Δu = residual, with Δu
/// prescribed at the supported DOFs.
pub trait TangentSolver {
    /// Bring the solver's own constraints to the iterate `displacements`,
    /// with out-of-balance force `residual` (zero at the `supports`, the
    /// supports at load factor 1): take their reactions out of the residual
    /// and update their set, saying whether they are settled. The driver calls it after every evaluation, and
    /// before each [`TangentSolver::start`], which solves with the set it
    /// leaves.
    ///
    /// # Errors
    /// Constraints that do not fit the model or its supports.
    fn settle(
        &mut self,
        displacements: &[f64],
        residual: Vec<f64>,
        tangent: &CsrMatrix,
        supports: &Dirichlet,
    ) -> Result<Settled, FemError>;

    /// Set up the solve. `residual` has one entry per DOF; its entries at the
    /// prescribed DOFs carry no meaning.
    ///
    /// # Errors
    /// Invalid settings, or a preconditioner setup that fails on `tangent`.
    fn start(
        &mut self,
        tangent: CsrMatrix,
        residual: Vec<f64>,
        prescribed: &Dirichlet,
    ) -> Result<(), FemError>;

    /// Run at most `budget` more iterations of the started solve.
    ///
    /// # Errors
    /// A breakdown, or the solve's own iteration limit reached unconverged.
    fn advance(&mut self, budget: usize) -> Result<SolveProgress, FemError>;

    /// The correction, one entry per DOF, and the tangent's storage back for
    /// the next iteration (its values are spent).
    ///
    /// # Errors
    /// No solve started, or the started one not yet converged.
    fn finish(&mut self) -> Result<(Vec<f64>, CsrMatrix), FemError>;
}

/// The solid solve's linear method: symmetric Dirichlet elimination, then CG
/// with Gauss–Seidel or multigrid, as [`crate::prepare_static`] does.
pub struct DirichletCg {
    node_coordinates: Vec<[f64; 3]>,
    cg: CgSettings,
    preconditioner: PreconditionerChoice,
    active: Option<ActiveSolve>,
}

struct ActiveSolve {
    system: Box<dyn Preconditioner>,
    run: PcgRun,
}

impl DirichletCg {
    /// Solves on `mesh`'s DOFs; multigrid aggregates by its nodes. Each
    /// correction stops at `cg.relative_tolerance` and fails after
    /// `cg.max_iterations`.
    #[must_use]
    pub fn new(mesh: &TetMesh, cg: CgSettings, preconditioner: PreconditionerChoice) -> Self {
        Self {
            node_coordinates: mesh.node_coordinates().to_vec(),
            cg,
            preconditioner,
            active: None,
        }
    }

    fn active(&mut self) -> Result<&mut ActiveSolve, FemError> {
        self.active
            .as_mut()
            .ok_or_else(|| FemError::NonlinearInput {
                reason: String::from("no tangent solve has been started"),
            })
    }
}

impl TangentSolver for DirichletCg {
    /// The supports are its only constraints, and the driver already leaves
    /// their reactions out.
    fn settle(
        &mut self,
        _displacements: &[f64],
        residual: Vec<f64>,
        _tangent: &CsrMatrix,
        _supports: &Dirichlet,
    ) -> Result<Settled, FemError> {
        Ok(Settled {
            residual,
            pending: false,
            load: 0.0,
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
        let mut matrix = tangent;
        let mut rhs = residual;
        apply_dirichlet(&mut matrix, &mut rhs, prescribed);
        let (mut system, _levels) = precondition(
            &self.node_coordinates,
            matrix,
            prescribed,
            self.preconditioner,
        )?;
        let run = PcgRun::start(
            system.as_mut(),
            &rhs,
            self.cg.relative_tolerance,
            self.cg.stopping,
        )?;
        self.active = Some(ActiveSolve { system, run });
        Ok(())
    }

    fn advance(&mut self, budget: usize) -> Result<SolveProgress, FemError> {
        let limit = self.cg.max_iterations;
        let solve = self.active()?;
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
        let ActiveSolve { system, run } =
            self.active.take().ok_or_else(|| FemError::NonlinearInput {
                reason: String::from("no tangent solve has been started"),
            })?;
        let (correction, _outcome) = run.into_solution()?;
        Ok((correction, system.into_matrix()))
    }
}
