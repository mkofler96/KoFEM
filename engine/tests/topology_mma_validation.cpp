// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Native validation of the MMA optimizer (engine/cpp/topology_mma.{h,cpp}) —
// KOF-230, Phase A of the KOF-226 epic; ADR-0002 decision 4.
//
// MMA is the only optimizer in the epic, so it carries the full correctness burden
// alone (ADR-0002 "Cost"). Like bc_validation / topology_filter_validation and
// unlike topology_simp_validation, MMA has no MFEM/OCCT/Netgen dependency — it is
// dense linear algebra over element densities — so it compiles with a plain host
// C++ compiler (scripts/test-topology-mma.sh) and runs fast. It is NOT run by CI
// (see CLAUDE.md); this is the local proof that the subproblem solver hits a known
// optimum.
//
// The checks the issue asks for ("MMA subproblem verified on a tiny analytic
// problem with a known optimum"):
//   1. Separable convex min Σ_j c_j/ρ_j s.t. Σ_j ρ_j ≤ V — the exact structure of
//      a compliance/volume TO subproblem (objective ∝ 1/ρ, one linear volume
//      constraint). Its Lagrangian optimum is ρ_j* = V·√c_j / Σ_k √c_k, checked
//      to <1e-4. The active volume constraint is met to <1e-6.
//   2. A constrained QP min ρ1²+ρ2² s.t. ρ1+ρ2 ≥ 1 with optimum (0.5, 0.5),
//      reached from a strictly interior (and from an infeasible) start — the
//      artificial variables absorb the infeasible start.
//   3. Determinism: identical inputs give bit-identical iterates.
// Exits non-zero on any failure so it can gate a local run.

#include "topology_mma.h"

#include <cmath>
#include <cstdio>
#include <vector>

using kofem::topopt::MMAOptimizer;

namespace {

void check(int& failures, const char* name, bool ok) {
    if (!ok) ++failures;
    std::printf("  [%s] %s\n", ok ? "PASS" : "FAIL", name);
}

void check_close(int& failures, const char* name, double got, double want, double tol) {
    const bool ok = std::abs(got - want) <= tol;
    if (!ok) ++failures;
    std::printf("  [%s] %-46s got %.10g  want %.10g\n", ok ? "PASS" : "FAIL", name, got,
                want);
}

double max_abs_change(const std::vector<double>& a, const std::vector<double>& b) {
    double m = 0.0;
    for (std::size_t i = 0; i < a.size(); ++i) m = std::max(m, std::abs(a[i] - b[i]));
    return m;
}

// Run a single-constraint MMA problem to convergence and return the final point.
// `objective` fills (f0, df0); `constraint` fills (f1, df1). Stops on max|Δρ| < tol.
template <typename Obj, typename Con>
std::vector<double> run(int n, const std::vector<double>& xmin,
                        const std::vector<double>& xmax, const std::vector<double>& x0,
                        double move, int max_iter, double tol, Obj objective,
                        Con constraint, int* iters_out) {
    MMAOptimizer opt(n, 1, xmin, xmax, move);
    std::vector<double> x = x0;
    int it = 0;
    for (; it < max_iter; ++it) {
        double f0 = 0.0;
        std::vector<double> df0(n);
        objective(x, f0, df0);
        std::vector<double> fval(1);
        std::vector<double> dfdx(n);
        constraint(x, fval[0], dfdx);
        std::vector<double> xn = opt.update(x, f0, df0, fval, dfdx);
        const double change = max_abs_change(xn, x);
        x = xn;
        if (change < tol) {
            ++it;
            break;
        }
    }
    if (iters_out != nullptr) *iters_out = it;
    return x;
}

}  // namespace

int main() {
    int failures = 0;

    // ── (1) Separable convex min Σ c_j/ρ_j s.t. Σρ_j ≤ V ─────────────────────
    {
        std::printf("Separable convex compliance-like problem (min Σ c/ρ s.t. Σρ ≤ V):\n");
        const int n = 5;
        const std::vector<double> cw = {1.0, 2.0, 3.0, 4.0, 5.0};
        double sqrt_sum = 0.0;
        for (const double v : cw) sqrt_sum += std::sqrt(v);
        const double V = sqrt_sum;  // makes the optimum ρ_j* = √c_j (interior)

        const std::vector<double> xmin(n, 0.01);
        const std::vector<double> xmax(n, 10.0);
        const std::vector<double> x0(n, V / n);

        auto objective = [&](const std::vector<double>& x, double& f0,
                             std::vector<double>& df0) {
            f0 = 0.0;
            for (int j = 0; j < n; ++j) {
                f0 += cw[j] / x[j];
                df0[j] = -cw[j] / (x[j] * x[j]);
            }
        };
        auto constraint = [&](const std::vector<double>& x, double& f1,
                              std::vector<double>& df1) {
            double sum = 0.0;
            for (int j = 0; j < n; ++j) {
                sum += x[j];
                df1[j] = 1.0 / V;
            }
            f1 = (sum / V) - 1.0;
        };

        int iters = 0;
        const std::vector<double> x =
            run(n, xmin, xmax, x0, 0.2, 200, 1e-7, objective, constraint, &iters);

        std::printf("  converged in %d iterations\n", iters);
        bool opt_ok = true;
        double vol = 0.0;
        for (int j = 0; j < n; ++j) {
            const double want = V * std::sqrt(cw[j]) / sqrt_sum;  // = √c_j
            if (std::abs(x[j] - want) > 1e-4) opt_ok = false;
            std::printf("    ρ_%d = %.8f  (want %.8f)\n", j, x[j], want);
            vol += x[j];
        }
        check(failures, "reaches the analytic Lagrangian optimum ρ_j*=√c_j", opt_ok);
        check_close(failures, "active volume constraint Σρ == V", vol, V, 1e-6);
    }

    // ── (2) Constrained QP: min ρ1²+ρ2² s.t. ρ1+ρ2 ≥ 1, optimum (0.5, 0.5) ────
    auto solve_qp = [&](const std::vector<double>& x0, int* iters) {
        const int n = 2;
        const std::vector<double> xmin(n, 0.0);
        const std::vector<double> xmax(n, 2.0);
        auto objective = [&](const std::vector<double>& x, double& f0,
                             std::vector<double>& df0) {
            f0 = (x[0] * x[0]) + (x[1] * x[1]);
            df0[0] = 2.0 * x[0];
            df0[1] = 2.0 * x[1];
        };
        auto constraint = [&](const std::vector<double>& x, double& f1,
                              std::vector<double>& df1) {
            f1 = 1.0 - x[0] - x[1];  // ρ1+ρ2 ≥ 1  ⇔  f1 ≤ 0
            df1[0] = -1.0;
            df1[1] = -1.0;
        };
        return run(n, xmin, xmax, x0, 0.2, 300, 1e-8, objective, constraint, iters);
    };
    {
        std::printf("Constrained QP (min ρ1²+ρ2² s.t. ρ1+ρ2 ≥ 1):\n");
        int it_feas = 0;
        const std::vector<double> xf = solve_qp({1.0, 1.0}, &it_feas);
        std::printf("  from feasible start (1,1): converged in %d iterations\n", it_feas);
        check_close(failures, "ρ1 == 0.5 (feasible start)", xf[0], 0.5, 1e-5);
        check_close(failures, "ρ2 == 0.5 (feasible start)", xf[1], 0.5, 1e-5);

        int it_inf = 0;
        const std::vector<double> xi = solve_qp({0.05, 0.05}, &it_inf);  // infeasible start
        std::printf("  from infeasible start (0.05,0.05): converged in %d iterations\n",
                    it_inf);
        check_close(failures, "ρ1 == 0.5 (infeasible start)", xi[0], 0.5, 1e-5);
        check_close(failures, "ρ2 == 0.5 (infeasible start)", xi[1], 0.5, 1e-5);
    }

    // ── (3) Determinism: identical inputs → identical iterates ────────────────
    {
        std::printf("Determinism:\n");
        int a = 0;
        int b = 0;
        const std::vector<double> xa = solve_qp({1.0, 1.0}, &a);
        const std::vector<double> xb = solve_qp({1.0, 1.0}, &b);
        const bool same = (a == b) && (xa[0] == xb[0]) && (xa[1] == xb[1]);
        check(failures, "two runs are bit-identical", same);
    }

    std::printf(failures != 0 ? "\n%d check(s) FAILED\n" : "\nall checks passed\n", failures);
    return failures != 0 ? 1 : 0;
}
