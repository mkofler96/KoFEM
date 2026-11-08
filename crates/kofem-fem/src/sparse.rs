// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-FileCopyrightText: 2010-2024 Lawrence Livermore National Security, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later AND BSD-3-Clause

//! Compressed sparse row matrix with a node-block pattern: DOF 3·n + c is
//! component c of node n, and every pair of nodes that shares an element
//! couples all nine of its component pairs.
//!
//! MFEM reference for the symmetric Gauss-Seidel preconditioner:
//! `SparseMatrix::Gauss_Seidel_forw` and `Gauss_Seidel_back` in
//! `linalg/sparsemat.cpp` (MFEM v4.7).
//! MFEM copyright (c) 2010-2024, Lawrence Livermore National Security, LLC.
//! All rights reserved. See `../NOTICE.md` and `../LICENSE-MFEM` (BSD-3-Clause).

/// Square CSR matrix. Column indices are sorted within each row, and every row
/// stores its diagonal.
#[derive(Debug, Clone)]
pub struct CsrMatrix {
    row_start: Vec<usize>,
    columns: Vec<u32>,
    values: Vec<f64>,
    diagonal_at: Vec<usize>,
}

impl CsrMatrix {
    /// Zero matrix with the pattern of `node_neighbours` (sorted, including the
    /// node itself) expanded to 3×3 component blocks.
    #[must_use]
    pub fn from_node_pattern(node_neighbours: &[Vec<u32>]) -> Self {
        let rows = 3 * node_neighbours.len();
        let mut row_start = Vec::with_capacity(rows + 1);
        let mut nnz = 0;
        row_start.push(nnz);
        for neighbours in node_neighbours {
            for _component in 0..3 {
                nnz += 3 * neighbours.len();
                row_start.push(nnz);
            }
        }
        let mut columns = Vec::with_capacity(nnz);
        let mut diagonal_at = Vec::with_capacity(rows);
        for (node, neighbours) in node_neighbours.iter().enumerate() {
            for component in 0..3 {
                let row = 3 * node + component;
                for &other in neighbours {
                    for other_component in 0..3 {
                        let column = 3 * other as usize + other_component;
                        if column == row {
                            diagonal_at.push(columns.len());
                        }
                        #[allow(
                            clippy::cast_possible_truncation,
                            reason = "TetMesh::new caps the vertex count at MAX_VERTICES, so every DOF fits in u32"
                        )]
                        columns.push(column as u32);
                    }
                }
            }
        }
        Self {
            row_start,
            columns,
            values: vec![0.0; nnz],
            diagonal_at,
        }
    }

    #[must_use]
    pub fn rows(&self) -> usize {
        self.row_start.len() - 1
    }

    #[must_use]
    pub fn nnz(&self) -> usize {
        self.values.len()
    }

    /// Index range of row `row` in `columns()` / `values()`.
    #[must_use]
    pub fn row_range(&self, row: usize) -> std::ops::Range<usize> {
        self.row_start[row]..self.row_start[row + 1]
    }

    #[must_use]
    pub fn columns(&self) -> &[u32] {
        &self.columns
    }

    #[must_use]
    pub fn values(&self) -> &[f64] {
        &self.values
    }

    pub fn values_mut(&mut self) -> &mut [f64] {
        &mut self.values
    }

    #[must_use]
    pub fn diagonal(&self, row: usize) -> f64 {
        self.values[self.diagonal_at[row]]
    }

    /// Pattern and values at once, for in-place edits that read the pattern:
    /// (row starts, columns, values, diagonal positions).
    pub(crate) fn parts_mut(&mut self) -> (&[usize], &[u32], &mut [f64], &[usize]) {
        (
            &self.row_start,
            &self.columns,
            &mut self.values,
            &self.diagonal_at,
        )
    }

    /// Position of entry (row, column), when it is in the pattern.
    #[must_use]
    pub fn find(&self, row: usize, column: usize) -> Option<usize> {
        let range = self.row_range(row);
        let target = u32::try_from(column).ok()?;
        self.columns[range.clone()]
            .binary_search(&target)
            .ok()
            .map(|offset| range.start + offset)
    }

    /// y = A·x.
    pub fn mul_vec(&self, input: &[f64], output: &mut [f64]) {
        for (row, out) in output.iter_mut().enumerate() {
            let range = self.row_range(row);
            *out = self.columns[range.clone()]
                .iter()
                .zip(&self.values[range])
                .map(|(&column, &value)| value * input[column as usize])
                .sum();
        }
    }

    /// One symmetric Gauss–Seidel sweep (forward, then backward) on A·z = r
    /// from z = 0. As a preconditioner this is M = (D+L)·D⁻¹·(D+U), which is
    /// symmetric positive definite whenever A is.
    pub fn symmetric_gauss_seidel(&self, rhs: &[f64], out: &mut [f64]) {
        out.fill(0.0);
        for row in 0..self.rows() {
            out[row] = self.relaxed(row, rhs, out);
        }
        for row in (0..self.rows()).rev() {
            out[row] = self.relaxed(row, rhs, out);
        }
    }

    fn relaxed(&self, row: usize, rhs: &[f64], current: &[f64]) -> f64 {
        // Columns are sorted, so the off-diagonal entries are the two runs on
        // either side of the diagonal — no per-entry branch in the hot loop.
        let range = self.row_range(row);
        let diagonal_at = self.diagonal_at[row];
        let off_diagonal = |span: std::ops::Range<usize>| -> f64 {
            self.columns[span.clone()]
                .iter()
                .zip(&self.values[span])
                .map(|(&column, &value)| value * current[column as usize])
                .sum()
        };
        let below = off_diagonal(range.start..diagonal_at);
        let above = off_diagonal(diagonal_at + 1..range.end);
        (rhs[row] - below - above) / self.values[diagonal_at]
    }
}
