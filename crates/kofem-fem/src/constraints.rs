// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

use crate::error::FemError;
use crate::sparse::CsrMatrix;

/// Prescribed values for a set of DOFs (DOF 3·node + component).
#[derive(Debug, Clone)]
pub struct Dirichlet {
    value_of_dof: Vec<Option<f64>>,
}

impl Dirichlet {
    /// # Errors
    /// [`FemError`] when the arrays disagree in length, a DOF is out of range,
    /// a value is not finite, or one DOF is prescribed two different values.
    pub fn new(dof_count: usize, dofs: &[u32], values: &[f64]) -> Result<Self, FemError> {
        if dofs.len() != values.len() {
            return Err(FemError::ConstraintValueCount {
                dofs: dofs.len(),
                values: values.len(),
            });
        }
        let mut value_of_dof = vec![None; dof_count];
        for (&dof, &value) in dofs.iter().zip(values) {
            if !value.is_finite() {
                return Err(FemError::NonFinite {
                    what: "a prescribed displacement",
                    value,
                });
            }
            let slot = value_of_dof
                .get_mut(dof as usize)
                .ok_or(FemError::DofOutOfRange {
                    dof,
                    count: dof_count,
                })?;
            #[allow(
                clippy::float_cmp,
                reason = "a DOF prescribed twice is consistent only with the identical value"
            )]
            match *slot {
                Some(first) if first != value => {
                    return Err(FemError::ConflictingConstraint {
                        dof,
                        first,
                        second: value,
                    });
                }
                _ => *slot = Some(value),
            }
        }
        Ok(Self { value_of_dof })
    }

    #[must_use]
    pub fn value(&self, dof: usize) -> Option<f64> {
        self.value_of_dof[dof]
    }
}

/// Eliminate the prescribed DOFs symmetrically: move their known columns to
/// the right-hand side, then replace each prescribed row and column by the
/// identity so the solve returns the prescribed value. The matrix stays
/// symmetric positive definite, as CG needs.
pub fn apply_dirichlet(matrix: &mut CsrMatrix, rhs: &mut [f64], constraints: &Dirichlet) {
    let (row_start, columns, values, diagonal_at) = matrix.parts_mut();
    for row in 0..row_start.len() - 1 {
        let row_value = constraints.value(row);
        for index in row_start[row]..row_start[row + 1] {
            match (constraints.value(columns[index] as usize), row_value) {
                (Some(prescribed), None) => {
                    rhs[row] -= values[index] * prescribed;
                    values[index] = 0.0;
                }
                (Some(_) | None, Some(_)) => values[index] = 0.0,
                (None, None) => {}
            }
        }
        if let Some(prescribed) = row_value {
            values[diagonal_at[row]] = 1.0;
            rhs[row] = prescribed;
        }
    }
}
