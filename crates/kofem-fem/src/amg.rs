// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Smoothed-aggregation algebraic multigrid (SA-AMG) for 3D linear elasticity,
//! used as a conjugate-gradient preconditioner.
//!
//! Method: Vaněk, Mandel & Brezina, "Algebraic multigrid by smoothed
//! aggregation for second and fourth order elliptic problems", Computing 56
//! (1996). Each level
//!
//! 1. groups nodes into aggregates over the graph of strong node couplings,
//! 2. builds a tentative prolongator that reproduces the near-null space (the
//!    six rigid-body modes) exactly on every aggregate, by a local QR,
//! 3. smooths it with one damped-Jacobi step, P = (I − ω·D⁻¹·A)·P₀, and
//! 4. forms the coarse matrix by the Galerkin product `A_c = Pᵀ·A·P`.
//!
//! The coarsest level is solved by dense Cholesky. One V-cycle with a forward
//! Gauss–Seidel sweep before and a backward sweep after the coarse correction
//! is a symmetric positive-definite preconditioner, as CG requires.

use crate::error::FemError;
use crate::sparse::CsrMatrix;

/// Rigid-body modes in 3D: three translations, three rotations.
const MODES: usize = 6;

/// Tunables of the hierarchy. [`AmgSettings::default`] suits linear-tet
/// elasticity meshes from Netgen.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct AmgSettings {
    /// A node pair couples strongly when `‖A_ij‖ > θ·√(‖A_ii‖·‖A_jj‖)`
    /// (Frobenius norms of the node blocks). 0 makes every coupling strong.
    pub strength_threshold: f64,
    /// Stop coarsening once a level has at most this many unknowns.
    pub coarse_size: usize,
    pub max_levels: usize,
}

impl Default for AmgSettings {
    fn default() -> Self {
        Self {
            // Measured on the KOF-300 sweep: 0.02 halves the iterations on
            // new_bracket_2 against 0 for ~4 % more operator complexity;
            // 0.05 helps little more and inflates the thin-walled crane
            // holder's hierarchy to 2.25× the matrix.
            strength_threshold: 0.02,
            coarse_size: 600,
            max_levels: 10,
        }
    }
}

/// Size of one level of the hierarchy, for logging and tests.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LevelInfo {
    pub unknowns: usize,
    pub nonzeros: usize,
}

/// A system matrix A together with a preconditioner for it: z ≈ A⁻¹·r. The
/// preconditioner must be symmetric positive definite. Each owns its matrix,
/// so a CG run can be paused and resumed (from JS) without borrowing.
pub trait Preconditioner {
    fn matrix(&self) -> &CsrMatrix;
    fn apply(&mut self, residual: &[f64], out: &mut [f64]);
}

/// One symmetric Gauss–Seidel sweep, the engine's (MFEM `GSSmoother`) choice.
pub struct SymmetricGaussSeidel {
    matrix: CsrMatrix,
}

impl SymmetricGaussSeidel {
    #[must_use]
    pub fn new(matrix: CsrMatrix) -> Self {
        Self { matrix }
    }
}

impl Preconditioner for SymmetricGaussSeidel {
    fn matrix(&self) -> &CsrMatrix {
        &self.matrix
    }

    fn apply(&mut self, residual: &[f64], out: &mut [f64]) {
        self.matrix.symmetric_gauss_seidel(residual, out);
    }
}

// ── Sparse kernels shared by the fine matrix and the coarse levels ────────────

/// Row access to a CSR matrix with sorted columns.
trait Rows {
    fn row_count(&self) -> usize;
    fn row(&self, row: usize) -> (&[u32], &[f64]);
}

impl Rows for CsrMatrix {
    fn row_count(&self) -> usize {
        self.rows()
    }
    fn row(&self, row: usize) -> (&[u32], &[f64]) {
        let range = self.row_range(row);
        (&self.columns()[range.clone()], &self.values()[range])
    }
}

/// Plain CSR matrix for prolongators and coarse levels; columns sorted per row.
#[derive(Debug, Clone, Default)]
struct Csr {
    row_start: Vec<usize>,
    columns: Vec<u32>,
    values: Vec<f64>,
    column_count: usize,
}

impl Rows for Csr {
    fn row_count(&self) -> usize {
        self.row_start.len() - 1
    }
    fn row(&self, row: usize) -> (&[u32], &[f64]) {
        let range = self.row_start[row]..self.row_start[row + 1];
        (&self.columns[range.clone()], &self.values[range])
    }
}

impl Csr {
    fn nnz(&self) -> usize {
        self.values.len()
    }

    /// Pᵀ, with sorted columns (rows are visited in order).
    fn transpose(&self) -> Csr {
        let mut row_start = vec![0usize; self.column_count + 1];
        for &column in &self.columns {
            row_start[column as usize + 1] += 1;
        }
        for index in 0..self.column_count {
            row_start[index + 1] += row_start[index];
        }
        let mut next = row_start.clone();
        let mut columns = vec![0u32; self.nnz()];
        let mut values = vec![0.0; self.nnz()];
        for row in 0..self.row_count() {
            let (cols, vals) = self.row(row);
            for (&column, &value) in cols.iter().zip(vals) {
                let slot = &mut next[column as usize];
                columns[*slot] = to_u32(row);
                values[*slot] = value;
                *slot += 1;
            }
        }
        Csr {
            row_start,
            columns,
            values,
            column_count: self.row_count(),
        }
    }
}

/// Build a `rows × width` matrix whose row `row` is what `fill` accumulates.
/// `fill` runs twice: once to count each row's entries, once to write them
/// into buffers of exactly the final size. On the large finest level this
/// avoids the transient 1.5–3× overshoot of growing vectors by doubling,
/// which dominated peak memory, for roughly twice the (small) setup work.
fn build_rows(rows: usize, width: usize, mut fill: impl FnMut(usize, &mut RowAccumulator)) -> Csr {
    let mut accumulator = RowAccumulator::new(width);
    let mut row_start = Vec::with_capacity(rows + 1);
    row_start.push(0);
    for row in 0..rows {
        fill(row, &mut accumulator);
        let count = accumulator.count_and_clear();
        row_start.push(row_start[row] + count);
    }
    let mut out = Csr {
        row_start: vec![0],
        columns: Vec::with_capacity(row_start[rows]),
        values: Vec::with_capacity(row_start[rows]),
        column_count: width,
    };
    out.row_start.reserve_exact(rows);
    for row in 0..rows {
        fill(row, &mut accumulator);
        accumulator.flush_into(&mut out);
    }
    out
}

/// Dense accumulator for building one sparse row at a time (Gustavson).
struct RowAccumulator {
    value: Vec<f64>,
    seen: Vec<bool>,
    touched: Vec<u32>,
}

impl RowAccumulator {
    fn new(width: usize) -> Self {
        Self {
            value: vec![0.0; width],
            seen: vec![false; width],
            touched: Vec::new(),
        }
    }

    fn add(&mut self, column: u32, amount: f64) {
        let index = column as usize;
        if !self.seen[index] {
            self.seen[index] = true;
            self.touched.push(column);
        }
        self.value[index] += amount;
    }

    /// Hand every accumulated entry to `visit` (in no particular order) and reset.
    fn drain(&mut self, mut visit: impl FnMut(u32, f64)) {
        for &column in &self.touched {
            let index = column as usize;
            visit(column, self.value[index]);
            self.value[index] = 0.0;
            self.seen[index] = false;
        }
        self.touched.clear();
    }

    /// Number of accumulated entries; resets without producing a row.
    fn count_and_clear(&mut self) -> usize {
        let count = self.touched.len();
        self.drain(|_, _| {});
        count
    }

    /// Append the accumulated row (sorted) to `out` and reset.
    fn flush_into(&mut self, out: &mut Csr) {
        self.touched.sort_unstable();
        for &column in &self.touched {
            let index = column as usize;
            out.columns.push(column);
            out.values.push(self.value[index]);
            self.value[index] = 0.0;
            self.seen[index] = false;
        }
        self.touched.clear();
        out.row_start.push(out.values.len());
    }
}

fn mul_vec(matrix: &(impl Rows + ?Sized), input: &[f64], output: &mut [f64]) {
    for (row, out) in output.iter_mut().enumerate() {
        let (cols, vals) = matrix.row(row);
        *out = cols
            .iter()
            .zip(vals)
            .map(|(&column, &value)| value * input[column as usize])
            .sum();
    }
}

/// One Gauss–Seidel relaxation of row `row` in place.
fn relax(
    matrix: &(impl Rows + ?Sized),
    inverse_diagonal: &[f64],
    row: usize,
    rhs: &[f64],
    solution: &mut [f64],
) {
    let (cols, vals) = matrix.row(row);
    let product: f64 = cols
        .iter()
        .zip(vals)
        .map(|(&column, &value)| value * solution[column as usize])
        .sum();
    solution[row] += (rhs[row] - product) * inverse_diagonal[row];
}

fn diagonal_of(matrix: &(impl Rows + ?Sized)) -> Vec<f64> {
    (0..matrix.row_count())
        .map(|row| {
            let (cols, vals) = matrix.row(row);
            cols.binary_search(&to_u32(row))
                .map_or(0.0, |offset| vals[offset])
        })
        .collect()
}

/// D⁻¹, taking 1 where a row has no (or a zero) diagonal.
fn inverse_diagonal_of(matrix: &(impl Rows + ?Sized)) -> Vec<f64> {
    diagonal_of(matrix)
        .into_iter()
        .map(|value| if value == 0.0 { 1.0 } else { 1.0 / value })
        .collect()
}

#[allow(
    clippy::cast_possible_truncation,
    reason = "every index here is a DOF or aggregate number, bounded by the fine DOF count, \
              which TetMesh::new caps to fit u32"
)]
fn to_u32(index: usize) -> u32 {
    index as u32
}

// ── Setup ─────────────────────────────────────────────────────────────────────

/// Couplings of every node to the other nodes, as (node, `‖A_ij‖²`), keeping
/// only the strong ones. Nodes are `block` consecutive unknowns.
fn strong_couplings(
    matrix: &(impl Rows + ?Sized),
    block: usize,
    threshold: f64,
) -> Vec<Vec<(u32, f64)>> {
    let nodes = matrix.row_count() / block;
    let mut couplings: Vec<Vec<(u32, f64)>> = Vec::with_capacity(nodes);
    let mut diagonal = vec![0.0; nodes];
    let mut norm = vec![0.0f64; nodes];
    let mut seen = vec![false; nodes];
    let mut touched: Vec<u32> = Vec::new();
    for (node, own_norm) in diagonal.iter_mut().enumerate() {
        for row in block * node..block * (node + 1) {
            let (cols, vals) = matrix.row(row);
            for (&column, &value) in cols.iter().zip(vals) {
                let other = column as usize / block;
                if !seen[other] {
                    seen[other] = true;
                    touched.push(to_u32(other));
                }
                norm[other] += value * value;
            }
        }
        touched.sort_unstable();
        let mut list = Vec::with_capacity(touched.len());
        for &other in &touched {
            let index = other as usize;
            if index == node {
                *own_norm = norm[index];
            } else if norm[index] > 0.0 {
                list.push((other, norm[index]));
            }
            norm[index] = 0.0;
            seen[index] = false;
        }
        touched.clear();
        couplings.push(list);
    }
    // ‖A_ij‖ > θ·√(‖A_ii‖·‖A_jj‖) in squared norms: n_ij > θ²·√(d_i·d_j).
    let factor = threshold * threshold;
    for (node, list) in couplings.iter_mut().enumerate() {
        list.retain(|&(other, strength)| {
            strength > factor * (diagonal[node] * diagonal[other as usize]).sqrt()
        });
    }
    couplings
}

/// Group nodes into aggregates (Vaněk et al., three phases). A node whose
/// unknowns are all `dead` (constrained, or without coarse content) joins no
/// aggregate. Returns the aggregate of every node and the aggregate count.
fn aggregate(couplings: &[Vec<(u32, f64)>], excluded: &[bool]) -> (Vec<Option<u32>>, usize) {
    let nodes = couplings.len();
    let mut owner: Vec<Option<u32>> = vec![None; nodes];
    let mut count = 0usize;
    // Phase 1: a node and all of its strong neighbours, if none is taken yet.
    for node in 0..nodes {
        if excluded[node] || owner[node].is_some() {
            continue;
        }
        let list = &couplings[node];
        if list.is_empty()
            || list
                .iter()
                .any(|&(other, _)| owner[other as usize].is_some())
        {
            continue;
        }
        let id = Some(to_u32(count));
        owner[node] = id;
        for &(other, _) in list {
            owner[other as usize] = id;
        }
        count += 1;
    }
    // Phase 2: attach leftovers to the aggregate of their strongest neighbour
    // from phase 1 (a snapshot, so aggregates do not grow chains).
    let snapshot = owner.clone();
    for node in 0..nodes {
        if excluded[node] || owner[node].is_some() {
            continue;
        }
        let strongest = couplings[node]
            .iter()
            .filter_map(|&(other, strength)| snapshot[other as usize].map(|id| (id, strength)))
            .max_by(|lhs, rhs| lhs.1.total_cmp(&rhs.1));
        if let Some((id, _)) = strongest {
            owner[node] = Some(id);
        }
    }
    // Phase 3: whatever is left forms aggregates with its free neighbours; a
    // node with no strong coupling at all becomes an aggregate of its own.
    for node in 0..nodes {
        if excluded[node] || owner[node].is_some() {
            continue;
        }
        let id = Some(to_u32(count));
        owner[node] = id;
        for &(other, _) in &couplings[node] {
            let index = other as usize;
            if !excluded[index] && owner[index].is_none() {
                owner[index] = id;
            }
        }
        count += 1;
    }
    (owner, count)
}

/// Tentative prolongator of one level: on every aggregate, an orthonormal
/// basis of the near-null space restricted to it (local modified Gram–Schmidt
/// QR, `B_agg = Q·R`). Q fills P₀'s columns, R becomes the coarse near-null
/// space. A mode that is linearly dependent on the aggregate (too few or
/// constrained unknowns) gives a zero column, reported as a dead coarse unknown.
struct Tentative {
    prolongator: Csr,
    coarse_modes: Vec<[f64; MODES]>,
    coarse_dead: Vec<bool>,
}

fn tentative_prolongator(
    owner: &[Option<u32>],
    aggregates: usize,
    block: usize,
    modes: &[[f64; MODES]],
) -> Tentative {
    let unknowns = modes.len();
    let mut members: Vec<Vec<usize>> = vec![Vec::new(); aggregates];
    for (node, id) in owner.iter().enumerate() {
        if let Some(id) = id {
            members[*id as usize].push(node);
        }
    }
    let mut basis = vec![[0.0; MODES]; unknowns];
    let mut coarse_modes = vec![[0.0; MODES]; aggregates * MODES];
    let mut coarse_dead = vec![false; aggregates * MODES];
    let mut rows: Vec<usize> = Vec::new();
    for (id, nodes) in members.iter().enumerate() {
        rows.clear();
        rows.extend(
            nodes
                .iter()
                .flat_map(|&node| block * node..block * (node + 1)),
        );
        let scale = (0..MODES)
            .map(|mode| column_norm(&rows, modes, mode))
            .fold(0.0, f64::max);
        let mut upper = [[0.0; MODES]; MODES];
        for mode in 0..MODES {
            for &row in &rows {
                basis[row][mode] = modes[row][mode];
            }
            for earlier in 0..mode {
                let projection: f64 = rows
                    .iter()
                    .map(|&row| basis[row][earlier] * basis[row][mode])
                    .sum();
                upper[earlier][mode] = projection;
                for &row in &rows {
                    basis[row][mode] -= projection * basis[row][earlier];
                }
            }
            let length = column_norm(&rows, &basis, mode);
            if length > 1e-8 * scale && length > 0.0 {
                upper[mode][mode] = length;
                for &row in &rows {
                    basis[row][mode] /= length;
                }
            } else {
                coarse_dead[id * MODES + mode] = true;
                for &row in &rows {
                    basis[row][mode] = 0.0;
                }
            }
        }
        for mode in 0..MODES {
            coarse_modes[id * MODES + mode] = upper[mode];
        }
    }
    let mut prolongator = Csr {
        row_start: Vec::with_capacity(unknowns + 1),
        column_count: aggregates * MODES,
        ..Csr::default()
    };
    prolongator.row_start.push(0);
    for (row, values) in basis.iter().enumerate() {
        if let Some(id) = owner[row / block] {
            for (mode, &value) in values.iter().enumerate() {
                if value != 0.0 {
                    prolongator.columns.push(to_u32(id as usize * MODES + mode));
                    prolongator.values.push(value);
                }
            }
        }
        prolongator.row_start.push(prolongator.values.len());
    }
    Tentative {
        prolongator,
        coarse_modes,
        coarse_dead,
    }
}

fn column_norm(rows: &[usize], matrix: &[[f64; MODES]], mode: usize) -> f64 {
    rows.iter()
        .map(|&row| matrix[row][mode] * matrix[row][mode])
        .sum::<f64>()
        .sqrt()
}

/// Largest eigenvalue of D⁻¹·A by power iteration, padded slightly: the
/// smoothing weight must not overshoot.
fn spectral_radius(matrix: &(impl Rows + ?Sized), inverse_diagonal: &[f64]) -> f64 {
    let size = matrix.row_count();
    // Deterministic, well-mixed start vector (a linear congruential sequence).
    let mut state: u64 = 0x9E37_79B9_7F4A_7C15;
    let mut vector: Vec<f64> = (0..size)
        .map(|_| {
            state = state
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1_442_695_040_888_963_407);
            #[allow(
                clippy::cast_precision_loss,
                reason = "only the bit pattern's spread matters for a start vector"
            )]
            let unit = (state >> 11) as f64 / (1u64 << 53) as f64;
            unit - 0.5
        })
        .collect();
    let mut product = vec![0.0; size];
    let mut estimate: f64 = 0.0;
    for _step in 0..15 {
        let length = norm(&vector);
        if length == 0.0 {
            break;
        }
        for value in &mut vector {
            *value /= length;
        }
        mul_vec(matrix, &vector, &mut product);
        for (value, scale) in product.iter_mut().zip(inverse_diagonal) {
            *value *= scale;
        }
        estimate = estimate.max(norm(&product));
        std::mem::swap(&mut vector, &mut product);
    }
    1.05 * estimate
}

fn norm(vector: &[f64]) -> f64 {
    vector.iter().map(|value| value * value).sum::<f64>().sqrt()
}

/// P = (I − ω·D⁻¹·A)·P₀ with ω = 4 / (3·ρ(D⁻¹A)).
fn smooth_prolongator(
    matrix: &(impl Rows + ?Sized),
    inverse_diagonal: &[f64],
    tentative: &Csr,
) -> Csr {
    let omega = 4.0 / (3.0 * spectral_radius(matrix, inverse_diagonal));
    build_rows(
        matrix.row_count(),
        tentative.column_count,
        |row, accumulator| {
            let (tent_cols, tent_vals) = tentative.row(row);
            for (&column, &value) in tent_cols.iter().zip(tent_vals) {
                accumulator.add(column, value);
            }
            let weight = -omega * inverse_diagonal[row];
            let (cols, vals) = matrix.row(row);
            for (&middle, &entry) in cols.iter().zip(vals) {
                let (p_cols, p_vals) = tentative.row(middle as usize);
                for (&column, &value) in p_cols.iter().zip(p_vals) {
                    accumulator.add(column, weight * entry * value);
                }
            }
        },
    )
}

/// `A_c = Pᵀ·A·P`, one coarse row at a time: row I is (Σᵢ P(i,I)·A(i,:))·P,
/// summed over the fine rows i that P's column I touches. Building rows
/// directly never materialises A·P, which on the finest level holds several
/// times the entries of A and dominated peak memory.
///
/// Coarse unknowns with no fine content (zero columns of P) get a unit
/// diagonal so the coarse matrix stays positive definite; their right-hand
/// side is always zero, so they never pollute the correction.
fn galerkin(matrix: &(impl Rows + ?Sized), prolongator: &Csr, dead: &[bool]) -> Csr {
    let transpose = prolongator.transpose();
    let mut fine_row = RowAccumulator::new(matrix.row_count());
    build_rows(
        prolongator.column_count,
        prolongator.column_count,
        |coarse, coarse_row| {
            if dead[coarse] {
                coarse_row.add(to_u32(coarse), 1.0);
                return;
            }
            let (fine_rows, weights) = transpose.row(coarse);
            for (&fine, &weight) in fine_rows.iter().zip(weights) {
                let (cols, vals) = matrix.row(fine as usize);
                for (&column, &value) in cols.iter().zip(vals) {
                    fine_row.add(column, weight * value);
                }
            }
            fine_row.drain(|fine, value| {
                let (cols, vals) = prolongator.row(fine as usize);
                for (&column, &entry) in cols.iter().zip(vals) {
                    coarse_row.add(column, value * entry);
                }
            });
        },
    )
}

/// Largest coarsest level that is factored densely: the factor holds n²
/// doubles (32 MB here). Coarsening normally stops near `coarse_size`, far
/// below this, but it can stop early — on a fully constrained model nothing is
/// left to aggregate, so the "coarsest" level is the whole fine matrix.
const DENSE_LIMIT: usize = 2000;

/// Symmetric Gauss–Seidel sweep pairs on a coarsest level too large to factor.
const COARSE_SWEEPS: usize = 4;

/// How the coarsest level is solved.
enum CoarseSolve {
    /// Exactly, by dense Cholesky.
    Direct(DenseCholesky),
    /// Approximately, by `COARSE_SWEEPS` symmetric Gauss–Seidel sweep pairs
    /// from zero: a symmetric positive-definite operator, so the V-cycle
    /// stays a valid CG preconditioner. Exact where the level is diagonal
    /// (the identity rows of a fully constrained model).
    Relax { inverse_diagonal: Vec<f64> },
}

/// Dense Cholesky factor L (row-major lower triangle) of the coarsest matrix.
struct DenseCholesky {
    size: usize,
    lower: Vec<f64>,
}

impl DenseCholesky {
    fn factor(matrix: &(impl Rows + ?Sized)) -> Result<Self, FemError> {
        let size = matrix.row_count();
        let mut lower = vec![0.0; size * size];
        for row in 0..size {
            let (cols, vals) = matrix.row(row);
            for (&column, &value) in cols.iter().zip(vals) {
                if (column as usize) <= row {
                    lower[row * size + column as usize] = value;
                }
            }
        }
        for column in 0..size {
            let pivot_original = lower[column * size + column];
            let mut pivot = pivot_original;
            for inner in 0..column {
                pivot -= lower[column * size + inner] * lower[column * size + inner];
            }
            if pivot <= 1e-14 * pivot_original.abs() || !pivot.is_finite() {
                return Err(FemError::CoarseNotPositiveDefinite { unknowns: size });
            }
            let diagonal = pivot.sqrt();
            lower[column * size + column] = diagonal;
            for row in column + 1..size {
                let mut value = lower[row * size + column];
                for inner in 0..column {
                    value -= lower[row * size + inner] * lower[column * size + inner];
                }
                lower[row * size + column] = value / diagonal;
            }
        }
        Ok(Self { size, lower })
    }

    fn solve(&self, rhs: &[f64], out: &mut [f64]) {
        let size = self.size;
        for row in 0..size {
            let factor_row = &self.lower[row * size..row * size + row];
            let known: f64 = factor_row
                .iter()
                .zip(&out[..row])
                .map(|(factor, value)| factor * value)
                .sum();
            out[row] = (rhs[row] - known) / self.lower[row * size + row];
        }
        for row in (0..size).rev() {
            let known: f64 = (row + 1..size)
                .zip(&out[row + 1..])
                .map(|(inner, value)| self.lower[inner * size + row] * value)
                .sum();
            out[row] = (out[row] - known) / self.lower[row * size + row];
        }
    }
}

/// The six rigid-body modes at every node, centred on the centroid and scaled
/// by the RMS radius so that translations and rotations have similar size.
/// Rows of constrained unknowns are zero: the coarse space must not move them.
fn rigid_body_modes(coordinates: &[[f64; 3]], constrained: &[bool]) -> Vec<[f64; MODES]> {
    #[allow(clippy::cast_precision_loss, reason = "a node count is far below 2^52")]
    let count = coordinates.len().max(1) as f64;
    let mut centre = [0.0; 3];
    for point in coordinates {
        for axis in 0..3 {
            centre[axis] += point[axis] / count;
        }
    }
    let radius = (coordinates
        .iter()
        .map(|point| {
            (0..3)
                .map(|axis| (point[axis] - centre[axis]).powi(2))
                .sum::<f64>()
        })
        .sum::<f64>()
        / count)
        .sqrt();
    let scale = if radius > 0.0 { 1.0 / radius } else { 1.0 };
    let mut modes = vec![[0.0; MODES]; 3 * coordinates.len()];
    for (node, point) in coordinates.iter().enumerate() {
        let [px, py, pz] = [0, 1, 2].map(|axis| (point[axis] - centre[axis]) * scale);
        // Columns: translations x, y, z; rotations about x, y, z.
        modes[3 * node] = [1.0, 0.0, 0.0, 0.0, pz, -py];
        modes[3 * node + 1] = [0.0, 1.0, 0.0, -pz, 0.0, px];
        modes[3 * node + 2] = [0.0, 0.0, 1.0, py, -px, 0.0];
    }
    for (row, &fixed) in constrained.iter().enumerate() {
        if fixed {
            modes[row] = [0.0; MODES];
        }
    }
    modes
}

// ── Hierarchy and V-cycle ─────────────────────────────────────────────────────

struct Work {
    rhs: Vec<f64>,
    solution: Vec<f64>,
    scratch: Vec<f64>,
}

impl Work {
    fn new(size: usize) -> Self {
        Self {
            rhs: vec![0.0; size],
            solution: vec![0.0; size],
            scratch: vec![0.0; size],
        }
    }
}

/// SA-AMG V-cycle preconditioner for a linear-elastic stiffness matrix with
/// its Dirichlet conditions already eliminated (`apply_dirichlet`).
pub struct SmoothedAggregation {
    fine: CsrMatrix,
    /// `A₁ … A_L`; the last one is the coarsest (see `CoarseSolve`).
    coarse: Vec<Csr>,
    /// D⁻¹ of A₀ … A_{L−1} (the smoothed levels).
    inverse_diagonals: Vec<Vec<f64>>,
    /// `P_k` maps level k+1 to level k.
    prolongators: Vec<Csr>,
    coarse_solve: CoarseSolve,
    work: Vec<Work>,
}

impl SmoothedAggregation {
    /// Build the hierarchy. `coordinates` holds one point per node (DOF
    /// 3·node + component); `constrained` marks the eliminated DOFs.
    ///
    /// # Errors
    /// [`FemError::AmgInput`] when the arrays do not match the matrix,
    /// [`FemError::CoarseNotPositiveDefinite`] when the coarsest matrix is
    /// singular (an under-constrained model).
    pub fn new(
        matrix: CsrMatrix,
        coordinates: &[[f64; 3]],
        constrained: &[bool],
        settings: AmgSettings,
    ) -> Result<Self, FemError> {
        if 3 * coordinates.len() != matrix.rows() {
            return Err(FemError::AmgInput {
                reason: "one coordinate triple per node is required",
            });
        }
        if constrained.len() != matrix.rows() {
            return Err(FemError::AmgInput {
                reason: "one constraint flag per unknown is required",
            });
        }
        let mut coarse: Vec<Csr> = Vec::new();
        let mut inverse_diagonals = Vec::new();
        let mut prolongators = Vec::new();
        let mut modes = rigid_body_modes(coordinates, constrained);
        let mut dead = constrained.to_vec();
        let mut block = 3;
        while prolongators.len() + 1 < settings.max_levels {
            let current: &dyn Rows = coarse.last().map_or(&matrix as &dyn Rows, |last| last);
            let size = current.row_count();
            if size <= settings.coarse_size {
                break;
            }
            let couplings = strong_couplings(current, block, settings.strength_threshold);
            let excluded: Vec<bool> = (0..size / block)
                .map(|node| {
                    dead[block * node..block * (node + 1)]
                        .iter()
                        .all(|&flag| flag)
                })
                .collect();
            let (owner, aggregates) = aggregate(&couplings, &excluded);
            if aggregates == 0 || aggregates * MODES >= size {
                break; // no longer coarsening
            }
            let tentative = tentative_prolongator(&owner, aggregates, block, &modes);
            let inverse_diagonal = inverse_diagonal_of(current);
            let prolongator =
                smooth_prolongator(current, &inverse_diagonal, &tentative.prolongator);
            let next = galerkin(current, &prolongator, &tentative.coarse_dead);
            inverse_diagonals.push(inverse_diagonal);
            prolongators.push(prolongator);
            coarse.push(next);
            modes = tentative.coarse_modes;
            dead = tentative.coarse_dead;
            block = MODES;
        }
        let coarsest: &dyn Rows = coarse.last().map_or(&matrix as &dyn Rows, |last| last);
        let coarse_solve = if coarsest.row_count() <= DENSE_LIMIT {
            CoarseSolve::Direct(DenseCholesky::factor(coarsest)?)
        } else {
            CoarseSolve::Relax {
                inverse_diagonal: inverse_diagonal_of(coarsest),
            }
        };
        let mut work = vec![Work::new(matrix.rows())];
        work.extend(coarse.iter().map(|level| Work::new(level.row_count())));
        Ok(Self {
            fine: matrix,
            coarse,
            inverse_diagonals,
            prolongators,
            coarse_solve,
            work,
        })
    }

    /// Unknowns and non-zeros per level, finest first.
    #[must_use]
    pub fn levels(&self) -> Vec<LevelInfo> {
        let mut levels = vec![LevelInfo {
            unknowns: self.fine.rows(),
            nonzeros: self.fine.nnz(),
        }];
        levels.extend(self.coarse.iter().map(|level| LevelInfo {
            unknowns: level.row_count(),
            nonzeros: level.nnz(),
        }));
        levels
    }

    /// Non-zeros of all levels over those of the fine matrix.
    #[must_use]
    pub fn operator_complexity(&self) -> f64 {
        let total: usize = self.levels().iter().map(|level| level.nonzeros).sum();
        #[allow(
            clippy::cast_precision_loss,
            reason = "a ratio of entry counts for reporting"
        )]
        let ratio = total as f64 / self.fine.nnz() as f64;
        ratio
    }

    fn level(&self, index: usize) -> &dyn Rows {
        if index == 0 {
            &self.fine
        } else {
            &self.coarse[index - 1]
        }
    }
}

impl Preconditioner for SmoothedAggregation {
    fn matrix(&self) -> &CsrMatrix {
        &self.fine
    }

    fn apply(&mut self, residual: &[f64], out: &mut [f64]) {
        let depth = self.prolongators.len();
        let mut work = std::mem::take(&mut self.work);
        work[0].rhs.copy_from_slice(residual);
        // Down: pre-smooth (forward Gauss–Seidel from zero), restrict the residual.
        for index in 0..depth {
            let matrix = self.level(index);
            let inverse_diagonal = &self.inverse_diagonals[index];
            let (upper, lower) = work.split_at_mut(index + 1);
            let here = &mut upper[index];
            here.solution.fill(0.0);
            for row in 0..matrix.row_count() {
                relax(matrix, inverse_diagonal, row, &here.rhs, &mut here.solution);
            }
            mul_vec(matrix, &here.solution, &mut here.scratch);
            for (scratch, rhs) in here.scratch.iter_mut().zip(&here.rhs) {
                *scratch = rhs - *scratch;
            }
            let below = &mut lower[0];
            below.rhs.fill(0.0);
            let prolongator = &self.prolongators[index];
            for row in 0..prolongator.row_count() {
                let (cols, vals) = prolongator.row(row);
                for (&column, &value) in cols.iter().zip(vals) {
                    below.rhs[column as usize] += value * here.scratch[row];
                }
            }
        }
        let bottom = &mut work[depth];
        match &self.coarse_solve {
            CoarseSolve::Direct(factor) => factor.solve(&bottom.rhs, &mut bottom.solution),
            CoarseSolve::Relax { inverse_diagonal } => {
                let matrix = self.level(depth);
                bottom.solution.fill(0.0);
                for _pair in 0..COARSE_SWEEPS {
                    for row in 0..matrix.row_count() {
                        relax(
                            matrix,
                            inverse_diagonal,
                            row,
                            &bottom.rhs,
                            &mut bottom.solution,
                        );
                    }
                    for row in (0..matrix.row_count()).rev() {
                        relax(
                            matrix,
                            inverse_diagonal,
                            row,
                            &bottom.rhs,
                            &mut bottom.solution,
                        );
                    }
                }
            }
        }
        // Up: prolongate the correction, post-smooth (backward Gauss–Seidel).
        for index in (0..depth).rev() {
            let matrix = self.level(index);
            let inverse_diagonal = &self.inverse_diagonals[index];
            let (upper, lower) = work.split_at_mut(index + 1);
            let here = &mut upper[index];
            let below = &lower[0];
            let prolongator = &self.prolongators[index];
            for row in 0..prolongator.row_count() {
                let (cols, vals) = prolongator.row(row);
                let correction: f64 = cols
                    .iter()
                    .zip(vals)
                    .map(|(&column, &value)| value * below.solution[column as usize])
                    .sum();
                here.solution[row] += correction;
            }
            for row in (0..matrix.row_count()).rev() {
                relax(matrix, inverse_diagonal, row, &here.rhs, &mut here.solution);
            }
        }
        out.copy_from_slice(&work[0].solution);
        self.work = work;
    }
}
