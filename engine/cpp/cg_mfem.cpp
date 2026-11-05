// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

#include "cg_mfem.h"
#include <array>
#include <cmath>
#include <cstdio>
#include <stdexcept>

namespace kofem {
namespace {

class CGLogMonitor : public mfem::IterativeSolverMonitor {
    mfem::CGSolver& solver_;
    CgContinuation continuation_;
    double norm0_ = 0.0;
    int iterations_ = 0;

public:
    CGLogMonitor(mfem::CGSolver& solver, const CgControl& control)
        : solver_(solver), continuation_(control, 5000) {
        solver_.SetMaxIter(continuation_.limit());
    }

    int iterations() const { return iterations_; }

    void MonitorResidual(int it, mfem::real_t norm, const mfem::Vector& /*r*/,
                         bool final) override {
        // MFEM's final notification repeats the last step and passes a square
        // root, whereas in-loop notifications pass (M^-1 r, r).
        if (final) return;
        iterations_ = it;
        if (it == 0) norm0_ = static_cast<double>(norm);
        const double rel = norm0_ > 0.0 ? std::sqrt(static_cast<double>(norm) / norm0_) : 0.0;
        continuation_.observe(rel);
        if (it % 10 == 0) {
            printf("[mfem] CG iteration %4d: relative residual %.3e\n", it, rel);
            fflush(stdout);
        }
        // MFEM 4.7 checks max_iter immediately after this callback. Raise it
        // here so Mult continues with its existing x, r and search direction,
        // and retains the ORIGINAL relative convergence target.
        if (it == continuation_.limit() && continuation_.extend(it, rel, 1e-6))
            solver_.SetMaxIter(continuation_.limit());
    }
};

}  // namespace

int solve_mfem_cg(mfem::SparseMatrix& matrix, const mfem::Vector& rhs,
                  mfem::Vector& solution, const CgControl& control) {
    mfem::GSSmoother prec(matrix);
    mfem::CGSolver cg;
    cg.SetRelTol(1e-6);
    cg.SetPrintLevel(0);
    CGLogMonitor monitor(cg, control);
    cg.SetMonitor(monitor);
    cg.SetPreconditioner(prec);
    cg.SetOperator(matrix);
    cg.Mult(rhs, solution);
    if (!cg.GetConverged()) {
        std::array<char, 320> msg;
        // MFEM 4.7 snapshots final_iter before the loop, so use the monitor's
        // actual count if an extended budget also expires without convergence.
        snprintf(msg.data(), msg.size(),
                 "CG solver did not converge: relative residual %g after %d "
                 "iterations (target 1e-6). The partial result was discarded — "
                 "check that the model is fully constrained, or refine the mesh.",
                 static_cast<double>(cg.GetFinalRelNorm()), monitor.iterations());
        throw std::runtime_error(msg.data());
    }
    printf("[mfem] CG converged: %d iterations, relative residual %.3e\n",
           monitor.iterations(), static_cast<double>(cg.GetFinalRelNorm()));
    fflush(stdout);
    return monitor.iterations();
}

}  // namespace kofem
