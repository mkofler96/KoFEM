// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-FileCopyrightText: 2010-2024 Lawrence Livermore National Security, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later AND BSD-3-Clause

//! Preconditioned conjugate gradients with the engine's MFEM stopping rule
//! (`mfem::CGSolver`). [`solve_pcg`] uses one symmetric Gauss–Seidel sweep, as
//! the engine does (`mfem::GSSmoother`), so iteration counts compare;
//! [`solve_pcg_with`] takes any [`Preconditioner`], such as multigrid.
//!
//! MFEM reference: `CGSolver::Mult` in `linalg/solvers.cpp` (MFEM v4.7).
//! MFEM copyright (c) 2010-2024, Lawrence Livermore National Security, LLC.
//! All rights reserved. See `../NOTICE.md` and `../LICENSE-MFEM` (BSD-3-Clause).

use crate::amg::{Preconditioner, SymmetricGaussSeidel};
use crate::error::FemError;
use crate::sparse::CsrMatrix;

#[derive(Debug, Clone, Copy)]
pub struct CgSettings {
    /// Stop when √((M⁻¹r, r) / (M⁻¹r₀, r₀)) ≤ this.
    pub relative_tolerance: f64,
    pub max_iterations: usize,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CgOutcome {
    pub iterations: usize,
    pub relative_residual: f64,
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
        matrix,
        rhs,
        settings,
        &mut SymmetricGaussSeidel::new(matrix),
    )
}

/// Solve A·x = b from x = 0 with the given preconditioner M. The stopping rule
/// is measured in M's norm, so tolerances compare only between runs with the
/// same preconditioner.
///
/// # Errors
/// [`FemError::NotPositiveDefinite`] on a breakdown (pᵀAp ≤ 0, typically an
/// unconstrained model), [`FemError::NotConverged`] when the iteration budget
/// runs out, [`FemError::InvalidSettings`] for a non-positive tolerance or
/// budget.
pub fn solve_pcg_with(
    matrix: &CsrMatrix,
    rhs: &[f64],
    settings: CgSettings,
    precondition: &mut dyn Preconditioner,
) -> Result<(Vec<f64>, CgOutcome), FemError> {
    if !(settings.relative_tolerance.is_finite() && settings.relative_tolerance > 0.0) {
        return Err(FemError::InvalidSettings {
            reason: "the tolerance must be positive",
        });
    }
    if settings.max_iterations == 0 {
        return Err(FemError::InvalidSettings {
            reason: "the iteration budget must be positive",
        });
    }
    let size = matrix.rows();
    let mut solution = vec![0.0; size];
    let mut residual = rhs.to_vec();
    let mut preconditioned = vec![0.0; size];
    precondition.apply(&residual, &mut preconditioned);
    let mut direction = preconditioned.clone();
    let mut product = vec![0.0; size];
    let mut rho = dot(&residual, &preconditioned);
    let rho_initial = rho;
    if rho_initial == 0.0 {
        // No load and nothing prescribed: the solution is exactly zero.
        return Ok((
            solution,
            CgOutcome {
                iterations: 0,
                relative_residual: 0.0,
            },
        ));
    }
    let target = settings.relative_tolerance * settings.relative_tolerance * rho_initial;

    for iteration in 1..=settings.max_iterations {
        matrix.mul_vec(&direction, &mut product);
        let curvature = dot(&direction, &product);
        if curvature <= 0.0 || !curvature.is_finite() {
            return Err(FemError::NotPositiveDefinite { iteration });
        }
        let step = rho / curvature;
        for index in 0..size {
            solution[index] += step * direction[index];
            residual[index] -= step * product[index];
        }
        precondition.apply(&residual, &mut preconditioned);
        let rho_next = dot(&residual, &preconditioned);
        if rho_next <= target {
            return Ok((
                solution,
                CgOutcome {
                    iterations: iteration,
                    relative_residual: (rho_next / rho_initial).sqrt(),
                },
            ));
        }
        let beta = rho_next / rho;
        for index in 0..size {
            direction[index] = preconditioned[index] + beta * direction[index];
        }
        rho = rho_next;
    }
    Err(FemError::NotConverged {
        iterations: settings.max_iterations,
        relative_residual: (rho / rho_initial).sqrt(),
        target: settings.relative_tolerance,
    })
}

fn dot(lhs: &[f64], rhs: &[f64]) -> f64 {
    lhs.iter().zip(rhs).map(|(left, right)| left * right).sum()
}
