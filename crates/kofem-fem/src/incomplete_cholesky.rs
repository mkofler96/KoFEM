// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Incomplete Cholesky with zero fill, IC(0): A ≈ L·Lᵀ with L restricted to
//! the sparsity of A's lower triangle. The C++ engine's shell and coupled
//! solves precondition with it (`sparse_cg.cpp`); it roughly halves the
//! iteration count of symmetric Gauss–Seidel on those systems.
//!
//! Elasticity matrices are positive definite without being M-matrices, so
//! plain IC(0) can meet a non-positive pivot. The standard remedy is used:
//! factor A + α·diag(A) instead (Manteuffel 1980), raising α until the
//! factorisation completes.

use crate::amg::Preconditioner;
use crate::sparse::CsrMatrix;

/// Diagonal shifts α tried in order: 0, then 1e-3·4ᵏ up to 0.256 — the C++
/// engine's sequence.
const SHIFTS: [f64; 6] = [0.0, 1e-3, 4e-3, 1.6e-2, 6.4e-2, 0.256];

pub struct IncompleteCholesky {
    matrix: CsrMatrix,
    /// Strict-lower entries of L, at the positions of A's entries (the other
    /// positions are unused).
    lower: Vec<f64>,
    diagonal: Vec<f64>,
    shift: f64,
}

impl IncompleteCholesky {
    /// Factor `matrix`, which must be symmetric with sorted rows.
    ///
    /// # Errors
    /// Gives the matrix back when every shift meets a non-positive pivot; the
    /// caller then falls back to another preconditioner.
    pub fn new(matrix: CsrMatrix) -> Result<Self, CsrMatrix> {
        let rows = matrix.rows();
        let mut lower = vec![0.0; matrix.nnz()];
        let mut diagonal = vec![0.0; rows];
        for shift in SHIFTS {
            if factor(&matrix, shift, &mut lower, &mut diagonal) {
                return Ok(Self {
                    matrix,
                    lower,
                    diagonal,
                    shift,
                });
            }
        }
        Err(matrix)
    }

    /// The diagonal shift α the factorisation needed (0 for plain IC(0)).
    #[must_use]
    pub fn shift(&self) -> f64 {
        self.shift
    }
}

/// Row-by-row IC(0) of A + shift·diag(A). Returns false on a non-positive
/// pivot.
fn factor(matrix: &CsrMatrix, shift: f64, lower: &mut [f64], diagonal: &mut [f64]) -> bool {
    let columns = matrix.columns();
    let values = matrix.values();
    for row in 0..matrix.rows() {
        let start = matrix.row_range(row).start;
        let row_diagonal = matrix.diagonal_position(row);
        // L(i,j) = (A(i,j) − Σ_{m<j} L(i,m)·L(j,m)) / L(j,j), the sum taken
        // over the columns rows i and j share (both are sorted).
        let mut diagonal_sum = 0.0;
        for position in start..row_diagonal {
            let column = columns[position] as usize;
            let mut sum = values[position];
            let (mut own, mut other) = (start, matrix.row_range(column).start);
            let other_end = matrix.diagonal_position(column);
            while own < position && other < other_end {
                match columns[own].cmp(&columns[other]) {
                    std::cmp::Ordering::Less => own += 1,
                    std::cmp::Ordering::Greater => other += 1,
                    std::cmp::Ordering::Equal => {
                        sum -= lower[own] * lower[other];
                        own += 1;
                        other += 1;
                    }
                }
            }
            lower[position] = sum / diagonal[column];
            diagonal_sum += lower[position] * lower[position];
        }
        let pivot = values[row_diagonal] * (1.0 + shift) - diagonal_sum;
        // A NaN pivot fails too.
        if pivot.partial_cmp(&0.0) != Some(std::cmp::Ordering::Greater) {
            return false;
        }
        diagonal[row] = pivot.sqrt();
    }
    true
}

impl Preconditioner for IncompleteCholesky {
    fn matrix(&self) -> &CsrMatrix {
        &self.matrix
    }

    /// z = (L·Lᵀ)⁻¹ r: forward solve L·y = r, backward solve Lᵀ·z = y.
    fn apply(&mut self, residual: &[f64], out: &mut [f64]) {
        let columns = self.matrix.columns();
        let rows = self.matrix.rows();
        for row in 0..rows {
            let start = self.matrix.row_range(row).start;
            let mut sum = residual[row];
            for position in start..self.matrix.diagonal_position(row) {
                sum -= self.lower[position] * out[columns[position] as usize];
            }
            out[row] = sum / self.diagonal[row];
        }
        for row in (0..rows).rev() {
            out[row] /= self.diagonal[row];
            // Column `row` of Lᵀ is row `row` of L, stored by row, so the
            // update is pushed to the rows above rather than gathered.
            let solved = out[row];
            let start = self.matrix.row_range(row).start;
            for position in start..self.matrix.diagonal_position(row) {
                out[columns[position] as usize] -= self.lower[position] * solved;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The 1-D Laplacian with a stiffened first row: tridiagonal, so IC(0)
    /// drops no fill and is the exact Cholesky factor.
    fn tridiagonal(size: usize) -> CsrMatrix {
        let neighbours: Vec<Vec<u32>> = (0..size)
            .map(|node| {
                let node = u32::try_from(node).expect("small test size");
                let first = node.saturating_sub(1);
                let last = (node + 1).min(u32::try_from(size - 1).expect("small"));
                (first..=last).collect()
            })
            .collect();
        let mut matrix = CsrMatrix::from_node_blocks(&neighbours, 1);
        for row in 0..size {
            for position in matrix.row_range(row) {
                let column = matrix.columns()[position] as usize;
                let value = if column == row {
                    if row == 0 {
                        3.0
                    } else {
                        2.0
                    }
                } else {
                    -1.0
                };
                matrix.values_mut()[position] = value;
            }
        }
        matrix
    }

    #[test]
    fn factor_of_a_tridiagonal_matrix_is_exact() {
        let matrix = tridiagonal(12);
        let expected: Vec<f64> = (0..12).map(|i| f64::from(i) * 0.5 - 1.0).collect();
        let mut rhs = vec![0.0; 12];
        matrix.mul_vec(&expected, &mut rhs);
        let mut factored = IncompleteCholesky::new(matrix).expect("SPD factors");
        assert_eq!(factored.shift().to_bits(), 0.0_f64.to_bits());
        let mut solved = vec![0.0; 12];
        factored.apply(&rhs, &mut solved);
        for (got, want) in solved.iter().zip(&expected) {
            assert!((got - want).abs() < 1e-12, "{got} vs {want}");
        }
    }

    #[test]
    fn an_indefinite_matrix_is_given_back() {
        let mut matrix = tridiagonal(4);
        for row in 0..4 {
            let diagonal = matrix.diagonal_position(row);
            matrix.values_mut()[diagonal] = -1.0;
        }
        assert!(IncompleteCholesky::new(matrix).is_err());
    }
}
