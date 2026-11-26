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

    /// Every prescribed DOF with its value, in DOF order.
    pub fn prescribed(&self) -> impl Iterator<Item = (usize, f64)> + '_ {
        self.value_of_dof
            .iter()
            .enumerate()
            .filter_map(|(dof, value)| value.map(|value| (dof, value)))
    }

    /// The same prescribed DOFs, each with the value `value(dof, current)`
    /// gives for it.
    #[must_use]
    pub fn with_values(&self, mut value: impl FnMut(usize, f64) -> f64) -> Self {
        let value_of_dof = self
            .value_of_dof
            .iter()
            .enumerate()
            .map(|(dof, current)| current.map(|current| value(dof, current)))
            .collect();
        Self { value_of_dof }
    }
}

/// Eliminate the prescribed DOFs symmetrically: move their known columns to
/// the right-hand side, then replace each prescribed row and column by the
/// identity so the solve returns the prescribed value. The matrix stays
/// symmetric positive definite, as CG needs.
pub fn apply_dirichlet(matrix: &mut CsrMatrix, rhs: &mut [f64], constraints: &Dirichlet) {
    eliminate(matrix, rhs, constraints, |_, _| {});
}

/// What [`eliminate_dirichlet`] overwrote: every entry in a prescribed row or
/// column, by its position in the matrix and its assembled value. The
/// prescribed DOFs are a small share of a model, so this is far smaller than
/// the matrix.
#[derive(Debug, Clone, Default)]
pub struct EliminatedEntries {
    positions: Vec<usize>,
    assembled: Vec<f64>,
}

impl EliminatedEntries {
    /// Entries kept.
    #[must_use]
    pub fn len(&self) -> usize {
        self.positions.len()
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.positions.is_empty()
    }

    /// Put the assembled values back into `matrix`, the matrix they were
    /// taken from: it is then exactly the assembled matrix again.
    pub fn restore(&self, matrix: &mut CsrMatrix) {
        let values = matrix.values_mut();
        for (&position, &assembled) in self.positions.iter().zip(&self.assembled) {
            values[position] = assembled;
        }
    }
}

/// [`apply_dirichlet`], keeping what it overwrites, so that the assembled
/// matrix can be restored afterwards ([`EliminatedEntries::restore`]) without
/// keeping a copy of it.
pub fn eliminate_dirichlet(
    matrix: &mut CsrMatrix,
    rhs: &mut [f64],
    constraints: &Dirichlet,
) -> EliminatedEntries {
    let mut kept = EliminatedEntries::default();
    eliminate(matrix, rhs, constraints, |position, assembled| {
        kept.positions.push(position);
        kept.assembled.push(assembled);
    });
    kept
}

/// The elimination, telling `overwritten` each changed entry's position and
/// assembled value.
fn eliminate(
    matrix: &mut CsrMatrix,
    rhs: &mut [f64],
    constraints: &Dirichlet,
    mut overwritten: impl FnMut(usize, f64),
) {
    let (row_start, columns, values, diagonal_at) = matrix.parts_mut();
    for row in 0..row_start.len() - 1 {
        let row_value = constraints.value(row);
        for index in row_start[row]..row_start[row + 1] {
            let assembled = values[index];
            match (constraints.value(columns[index] as usize), row_value) {
                (Some(prescribed), None) => {
                    rhs[row] -= assembled * prescribed;
                    values[index] = 0.0;
                }
                (Some(_) | None, Some(_)) => {
                    values[index] = if index == diagonal_at[row] { 1.0 } else { 0.0 };
                }
                (None, None) => continue,
            }
            overwritten(index, assembled);
        }
        if let Some(prescribed) = row_value {
            rhs[row] = prescribed;
        }
    }
}
