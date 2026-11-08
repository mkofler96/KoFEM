// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-FileCopyrightText: 2010-2024 Lawrence Livermore National Security, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later AND BSD-3-Clause

//! Preconditioned conjugate gradients with the engine's MFEM stopping rule
//! (`mfem::CGSolver`). [`solve_pcg`] uses one symmetric Gauss–Seidel sweep, as
//! the engine does (`mfem::GSSmoother`), so iteration counts compare;
//! [`solve_pcg_with`] takes any [`Preconditioner`], such as multigrid.
//!
//! [`PcgRun`] is the same iteration as a resumable object: the caller advances
//! it in steps, which lets the browser report progress between steps and ask
//! the user whether to go on when the iteration budget runs out.
//!
//! MFEM reference: `CGSolver::Mult` in `linalg/solvers.cpp` (MFEM v4.7).
//! MFEM copyright (c) 2010-2024, Lawrence Livermore National Security, LLC.
//! All rights reserved. See `../NOTICE.md` and `../LICENSE-MFEM` (BSD-3-Clause).

use std::collections::VecDeque;

use crate::amg::{Preconditioner, SymmetricGaussSeidel};
use crate::error::FemError;
use crate::sparse::CsrMatrix;

/// What `relative_tolerance` is measured against.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StoppingRule {
    /// √((M⁻¹r, r) / (M⁻¹r₀, r₀)): MFEM's rule. Its meaning depends on the
    /// preconditioner M, so the same tolerance is a different accuracy for
    /// Gauss–Seidel and for multigrid.
    PreconditionedNorm,
    /// ‖r‖ / ‖b‖: the out-of-balance force relative to the load, the same
    /// accuracy whatever the preconditioner.
    ResidualNorm,
}

#[derive(Debug, Clone, Copy)]
pub struct CgSettings {
    /// Stop when the measure chosen by `stopping` falls to this.
    pub relative_tolerance: f64,
    pub max_iterations: usize,
    pub stopping: StoppingRule,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CgOutcome {
    pub iterations: usize,
    pub relative_residual: f64,
}

/// Where a [`PcgRun`] stands after [`PcgRun::advance`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PcgStatus {
    /// The tolerance is met; the solution is final.
    Converged,
    /// The requested iterations ran without meeting the tolerance.
    Running,
}

/// Residuals kept for the "still descending?" test: the C++ engine's window
/// is at most this long.
const HISTORY: usize = 100;

/// A conjugate-gradient solve in progress, from x = 0. Holds the iterate and
/// search state only; the matrix and preconditioner are passed to each call,
/// so the caller owns them.
#[derive(Debug, Clone)]
pub struct PcgRun {
    solution: Vec<f64>,
    residual: Vec<f64>,
    preconditioned: Vec<f64>,
    direction: Vec<f64>,
    product: Vec<f64>,
    rho: f64,
    rho_initial: f64,
    load_squared: f64,
    stopping: StoppingRule,
    tolerance: f64,
    iterations: usize,
    /// Relative residual after each of the last `HISTORY` iterations.
    recent: VecDeque<f64>,
    converged: bool,
}

impl PcgRun {
    /// Set up the iteration for A·x = b (A and M from `system`).
    ///
    /// # Errors
    /// [`FemError::InvalidSettings`] for a non-positive or non-finite
    /// tolerance.
    pub fn start(
        system: &mut dyn Preconditioner,
        rhs: &[f64],
        relative_tolerance: f64,
        stopping: StoppingRule,
    ) -> Result<Self, FemError> {
        if !(relative_tolerance.is_finite() && relative_tolerance > 0.0) {
            return Err(FemError::InvalidSettings {
                reason: "the tolerance must be positive",
            });
        }
        let size = system.matrix().rows();
        let residual = rhs.to_vec();
        let mut preconditioned = vec![0.0; size];
        system.apply(&residual, &mut preconditioned);
        let rho = dot(&residual, &preconditioned);
        Ok(Self {
            solution: vec![0.0; size],
            direction: preconditioned.clone(),
            product: vec![0.0; size],
            preconditioned,
            residual,
            rho,
            rho_initial: rho,
            load_squared: dot(rhs, rhs),
            stopping,
            tolerance: relative_tolerance,
            iterations: 0,
            recent: VecDeque::with_capacity(HISTORY),
            // No load and nothing prescribed: the solution is exactly zero.
            converged: rho == 0.0,
        })
    }

    /// Iterate until converged or `until` iterations have run in total.
    ///
    /// # Errors
    /// [`FemError::NotPositiveDefinite`] on a breakdown (pᵀAp ≤ 0, typically
    /// an unconstrained model).
    pub fn advance(
        &mut self,
        system: &mut dyn Preconditioner,
        until: usize,
    ) -> Result<PcgStatus, FemError> {
        let target = self.tolerance * self.tolerance;
        while !self.converged && self.iterations < until {
            let iteration = self.iterations + 1;
            system.matrix().mul_vec(&self.direction, &mut self.product);
            let curvature = dot(&self.direction, &self.product);
            if curvature <= 0.0 || !curvature.is_finite() {
                return Err(FemError::NotPositiveDefinite { iteration });
            }
            let step = self.rho / curvature;
            for ((solution, residual), (direction, product)) in self
                .solution
                .iter_mut()
                .zip(self.residual.iter_mut())
                .zip(self.direction.iter().zip(&self.product))
            {
                *solution += step * direction;
                *residual -= step * product;
            }
            system.apply(&self.residual, &mut self.preconditioned);
            let rho_next = dot(&self.residual, &self.preconditioned);
            self.iterations = iteration;
            let reached = self.squared_measure(rho_next);
            if self.recent.len() == HISTORY {
                self.recent.pop_front();
            }
            self.recent.push_back(reached.sqrt());
            if reached <= target {
                self.rho = rho_next;
                self.converged = true;
                break;
            }
            let beta = rho_next / self.rho;
            for (direction, preconditioned) in self.direction.iter_mut().zip(&self.preconditioned) {
                *direction = preconditioned + beta * *direction;
            }
            self.rho = rho_next;
        }
        Ok(if self.converged {
            PcgStatus::Converged
        } else {
            PcgStatus::Running
        })
    }

    /// Squared relative residual in the chosen measure, from (r, M⁻¹r) and r.
    fn squared_measure(&self, rho_now: f64) -> f64 {
        match self.stopping {
            StoppingRule::PreconditionedNorm => rho_now / self.rho_initial,
            StoppingRule::ResidualNorm => dot(&self.residual, &self.residual) / self.load_squared,
        }
    }

    #[must_use]
    pub fn iterations(&self) -> usize {
        self.iterations
    }

    #[must_use]
    pub fn is_converged(&self) -> bool {
        self.converged
    }

    /// Current relative residual in the chosen measure.
    #[must_use]
    pub fn relative_residual(&self) -> f64 {
        if self.rho_initial == 0.0 {
            0.0
        } else {
            self.squared_measure(self.rho).sqrt()
        }
    }

    #[must_use]
    pub fn tolerance(&self) -> f64 {
        self.tolerance
    }

    /// Whether the residual is still falling over the last `window`
    /// iterations, so that more iterations are worth offering. The test is the
    /// C++ engine's (`CgContinuation::extend`): CG residuals oscillate, so the
    /// geometric means of the two halves of the window are compared, and the
    /// latest value must also be below the first. A stalled solve is not
    /// offered more iterations. `window` is capped at 100.
    #[must_use]
    pub fn still_descending(&self, window: usize) -> bool {
        let window = window.clamp(2, HISTORY);
        let current = self.relative_residual();
        if self.converged
            || self.recent.len() < window
            || !current.is_finite()
            || current <= self.tolerance
        {
            return false;
        }
        let recent: Vec<f64> = self
            .recent
            .iter()
            .skip(self.recent.len() - window)
            .copied()
            .collect();
        if recent
            .iter()
            .any(|value| !value.is_finite() || *value <= 0.0)
        {
            return false;
        }
        let half = recent.len() / 2;
        let mean_log = |values: &[f64]| -> f64 {
            #[allow(
                clippy::cast_precision_loss,
                reason = "a window of at most 100 residuals"
            )]
            let count = values.len() as f64;
            values.iter().map(|value| value.ln()).sum::<f64>() / count
        };
        let margin = 0.999_999_f64;
        current < recent[0] * margin
            && mean_log(&recent[half..]) < mean_log(&recent[..half]) + margin.ln()
    }

    /// The solution once converged.
    ///
    /// # Errors
    /// [`FemError::NotConverged`] when the tolerance has not been met.
    pub fn into_solution(self) -> Result<(Vec<f64>, CgOutcome), FemError> {
        if !self.converged {
            return Err(FemError::NotConverged {
                iterations: self.iterations,
                relative_residual: self.relative_residual(),
                target: self.tolerance,
            });
        }
        let outcome = CgOutcome {
            iterations: self.iterations,
            relative_residual: self.relative_residual(),
        };
        Ok((self.solution, outcome))
    }
}

/// Solve A·x = b from x = 0, preconditioned by one symmetric Gauss–Seidel sweep.
///
/// # Errors
/// As [`solve_pcg_with`].
pub fn solve_pcg(
    matrix: &CsrMatrix,
    rhs: &[f64],
    settings: CgSettings,
) -> Result<(Vec<f64>, CgOutcome), FemError> {
    solve_pcg_with(
        &mut SymmetricGaussSeidel::new(matrix.clone()),
        rhs,
        settings,
    )
}

/// Solve A·x = b from x = 0 with the system's matrix A and preconditioner M.
/// With [`StoppingRule::PreconditionedNorm`] the tolerance is measured in M's
/// norm, so it compares only between runs with the same preconditioner;
/// [`StoppingRule::ResidualNorm`] compares across preconditioners.
///
/// # Errors
/// [`FemError::NotPositiveDefinite`] on a breakdown (pᵀAp ≤ 0, typically an
/// unconstrained model), [`FemError::NotConverged`] when the iteration budget
/// runs out, [`FemError::InvalidSettings`] for a non-positive tolerance or
/// budget.
pub fn solve_pcg_with(
    system: &mut dyn Preconditioner,
    rhs: &[f64],
    settings: CgSettings,
) -> Result<(Vec<f64>, CgOutcome), FemError> {
    if settings.max_iterations == 0 {
        return Err(FemError::InvalidSettings {
            reason: "the iteration budget must be positive",
        });
    }
    let mut run = PcgRun::start(system, rhs, settings.relative_tolerance, settings.stopping)?;
    run.advance(system, settings.max_iterations)?;
    run.into_solution()
}

fn dot(lhs: &[f64], rhs: &[f64]) -> f64 {
    lhs.iter().zip(rhs).map(|(left, right)| left * right).sum()
}
