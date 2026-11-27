// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Nonlinear solid solves. A [`NonlinearProblem`] gives its internal force and
//! tangent at a displacement; [`NewtonRun`] finds the displacement where the
//! internal force balances the load, over load increments, in steps the
//! caller drives. Each Newton correction is one linear solve behind the
//! [`TangentSolver`] seam; [`DirichletCg`] is the solid solve's elimination,
//! preconditioner and CG.
//!
//! Elements and materials contribute their share of force and tangent;
//! linear elasticity, [`LinearElastic`], is the first. Contact enters as
//! constraints of the correction solve ([`crate::contact::ContactCg`]).

mod newton;
mod tangent;

pub use newton::{
    solve_newton, IncrementReport, NewtonRun, NewtonSettings, NewtonSolution, NewtonStatus,
};
pub use tangent::{DirichletCg, Settled, SolveProgress, TangentSolver};

use crate::error::FemError;
use crate::sparse::CsrMatrix;

/// A solid whose internal force depends on its displacement, possibly
/// nonlinearly. DOFs are numbered as in [`crate::TetMesh`]: 3·node + component.
pub trait NonlinearProblem {
    /// A zero matrix with the tangent's sparsity pattern, which stays fixed
    /// for the whole solve. Its row count is the problem's DOF count.
    fn tangent_pattern(&self) -> CsrMatrix;

    /// The internal force at `displacements`, with the tangent (its
    /// derivative) added into `tangent`, which arrives zeroed and with the
    /// pattern [`NonlinearProblem::tangent_pattern`] gave.
    ///
    /// # Errors
    /// Whatever makes the state invalid for the problem, such as an inverted
    /// element.
    fn internal_force_and_tangent(
        &mut self,
        displacements: &[f64],
        tangent: &mut CsrMatrix,
    ) -> Result<Vec<f64>, FemError>;
}

/// Small-strain linear elasticity: internal force K·u, tangent K.
pub struct LinearElastic {
    stiffness: CsrMatrix,
}

impl LinearElastic {
    /// `stiffness` as [`crate::assemble_stiffness`] builds it.
    #[must_use]
    pub fn new(stiffness: CsrMatrix) -> Self {
        Self { stiffness }
    }
}

impl NonlinearProblem for LinearElastic {
    fn tangent_pattern(&self) -> CsrMatrix {
        let mut pattern = self.stiffness.clone();
        pattern.values_mut().fill(0.0);
        pattern
    }

    fn internal_force_and_tangent(
        &mut self,
        displacements: &[f64],
        tangent: &mut CsrMatrix,
    ) -> Result<Vec<f64>, FemError> {
        let count = self.stiffness.rows();
        if displacements.len() != count {
            return Err(FemError::DisplacementLength {
                len: displacements.len(),
                count,
            });
        }
        if tangent.rows() != count || tangent.nnz() != self.stiffness.nnz() {
            return Err(FemError::NonlinearInput {
                reason: format!(
                    "the tangent has {} rows and {} entries, but the stiffness {count} rows and {} \
                     entries",
                    tangent.rows(),
                    tangent.nnz(),
                    self.stiffness.nnz()
                ),
            });
        }
        tangent
            .values_mut()
            .copy_from_slice(self.stiffness.values());
        let mut force = vec![0.0; count];
        self.stiffness.mul_vec(displacements, &mut force);
        Ok(force)
    }
}
