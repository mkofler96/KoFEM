// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Method of Moving Asymptotes (MMA) — the optimizer that drives every
// topology-optimization problem in the KOF-226 epic (ADR-0002 decision 4;
// KOF-230, Phase A).
//
// MMA (K. Svanberg, "The method of moving asymptotes — a new method for
// structural optimization", Int. J. Numer. Methods Eng. 24:359–373, 1987) solves
//
//     min  f_0(x)   s.t.  f_i(x) ≤ 0  (i = 1..m),   x_min ≤ x ≤ x_max
//
// by replacing, at each iterate x^k, every f_i with a separable convex function
// built from moving asymptotes L_j < x_j < U_j, and solving that subproblem
// exactly. This is the classic dense small-m variant (O(1–10) constraints, many
// design variables) written from the formulation in Svanberg's 2007 report "MMA
// and GCMMA — two methods for nonlinear optimization": `mmasub` forms the
// subproblem and `subsolv` solves its KKT system with a primal-dual interior-point
// Newton iteration. It is self-contained — plain dense linear algebra over
// std::vector, no MFEM and no external solver — so it links into both the WASM
// engine and the host-compiled unit test.
//
// The optimizer is objective/constraint agnostic: the caller supplies f_0, f_i and
// their ∂/∂x gradients each iteration, so the compliance loop (KOF-230), the
// volume objective (KOF-235) and the stress constraint (KOF-236) reuse this class
// unchanged. It is stateful across iterations — it keeps the two previous iterates
// and the current asymptotes, which the asymptote update needs — so one instance
// drives one optimization from start to finish.
#pragma once

#include <vector>

namespace kofem::topopt {

class MMAOptimizer {
public:
    // n design variables, m inequality constraints, per-variable bounds
    // xmin[j] < xmax[j], and the MMA move limit (fraction of xmax-xmin a variable
    // may move per iteration; 0.2 is the ADR default). Uses the standard artificial
    // -variable parameters a0 = 1, a_i = 0, c_i = 1000, d_i = 1, for which the
    // subproblem optimum leaves the artificial y_i and z at zero and so recovers
    // the hard-constrained problem. Throws std::runtime_error on inconsistent sizes
    // or a non-positive bound gap.
    MMAOptimizer(int n, int m, std::vector<double> xmin, std::vector<double> xmax,
                 double move_limit);

    // One MMA step. `x` is the current point (length n); `f0`/`df0` the objective
    // value and its gradient (length n); `fval` the m constraint values and `dfdx`
    // their Jacobian (m×n, row-major: dfdx[i*n + j] = ∂f_i/∂x_j). Returns the next
    // iterate, already clamped to [xmin, xmax] and the move limit. Throws
    // std::runtime_error on a size mismatch.
    std::vector<double> update(const std::vector<double>& x, double f0,
                               const std::vector<double>& df0,
                               const std::vector<double>& fval,
                               const std::vector<double>& dfdx);

    // Number of update() calls so far (the outer iteration counter the asymptote
    // rule keys on: the first two steps use the wide initial asymptotes).
    int iteration() const { return iter_; }

    // Current moving asymptotes, exposed for the subproblem-level validation.
    const std::vector<double>& lower_asymptote() const { return low_; }
    const std::vector<double>& upper_asymptote() const { return upp_; }

private:
    int n_;
    int m_;
    std::vector<double> xmin_;
    std::vector<double> xmax_;
    double move_;

    std::vector<double> low_;    // L_j, valid after the first update()
    std::vector<double> upp_;    // U_j
    std::vector<double> xold1_;  // x^{k-1}
    std::vector<double> xold2_;  // x^{k-2}
    int iter_ = 0;
};

}  // namespace kofem::topopt
