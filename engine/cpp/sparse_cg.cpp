// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Sparse SPD assembly, essential-BC elimination and preconditioned CG.
// See sparse_cg.h.

#include "sparse_cg.h"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <stdexcept>
#include <string>

namespace kofem::sparse {

void SparseMatrix::add(int i, int j, double v) {
    Row& row = rows[i];
    auto it = std::lower_bound(
        row.begin(), row.end(), j,
        [](const std::pair<int, double>& e, int c) { return e.first < c; });
    if (it != row.end() && it->first == j)
        it->second += v;
    else
        row.insert(it, {j, v});
}

void apply_essential_bc(SparseMatrix& K, std::vector<double>& F,
                        const std::vector<char>& fixed, const std::vector<double>& values) {
    const int n = static_cast<int>(F.size());
    // Column pass first: each free row still holds its original entries, so the
    // known part of the product can be moved onto F before the columns go.
    for (int i = 0; i < n; ++i) {
        if (fixed[i] != 0) continue;
        auto& row = K.rows[i];
        if (!values.empty())
            for (const auto& [j, v] : row)
                if (fixed[j] != 0 && values[j] != 0.0) F[i] -= v * values[j];
        row.erase(std::remove_if(row.begin(), row.end(),
                                 [&](const std::pair<int, double>& e) {
                                     return fixed[e.first] != 0;
                                 }),
                  row.end());
    }
    // Row pass: a constrained DOF becomes the identity equation u_i = g_i.
    for (int i = 0; i < n; ++i)
        if (fixed[i] != 0) {
            K.rows[i].assign(1, {i, 1.0});
            F[i] = values.empty() ? 0.0 : values[i];
        }
}

// The SSOR fallback (ω=1) is the same smoother class the MFEM solid path uses
// (GSSmoother): plain Jacobi needs several-fold more iterations on the
// shell/coupled elasticity systems and stalls the large fine-mesh models.
CgResult cg_solve(SparseMatrix& K, const std::vector<double>& F, const CgOptions& opts) {
    const double rel_tol = opts.rel_tol;
    const char* tag = opts.log_tag.c_str();
    // Finite guard leads: a +inf tolerance passes `> 0` yet the first residual is
    // then < tol, so CG would report convergence after one step with an inaccurate
    // solution. optimize_shell_compliance checks this for the TO path; direct
    // static callers bypass that, so reject it here too.
    if (!std::isfinite(rel_tol) || rel_tol <= 0.0)
        throw std::runtime_error("cg_solve: CG relative tolerance must be finite and positive");
    const int n = static_cast<int>(F.size());
    // Flatten the sorted assembly rows into CSR once: the CG matvec then scans
    // contiguous arrays. Rows are column-sorted, so loEnd/hiBegin split each CSR row
    // into strict lower / diagonal / strict upper for the GS sweeps.
    std::vector<int> rowptr(n + 1, 0);
    for (int i = 0; i < n; ++i) rowptr[i + 1] = rowptr[i] + static_cast<int>(K.rows[i].size());
    const int nnz = rowptr[n];
    std::vector<int> col(nnz);
    std::vector<double> val(nnz);
    // Split each CSR row into strict lower [rowptr[i], loEnd[i]) and strict upper
    // [hiBegin[i], rowptr[i+1]). The split is by COLUMN INDEX, not by "where the
    // diagonal entry is", so a row whose diagonal is absent or exactly zero still
    // splits correctly and the sweeps below stay each other's transpose. Keying
    // the split off a stored diagonal instead made such a row consume its whole
    // span in BOTH sweeps — the upper part with a stale z — so M was no longer
    // symmetric and PCG lost the guarantee it is built on.
    std::vector<int> loEnd(n, 0), hiBegin(n, 0);
    std::vector<double> dval(n, 0.0), dinv(n, 1.0);
    for (int i = 0, p = 0; i < n; ++i) {
        loEnd[i] = p;
        bool passed_diag = false;
        for (const auto& [j, v] : K.rows[i]) {
            col[p] = j;
            val[p] = v;
            if (j < i) loEnd[i] = p + 1;
            if (j == i) {
                dval[i] = v;
                if (v != 0.0) dinv[i] = 1.0 / v;
                hiBegin[i] = p + 1;
                passed_diag = true;
            } else if (j > i && !passed_diag) {
                hiBegin[i] = p;
                passed_diag = true;
            }
            ++p;
        }
        if (!passed_diag) hiBegin[i] = p;  // row is entirely strict-lower
        SparseMatrix::Row().swap(K.rows[i]);  // release this row's assembly storage
    }
    K.free_rows();
    auto matvec = [&](const std::vector<double>& xv, std::vector<double>& yv) {
        for (int i = 0; i < n; ++i) {
            double s = 0.0;
            for (int k = rowptr[i]; k < rowptr[i + 1]; ++k) s += val[k] * xv[col[k]];
            yv[i] = s;
        }
    };
    // ── Preconditioner ────────────────────────────────────────────────────────
    //
    // Incomplete Cholesky with zero fill, K ≈ L·Lᵀ with L constrained to the lower
    // triangle's own sparsity, falling back to SSOR (ω=1) when the factorisation
    // breaks down. IC(0) roughly halves the iteration count of SSOR on these
    // systems for one extra O(nnz)-sized array and a one-off factorisation, which
    // matters because both are O(h⁻¹) methods: the coupled crane hook needs 5.5k
    // SSOR iterations at 6 mm elements and 15.9k at 2 mm, and the growth does not
    // stop. Neither preconditioner fixes the RATE — that needs a multilevel method
    // (KOF-173, no AMG in the WASM build) — but the constant is worth having.
    //
    // Elasticity stiffness matrices are SPD without being M-matrices, so plain
    // IC(0) frequently meets a non-positive pivot. The standard remedy is used
    // here: factor K + α·diag(K) instead (Manteuffel 1980), raising α until the
    // factorisation completes.
    std::vector<double> lval(nnz, 0.0);  // strict-lower entries of L, K's sparsity
    std::vector<double> ldiag(n, 0.0);
    bool have_ic = false;
    // Shifts tried, in order: 0, then 1e-3·4ᵏ up to 0.256. The loop counts attempts
    // with an integer and derives α from it, so the escalation cannot drift.
    for (int attempt = 0; !have_ic && attempt <= 5; ++attempt) {
        const double alpha = attempt == 0 ? 0.0 : 1e-3 * std::pow(4.0, attempt - 1);
        have_ic = true;
        for (int i = 0; i < n && have_ic; ++i) {
            // Row i of L, left to right: L(i,j) = (K(i,j) − Σ_{m<j} L(i,m)L(j,m)) / L(j,j),
            // the sum taken over the columns rows i and j share (both are sorted).
            double diag_sum = 0.0;
            for (int k = rowptr[i]; k < loEnd[i]; ++k) {
                const int j = col[k];
                double s = val[k];
                int a = rowptr[i], b = rowptr[j];
                while (a < k && b < loEnd[j]) {
                    if (col[a] < col[b])
                        ++a;
                    else if (col[a] > col[b])
                        ++b;
                    else
                        s -= lval[a++] * lval[b++];
                }
                lval[k] = s / ldiag[j];
                diag_sum += lval[k] * lval[k];
            }
            const double d = dval[i] * (1.0 + alpha) - diag_sum;
            if (!(d > 0.0)) {
                have_ic = false;  // non-positive pivot — retry with a larger shift
                break;
            }
            ldiag[i] = std::sqrt(d);
        }
    }
    if (have_ic) {
        printf("[%s] preconditioner: incomplete Cholesky IC(0)\n", tag);
    } else {
        printf("[%s] preconditioner: SSOR (IC(0) factorisation broke down)\n", tag);
        std::vector<double>().swap(lval);
        std::vector<double>().swap(ldiag);
    }
    fflush(stdout);

    // z = M⁻¹ r. IC(0): forward solve L·y = r, backward solve Lᵀ·z = y. SSOR:
    // M = (D+L)·D⁻¹·(D+U) — forward substitution, diagonal scale, backward
    // substitution. A row with no (or a zero) diagonal takes D = 1 there, which
    // keeps M symmetric: the two sweeps use the strict lower and strict upper
    // halves, which are each other's transpose for symmetric K.
    auto apply_prec = [&](const std::vector<double>& r, std::vector<double>& z) {
        if (have_ic) {
            for (int i = 0; i < n; ++i) {
                double s = r[i];
                for (int k = rowptr[i]; k < loEnd[i]; ++k) s -= lval[k] * z[col[k]];
                z[i] = s / ldiag[i];
            }
            for (int i = n - 1; i >= 0; --i) {
                z[i] /= ldiag[i];
                // Scatter this solved component out of the rows above it: column i
                // of Lᵀ is row i of L, which CSR stores by row, so the update is
                // pushed rather than gathered.
                for (int k = rowptr[i]; k < loEnd[i]; ++k) z[col[k]] -= lval[k] * z[i];
            }
            return;
        }
        for (int i = 0; i < n; ++i) {  // (D+L)·u = r
            double s = r[i];
            for (int k = rowptr[i]; k < loEnd[i]; ++k) s -= val[k] * z[col[k]];
            z[i] = s * dinv[i];
        }
        for (int i = 0; i < n; ++i) z[i] *= (dval[i] != 0.0 ? dval[i] : 1.0);  // w = D·u
        for (int i = n - 1; i >= 0; --i) {  // (D+U)·z = w
            double s = z[i];
            for (int k = hiBegin[i]; k < rowptr[i + 1]; ++k) s -= val[k] * z[col[k]];
            z[i] = s * dinv[i];
        }
    };

    std::vector<double> x(n, 0.0), r = F, z(n), p(n), Ap(n);
    double bnorm = 0.0;
    for (double f : F) bnorm += f * f;
    bnorm = std::sqrt(bnorm);
    if (bnorm == 0.0) return {std::vector<double>(n, 0.0), true, 0, 0.0};

    apply_prec(r, z);
    p = z;
    double rz = 0.0;
    for (int i = 0; i < n; ++i) rz += r[i] * z[i];

    // An SSOR-preconditioned CG on 3D elasticity needs O(h⁻¹) ∝ O(∛n) iterations
    // — κ(M⁻¹K) grows as h⁻², and CG converges in O(√κ). A fixed cap therefore
    // stops being a safety net and becomes the thing that fails the solve as the
    // mesh is refined: the coupled crane hook needs 5.5k iterations at 6 mm
    // elements (25k unknowns) and 15.1k at 2 mm (295k unknowns), both of which
    // converge, so 1 mm runs past a flat 20000 while still descending. The
    // constant below is ~1.8× the measured need on that model, and the floor
    // leaves small systems exactly as generous as they were. A genuinely stalled
    // solve still terminates — just not before a healthy one has had its chance.
    // (The real answer is a stronger preconditioner: no AMG in the WASM build,
    // tracked as KOF-173.)
    const int maxit =
        std::max(20000, static_cast<int>(400.0 * std::cbrt(static_cast<double>(n))));
    const double tol = rel_tol;
    CgResult res;
    for (int it = 0; it < maxit; ++it) {
        matvec(p, Ap);
        double pAp = 0.0;
        for (int i = 0; i < n; ++i) pAp += p[i] * Ap[i];
        // pᵀAp ≤ 0 on a nonzero p means the system is not positive definite along
        // that direction — CG is then solving the wrong problem and every later
        // iterate is meaningless, which shows up downstream as a residual that
        // floors and climbs. The caller's system is meant to be SPD, so this is a
        // formulation or conditioning failure worth naming at the point it
        // happens rather than 20000 silent iterations later.
        if (!(pAp > 0.0))
            throw std::runtime_error(
                opts.log_tag + " CG breakdown: pᵀAp = " + std::to_string(pAp) +
                " at iteration " + std::to_string(it) + " (relative residual " +
                std::to_string(res.rel_residual) + ") — the system is not positive definite." +
                (opts.breakdown_hint.empty() ? "" : " " + opts.breakdown_hint));
        const double alpha = rz / pAp;
        double rnorm = 0.0;
        for (int i = 0; i < n; ++i) {
            x[i] += alpha * p[i];
            r[i] -= alpha * Ap[i];
            rnorm += r[i] * r[i];
        }
        rnorm = std::sqrt(rnorm);
        res.iterations = it + 1;
        res.rel_residual = rnorm / bnorm;
        // Progress feed for the browser log panel — same role as the solid
        // path's CGLogMonitor, so a long coupled solve is visibly alive.
        if (it % 100 == 0) {
            printf("[%s] CG iteration %5d: relative residual %.3e\n", tag, it,
                   res.rel_residual);
            fflush(stdout);
        }
        if (res.rel_residual < tol) { res.converged = true; break; }
        apply_prec(r, z);
        double rz_new = 0.0;
        for (int i = 0; i < n; ++i) rz_new += r[i] * z[i];
        const double beta = rz_new / rz;
        for (int i = 0; i < n; ++i) p[i] = z[i] + beta * p[i];
        rz = rz_new;
    }
    res.x = std::move(x);
    return res;
}

}  // namespace kofem::sparse
