// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! The Newton driver with load stepping. Increment n of N applies the load
//! factor λ = n/N to the forces and to the prescribed displacements, then
//! iterates u ← u + Δu with tangent · Δu = λ·f − `f_int(u)` until the
//! out-of-balance force is small. The first correction of an increment moves
//! the supported DOFs to their new values; later ones leave them there.
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
    pub increments: usize,
    /// Newton iterations allowed per increment.
    pub max_iterations: usize,
    /// An increment has converged when ‖`r_free`‖ ≤ `tolerance` ·
    /// max(‖λ·`f_free`‖, ‖`f_int`‖), with `r_free` the out-of-balance force
    /// on the free DOFs. The
    /// internal force over all DOFs includes the support reactions, so a load
    /// case driven by prescribed displacements alone has a scale too.
    pub tolerance: f64,
}

/// Where a [`NewtonRun`] stands after [`NewtonRun::advance`]. Increments and
/// iterations count from 1.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum NewtonStatus {
    /// The CG budget ran out during the correction solve of this iteration.
    Solving {
        increment: usize,
        iteration: usize,
        /// CG iterations spent on this correction so far.
        cg_iterations: usize,
    },
    /// This Newton iteration finished, leaving this out-of-balance force.
    Iterated {
        increment: usize,
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
    /// CG iterations over all its correction solves.
    pub cg_iterations: usize,
}

#[derive(Debug, Clone)]
pub struct NewtonSolution {
    /// Displacement per node, x,y,z interleaved, as in
    /// [`crate::StaticSolution`]; unused vertices are held at zero.
    pub displacements: Vec<f64>,
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
    /// `None` while the solver holds it.
    tangent: Option<CsrMatrix>,
    increment: usize,
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
            reports: Vec::with_capacity(settings.increments),
            phase: Phase::Evaluated,
            unused_vertices: mesh.unused_vertex_count(),
        };
        run.evaluate()?;
        run.begin_increment();
        Ok(run)
    }

    /// Continue the solve, spending at most `cg_budget` CG iterations. Returns
    /// after each Newton iteration, when the budget runs out mid-solve, or
    /// once the last increment has converged.
    ///
    /// # Errors
    /// A zero budget; [`FemError::NewtonNotConverged`] when an increment
    /// reaches its iteration limit; [`FemError::TangentSolve`] when a
    /// correction cannot be solved; the problem's own error.
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
                        self.reports.push(self.report.clone());
                        if self.increment == self.settings.increments {
                            self.phase = Phase::Done;
                            return Ok(NewtonStatus::Converged);
                        }
                        self.increment += 1;
                        self.begin_increment();
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
                Phase::Solving { cg_iterations } => {
                    let progress = self
                        .solver
                        .advance(cg_budget)
                        .map_err(|error| self.tangent_failure(&error))?;
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
            increments: self.reports,
            unused_vertices: self.unused_vertices,
        })
    }

    fn load_factor(&self) -> f64 {
        #[allow(
            clippy::cast_precision_loss,
            reason = "increment counts are small; n/N is exactly 1 at the last increment"
        )]
        let factor = self.increment as f64 / self.settings.increments as f64;
        factor
    }

    fn begin_increment(&mut self) {
        self.iteration = 0;
        self.report = IncrementReport {
            load_factor: self.load_factor(),
            iterations: 0,
            residuals: Vec::new(),
            cg_iterations: 0,
        };
        self.relative_residual = self.measure_residual();
    }

    /// Converged once the increment's supports are applied and the
    /// out-of-balance force is within tolerance.
    fn increment_converged(&self) -> bool {
        let supports_pending = self.iteration == 0 && self.supports_move;
        !supports_pending && self.relative_residual <= self.settings.tolerance
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
        let residual = norm(&mut self.out_of_balance().into_iter());
        let free_load = norm(
            &mut self
                .forces
                .iter()
                .enumerate()
                .filter(|(dof, _)| self.supports.value(*dof).is_none())
                .map(|(_, force)| factor * force),
        );
        let internal = norm(&mut self.internal_force.iter().copied());
        let scale = free_load.max(internal);
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
            .map_err(|error| self.tangent_failure(&error))?;
        self.phase = Phase::Solving { cg_iterations: 0 };
        Ok(())
    }

    fn apply_correction(&mut self) -> Result<(), FemError> {
        let (correction, tangent) = self
            .solver
            .finish()
            .map_err(|error| self.tangent_failure(&error))?;
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
        self.relative_residual = self.measure_residual();
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

    fn tangent_failure(&self, error: &FemError) -> FemError {
        FemError::TangentSolve {
            increment: self.increment,
            iteration: self.iteration + 1,
            reason: error.to_string(),
        }
    }
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
