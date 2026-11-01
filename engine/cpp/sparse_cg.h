// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Sparse symmetric positive-definite system: row-wise assembly storage, essential
// (Dirichlet) BC elimination, and a preconditioned conjugate-gradient solve.
//
// Generic linear algebra with no element-specific logic — the shell and coupled
// solid/shell drivers (shell_core.cpp) use it, and so can any other MFEM-free
// assembler. No MFEM/Emscripten dependency, so it is natively testable.

#ifndef KOFEM_SPARSE_CG_H
#define KOFEM_SPARSE_CG_H

#include <string>
#include <utility>
#include <vector>

namespace kofem::sparse {

// Sorted-vector rows for assembly; cg_solve flattens these to CSR before
// iterating. Rows were std::map originally, but at ~40–50 bytes per node-based
// entry the big coupled systems (~10⁷ entries, two matrices alive at once)
// exhausted the 2 GB WASM heap — a sorted vector is 16 B/entry and
// cache-friendly for both the O(row-width) insert and the CSR flatten.
struct SparseMatrix {
    using Row = std::vector<std::pair<int, double>>;
    std::vector<Row> rows;
    explicit SparseMatrix(int n) : rows(n) {}
    // Accumulate v into entry (i, j).
    void add(int i, int j, double v);
    // Release all row storage (the CSR copy or the reduced system owns the data
    // from here on) — keeps peak memory to one matrix at a time.
    void free_rows() { std::vector<Row>().swap(rows); }
};

// Eliminate the essential (Dirichlet) DOFs. `fixed` marks every constrained DOF
// and `values` carries what each is constrained TO — zero for a homogeneous
// clamp, g for a prescribed displacement. Standard inhomogeneous elimination:
// the known column contribution K[:,p]·g moves to the right-hand side before the
// row/column is cleared, which keeps the reduced system symmetric and gives the
// same answer as solving the free block alone.
//
// `values` may be empty, which means every constrained DOF is fixed to zero.
void apply_essential_bc(SparseMatrix& K, std::vector<double>& F,
                        const std::vector<char>& fixed, const std::vector<double>& values);

struct CgOptions {
    // Relative-residual target ‖r‖/‖F‖. Must be finite and positive.
    double rel_tol = 1e-10;
    // Prefix of the progress log lines ("[<tag>] CG iteration …") and of the
    // breakdown error, so a caller's solve is identifiable in the browser log.
    std::string log_tag = "cg";
    // Appended to the breakdown error: what, in the caller's formulation, can
    // make its system indefinite.
    std::string breakdown_hint;
};

struct CgResult {
    std::vector<double> x;  // solution, one entry per row of K
    bool converged = false;
    int iterations = 0;
    double rel_residual = 0.0;
};

// Solve K·x = F by CG, preconditioned with incomplete Cholesky IC(0) (with a
// diagonal shift when the plain factorisation breaks down) or, failing that,
// symmetric Gauss-Seidel (SSOR, ω=1). K must be SPD — essential BCs applied.
//
// Consumes K: each assembly row is released as soon as it is copied into the CSR
// arrays, so the assembly storage and the CSR copy never coexist in full — this
// matters on the ~10⁷-entry coupled systems inside the WASM heap cap.
//
// Throws std::runtime_error on an invalid tolerance and on a CG breakdown
// (pᵀKp ≤ 0, i.e. K is not positive definite along the search direction).
CgResult cg_solve(SparseMatrix& K, const std::vector<double>& F, const CgOptions& opts);

}  // namespace kofem::sparse

#endif  // KOFEM_SPARSE_CG_H
