// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! The Newton driver with load stepping. Increment n of N applies the load
//! factor λ = n/N to the forces and to the prescribed displacements, then
//! iterates u ← u + Δu with tangent · Δu = λ·f − `f_int(u)` until the
//! out-of-balance force is small. The first correction of an increment moves
//! the supported DOFs to their new values; later ones leave them there. The
//! out-of-balance force is measured without the reactions of the supports
//! and of the solver's own constraints ([`TangentSolver::settle`]); an
//! increment has converged only once those constraints are settled too.
//!
//! A problem whose tangent varies with the displacement can lose stability
//! ([`NonlinearProblem::tangent_varies`]). Its converged increments are
//! therefore checked: one CG solve with the converged tangent and a load that
//! excites every mode, which breaks down (pᵀKp ≤ 0) exactly when the tangent
//! is not positive definite. That catches the unstable equilibrium a
//! symmetric model reaches without its loads ever exciting the buckling
//! mode, as a perfectly straight column pushed past its Euler load does. A
//! correction solve that breaks down on such a problem is the same
//! instability, met on the way.
//!
//! Like [`crate::PcgRun`], the driver advances in steps: each
//! [`NewtonRun::advance`] spends at most a CG budget and returns after every
//! Newton iteration, so the browser can show progress and cancel.

use super::{NonlinearProblem, TangentSolver};
use crate::constraints::Dirichlet;
use crate::error::FemError;
use crate::mesh::TetMesh;
use crate::sparse::CsrMatrix;
use crate::static_solve::static_constraints;

#[derive(Debug, Clone, Copy)]
pub struct NewtonSettings {
    /// Load increments; the load factor grows by 1/`increments` per increment.
    pub increments: u32,
    /// Newton iterations allowed per increment.
    pub max_iterations: usize,
    /// An increment has converged when ‖`r_free`‖ ≤ `tolerance` ·
    /// max(‖λ·`f_free`‖, ‖(K·λ·`u_s`)`_free`‖, ‖`f_int`‖), with `r_free` the
    /// out-of-balance force on the free DOFs less the reactions of the
    /// solver's constraints, and K·λ·`u_s` the force the prescribed
    /// displacements exert on the model held everywhere else (K the tangent
    /// at the start of the increment): the load of a case driven by
    /// prescribed displacements, as λ·f is of one driven by forces. It gives
    /// a scale where the internal force has none, as when the prescribed
    /// displacements only move a body rigidly. The force the solver's own
    /// constraints impose (contact pushing an overlap apart,
    /// [`super::Settled::load`]) joins the max, its largest over the
    /// increment. The internal force over all DOFs includes the support
    /// reactions.
    pub tolerance: f64,
}

/// Where a [`NewtonRun`] stands after [`NewtonRun::advance`]. Increments and
/// iterations count from 1.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum NewtonStatus {
    /// The CG budget ran out during the correction solve of this iteration.
    Solving {
        increment: u32,
        iteration: usize,
        /// CG iterations spent on this correction so far.
        cg_iterations: usize,
    },
    /// The CG budget ran out during the stability check of this converged
    /// increment.
    Checking {
        increment: u32,
        /// CG iterations spent on the check so far.
        cg_iterations: usize,
    },
    /// This Newton iteration finished, leaving this out-of-balance force.
    Iterated {
        increment: u32,
        iteration: usize,
        relative_residual: f64,
    },
    /// Every increment has converged; the solution is final.
    Converged,
}

/// How one load increment converged.
#[derive(Debug, Clone, PartialEq)]
pub struct IncrementReport {
    pub load_factor: f64,
    /// Newton iterations (correction solves) it took.
    pub iterations: usize,
    /// Relative residual after each iteration (see
    /// [`NewtonSettings::tolerance`]).
    pub residuals: Vec<f64>,
    /// CG iterations over all its correction solves and its stability check.
    pub cg_iterations: usize,
}

#[derive(Debug, Clone)]
pub struct NewtonSolution {
    /// Displacement per node, x,y,z interleaved, as in
    /// [`crate::StaticSolution`]; unused vertices are held at zero.
    pub displacements: Vec<f64>,
    /// The internal force at the solution, one entry per DOF: its excess
    /// over the loads is the support reactions.
    pub internal_force: Vec<f64>,
    pub increments: Vec<IncrementReport>,
    pub unused_vertices: usize,
}

enum Phase {
    /// The residual and tangent at the current displacement are known.
    Evaluated,
    /// The solver holds the tangent and is solving for a correction.
    Solving {
        cg_iterations: usize,
    },
    /// The solver holds a copy of the converged tangent and checks its
    /// stability.
    Checking {
        cg_iterations: usize,
    },
    Done,
}

/// A Newton solve in progress (see the module documentation).
pub struct NewtonRun<P, S> {
    problem: P,
    solver: S,
    settings: NewtonSettings,
    /// The supports at load factor 1, extended and checked as for the linear
    /// solve.
    supports: Dirichlet,
    /// Whether any support prescribes a non-zero displacement, so that every
    /// increment moves it.
    supports_move: bool,
    forces: Vec<f64>,
    displacements: Vec<f64>,
    internal_force: Vec<f64>,
    /// The out-of-balance force less every constraint reaction, at the
    /// current iterate.
    free_residual: Vec<f64>,
    /// Whether the solver's constraints are unsettled at the current iterate.
    constraints_pending: bool,
    /// ‖(K·λ·`u_s`)`_free`‖ of the current increment (see
    /// [`NewtonSettings::tolerance`]).
    prescribed_load: f64,
    /// The largest force the solver's constraints imposed in the current
    /// increment ([`super::Settled::load`]).
    constraint_load: f64,
    /// Whether the current increment, converged, has passed its stability
    /// check.
    checked: bool,
    /// `None` while the solver holds it.
    tangent: Option<CsrMatrix>,
    increment: u32,
    iteration: usize,
    relative_residual: f64,
    report: IncrementReport,
    reports: Vec<IncrementReport>,
    phase: Phase,
    unused_vertices: usize,
}

impl<P: NonlinearProblem, S: TangentSolver> NewtonRun<P, S> {
    /// Check the load case as [`crate::prepare_static`] does and evaluate the
    /// problem at zero displacement. `solver` solves every correction.
    ///
    /// # Errors
    /// Invalid settings, the load-case errors of [`crate::prepare_static`], a
    /// tangent whose size does not match `mesh`, or the problem's own error.
    pub fn start(
        problem: P,
        solver: S,
        mesh: &TetMesh,
        fixed_dofs: &[u32],
        fixed_values: &[f64],
        forces: &[f64],
        settings: NewtonSettings,
    ) -> Result<Self, FemError> {
        if settings.increments == 0 || settings.max_iterations == 0 {
            return Err(FemError::NonlinearInput {
                reason: String::from(
                    "the increment count and the iteration limit must be positive",
                ),
            });
        }
        if !(settings.tolerance.is_finite() && settings.tolerance > 0.0) {
            return Err(FemError::NonlinearInput {
                reason: format!(
                    "the tolerance must be positive and finite, got {}",
                    settings.tolerance
                ),
            });
        }
        let supports = static_constraints(mesh, fixed_dofs, fixed_values, forces)?;
        let dof_count = mesh.dof_count();
        let tangent = problem.tangent_pattern();
        if tangent.rows() != dof_count {
            return Err(FemError::NonlinearInput {
                reason: format!(
                    "the tangent has {} rows, but the mesh {dof_count} DOFs",
                    tangent.rows()
                ),
            });
        }
        let supports_move = supports.prescribed().any(|(_, value)| value != 0.0);
        let mut run = Self {
            problem,
            solver,
            settings,
            supports,
            supports_move,
            forces: forces.to_vec(),
            displacements: vec![0.0; dof_count],
            internal_force: Vec::new(),
            free_residual: Vec::new(),
            constraints_pending: false,
            prescribed_load: 0.0,
            constraint_load: 0.0,
            checked: false,
            tangent: Some(tangent),
            increment: 1,
            iteration: 0,
            relative_residual: 0.0,
            report: IncrementReport {
                load_factor: 0.0,
                iterations: 0,
                residuals: Vec::new(),
                cg_iterations: 0,
            },
            reports: Vec::new(),
            phase: Phase::Evaluated,
            unused_vertices: mesh.unused_vertex_count(),
        };
        run.evaluate()?;
        run.begin_increment()?;
        Ok(run)
    }

    /// Continue the solve, spending at most `cg_budget` CG iterations. Returns
    /// after each Newton iteration, when the budget runs out mid-solve, or
    /// once the last increment has converged.
    ///
    /// # Errors
    /// A zero budget; [`FemError::NewtonNotConverged`] when an increment
    /// reaches its iteration limit; [`FemError::TangentNotPositiveDefinite`]
    /// when a problem whose tangent varies loses stability;
    /// [`FemError::TangentSolve`] when a correction cannot be solved; the
    /// problem's own error.
    pub fn advance(&mut self, cg_budget: usize) -> Result<NewtonStatus, FemError> {
        if cg_budget == 0 {
            return Err(FemError::NonlinearInput {
                reason: String::from("the CG budget must be positive"),
            });
        }
        loop {
            match self.phase {
                Phase::Done => return Ok(NewtonStatus::Converged),
                Phase::Evaluated => {
                    if self.increment_converged() {
                        if self.problem.tangent_varies() && !self.checked {
                            self.start_check()?;
                            continue;
                        }
                        self.reports.push(self.report.clone());
                        if self.increment == self.settings.increments {
                            self.phase = Phase::Done;
                            return Ok(NewtonStatus::Converged);
                        }
                        self.increment += 1;
                        self.begin_increment()?;
                        continue;
                    }
                    if self.iteration == self.settings.max_iterations {
                        return Err(FemError::NewtonNotConverged {
                            increment: self.increment,
                            increments: self.settings.increments,
                            iterations: self.iteration,
                            relative_residual: self.relative_residual,
                            target: self.settings.tolerance,
                        });
                    }
                    self.start_correction()?;
                }
                Phase::Checking { cg_iterations } => {
                    let progress = self
                        .solver
                        .advance(cg_budget)
                        .map_err(|error| self.tangent_failure(error))?;
                    let cg_iterations = cg_iterations + progress.iterations;
                    self.report.cg_iterations += progress.iterations;
                    if !progress.ready {
                        self.phase = Phase::Checking { cg_iterations };
                        return Ok(NewtonStatus::Checking {
                            increment: self.increment,
                            cg_iterations,
                        });
                    }
                    // Only the breakdown it did not meet matters; the copy
                    // of the tangent is spent.
                    self.solver
                        .finish()
                        .map_err(|error| self.tangent_failure(error))?;
                    self.checked = true;
                    self.phase = Phase::Evaluated;
                }
                Phase::Solving { cg_iterations } => {
                    let progress = self
                        .solver
                        .advance(cg_budget)
                        .map_err(|error| self.tangent_failure(error))?;
                    let cg_iterations = cg_iterations + progress.iterations;
                    self.report.cg_iterations += progress.iterations;
                    if !progress.ready {
                        self.phase = Phase::Solving { cg_iterations };
                        return Ok(NewtonStatus::Solving {
                            increment: self.increment,
                            iteration: self.iteration + 1,
                            cg_iterations,
                        });
                    }
                    self.apply_correction()?;
                    return Ok(NewtonStatus::Iterated {
                        increment: self.increment,
                        iteration: self.iteration,
                        relative_residual: self.relative_residual,
                    });
                }
            }
        }
    }

    /// The current displacement iterate.
    #[must_use]
    pub fn displacements(&self) -> &[f64] {
        &self.displacements
    }

    /// The tangent solver, with whatever state its constraints are in (a
    /// contact solver's pressures).
    #[must_use]
    pub fn solver(&self) -> &S {
        &self.solver
    }

    /// The converged solution.
    ///
    /// # Errors
    /// [`FemError::NewtonUnfinished`] before the last increment has converged.
    pub fn into_solution(self) -> Result<NewtonSolution, FemError> {
        if !matches!(self.phase, Phase::Done) {
            return Err(FemError::NewtonUnfinished {
                increment: self.increment,
                iteration: self.iteration,
            });
        }
        Ok(NewtonSolution {
            displacements: self.displacements,
            internal_force: self.internal_force,
            increments: self.reports,
            unused_vertices: self.unused_vertices,
        })
    }

    fn load_factor(&self) -> f64 {
        f64::from(self.increment) / f64::from(self.settings.increments)
    }

    fn begin_increment(&mut self) -> Result<(), FemError> {
        self.iteration = 0;
        self.report = IncrementReport {
            load_factor: self.load_factor(),
            iterations: 0,
            residuals: Vec::new(),
            cg_iterations: 0,
        };
        self.prescribed_load = self.measure_prescribed_load()?;
        self.constraint_load = 0.0;
        self.checked = false;
        self.settle()
    }

    /// ‖(K·λ·`u_s`)`_free`‖ with the current tangent.
    fn measure_prescribed_load(&self) -> Result<f64, FemError> {
        if !self.supports_move {
            return Ok(0.0);
        }
        let tangent = self
            .tangent
            .as_ref()
            .ok_or_else(|| FemError::NonlinearInput {
                reason: String::from("the tangent is held by an unfinished solve"),
            })?;
        let factor = self.load_factor();
        let mut prescribed = vec![0.0; self.displacements.len()];
        for (dof, value) in self.supports.prescribed() {
            prescribed[dof] = factor * value;
        }
        let mut force = vec![0.0; prescribed.len()];
        tangent.mul_vec(&prescribed, &mut force);
        Ok(force
            .iter()
            .enumerate()
            .filter(|(dof, _)| self.supports.value(*dof).is_none())
            .map(|(_, value)| value * value)
            .sum::<f64>()
            .sqrt())
    }

    /// Converged once the increment's supports are applied, the solver's
    /// constraints are settled and the out-of-balance force is
    /// within tolerance.
    fn increment_converged(&self) -> bool {
        let supports_pending = self.iteration == 0 && self.supports_move;
        !supports_pending
            && !self.constraints_pending
            && self.relative_residual <= self.settings.tolerance
    }

    /// Let the solver settle its constraints at the current iterate, and
    /// measure what is left out of balance.
    fn settle(&mut self) -> Result<(), FemError> {
        let residual = self.out_of_balance();
        let tangent = self
            .tangent
            .as_ref()
            .ok_or_else(|| FemError::NonlinearInput {
                reason: String::from("the tangent is held by an unfinished solve"),
            })?;
        let settled = self
            .solver
            .settle(&self.displacements, residual, tangent, &self.supports)
            .map_err(|error| self.tangent_failure(error))?;
        if settled.residual.len() != self.displacements.len() {
            return Err(FemError::DisplacementLength {
                len: settled.residual.len(),
                count: self.displacements.len(),
            });
        }
        self.free_residual = settled.residual;
        self.constraints_pending = settled.pending;
        self.constraint_load = self.constraint_load.max(settled.load);
        self.relative_residual = self.measure_residual();
        Ok(())
    }

    /// λ·f − `f_int` on the free DOFs, zero on the supported ones.
    fn out_of_balance(&self) -> Vec<f64> {
        let factor = self.load_factor();
        let mut residual: Vec<f64> = self
            .forces
            .iter()
            .zip(&self.internal_force)
            .map(|(force, internal)| factor * force - internal)
            .collect();
        for (dof, _) in self.supports.prescribed() {
            residual[dof] = 0.0;
        }
        residual
    }

    /// See [`NewtonSettings::tolerance`].
    fn measure_residual(&self) -> f64 {
        let factor = self.load_factor();
        let norm = |values: &mut dyn Iterator<Item = f64>| {
            values.map(|value| value * value).sum::<f64>().sqrt()
        };
        let residual = norm(&mut self.free_residual.iter().copied());
        let free_load = norm(
            &mut self
                .forces
                .iter()
                .enumerate()
                .filter(|(dof, _)| self.supports.value(*dof).is_none())
                .map(|(_, force)| factor * force),
        );
        let internal = norm(&mut self.internal_force.iter().copied());
        let scale = free_load
            .max(self.prescribed_load)
            .max(self.constraint_load)
            .max(internal);
        if scale == 0.0 {
            // No load, no internal force: the residual is zero as well.
            0.0
        } else {
            residual / scale
        }
    }

    fn start_correction(&mut self) -> Result<(), FemError> {
        let factor = self.load_factor();
        let displacements = &self.displacements;
        let prescribed = self
            .supports
            .with_values(|dof, value| factor * value - displacements[dof]);
        let tangent = self
            .tangent
            .take()
            .ok_or_else(|| FemError::NonlinearInput {
                reason: String::from("the tangent is held by an unfinished solve"),
            })?;
        let residual = self.out_of_balance();
        self.solver
            .start(tangent, residual, &prescribed)
            .map_err(|error| self.tangent_failure(error))?;
        self.phase = Phase::Solving { cg_iterations: 0 };
        Ok(())
    }

    /// Start the stability check of the converged increment: a solve with a
    /// copy of the tangent, the supports held, and a load on every free DOF.
    fn start_check(&mut self) -> Result<(), FemError> {
        let tangent = self
            .tangent
            .as_ref()
            .ok_or_else(|| FemError::NonlinearInput {
                reason: String::from("the tangent is held by an unfinished solve"),
            })?
            .clone();
        let held = self.supports.with_values(|_, _| 0.0);
        self.solver
            .start(tangent, probe(self.displacements.len()), &held)
            .map_err(|error| self.tangent_failure(error))?;
        self.phase = Phase::Checking { cg_iterations: 0 };
        Ok(())
    }

    fn apply_correction(&mut self) -> Result<(), FemError> {
        let (correction, tangent) = self
            .solver
            .finish()
            .map_err(|error| self.tangent_failure(error))?;
        if correction.len() != self.displacements.len() {
            return Err(FemError::DisplacementLength {
                len: correction.len(),
                count: self.displacements.len(),
            });
        }
        for (value, delta) in self.displacements.iter_mut().zip(&correction) {
            *value += delta;
        }
        // Exactly the increment's values, free of the rounding in u + Δu.
        let factor = self.load_factor();
        for (dof, value) in self.supports.prescribed() {
            self.displacements[dof] = factor * value;
        }
        self.tangent = Some(tangent);
        self.iteration += 1;
        self.evaluate()?;
        self.settle()?;
        self.report.iterations = self.iteration;
        self.report.residuals.push(self.relative_residual);
        self.phase = Phase::Evaluated;
        Ok(())
    }

    /// The internal force and tangent at the current displacement.
    fn evaluate(&mut self) -> Result<(), FemError> {
        let tangent = self
            .tangent
            .as_mut()
            .ok_or_else(|| FemError::NonlinearInput {
                reason: String::from("the tangent is held by an unfinished solve"),
            })?;
        tangent.values_mut().fill(0.0);
        let force = self
            .problem
            .internal_force_and_tangent(&self.displacements, tangent)?;
        if force.len() != self.displacements.len() {
            return Err(FemError::NonlinearInput {
                reason: format!(
                    "the internal force has {} entries, but the model {} DOFs",
                    force.len(),
                    self.displacements.len()
                ),
            });
        }
        if let Some(&value) = force.iter().find(|value| !value.is_finite()) {
            return Err(FemError::NonFinite {
                what: "an internal force component",
                value,
            });
        }
        self.internal_force = force;
        Ok(())
    }

    /// A tangent solve's error as the driver reports it: a tangent that is
    /// not positive definite, on a problem whose tangent varies and away from
    /// the undeformed state (where the tangent is the linear stiffness, and
    /// such a tangent means the model is not held), is the stability limit.
    /// A contact solver's verdict on the model reaches the user as it is.
    fn tangent_failure(&self, error: FemError) -> FemError {
        if matches!(error, FemError::ContactUnheld { .. }) {
            return error;
        }
        let indefinite = matches!(
            error,
            FemError::NotPositiveDefinite { .. } | FemError::CoarseNotPositiveDefinite { .. }
        );
        let deformed = self.displacements.iter().any(|value| *value != 0.0);
        if indefinite && deformed && self.problem.tangent_varies() {
            return FemError::TangentNotPositiveDefinite {
                increment: self.increment,
                increments: self.settings.increments,
                load_factor: self.load_factor(),
            };
        }
        FemError::TangentSolve {
            increment: self.increment,
            iteration: self.iteration + 1,
            reason: error.to_string(),
        }
    }
}

/// The load of the stability check: a deterministic sequence spread over
/// [−1, 1) with no pattern a model's modes could be orthogonal to
/// (`SplitMix64`, Steele, Lea & Flood 2014).
fn probe(count: usize) -> Vec<f64> {
    let mut state: u64 = 0x9E37_79B9_7F4A_7C15;
    (0..count)
        .map(|_| {
            state = state.wrapping_add(0x9E37_79B9_7F4A_7C15);
            let mut mixed = state;
            mixed = (mixed ^ (mixed >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
            mixed = (mixed ^ (mixed >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
            mixed ^= mixed >> 31;
            // The top 52 bits as the mantissa of a number in [1, 2), then
            // mapped onto [−1, 1).
            let unit = f64::from_bits(0x3FF0_0000_0000_0000 | (mixed >> 12));
            2.0 * unit - 3.0
        })
        .collect()
}

/// Run a [`NewtonRun`] to the end in one go.
///
/// # Errors
/// As [`NewtonRun::start`] and [`NewtonRun::advance`].
pub fn solve_newton<P: NonlinearProblem, S: TangentSolver>(
    problem: P,
    solver: S,
    mesh: &TetMesh,
    fixed_dofs: &[u32],
    fixed_values: &[f64],
    forces: &[f64],
    settings: NewtonSettings,
) -> Result<NewtonSolution, FemError> {
    let mut run = NewtonRun::start(
        problem,
        solver,
        mesh,
        fixed_dofs,
        fixed_values,
        forces,
        settings,
    )?;
    while run.advance(usize::MAX)? != NewtonStatus::Converged {}
    run.into_solution()
}
