// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// SIMP topology-optimization numerical core — see topology_simp_core.h.

#include "topology_simp_core.h"

#include <array>
#include <cmath>
#include <cstdio>
#include <stdexcept>

namespace kofem::topopt {

namespace {

constexpr int dim = 3;

// A BilinearFormIntegrator that returns a per-element base stiffness scaled by a
// per-element factor, so BilinearForm::Assemble reuses the cached k0_e instead
// of re-integrating the elasticity operator each iteration (ADR-0002). The
// element index is ElementTransformation::ElementNo, which BilinearForm::Assemble
// sets before each AssembleElementMatrix call.
class ScaledElementMatrixIntegrator : public mfem::BilinearFormIntegrator {
    const std::vector<mfem::DenseMatrix>& k0_;
    const std::vector<double>& scale_;

public:
    ScaledElementMatrixIntegrator(const std::vector<mfem::DenseMatrix>& k0,
                                  const std::vector<double>& scale)
        : k0_(k0), scale_(scale) {}

    void AssembleElementMatrix(const mfem::FiniteElement& /*el*/,
                               mfem::ElementTransformation& Tr,
                               mfem::DenseMatrix& elmat) override {
        const int e = Tr.ElementNo;
        elmat = k0_[e];
        elmat *= scale_[e];
    }
};

// CG with the same Gauss-Seidel preconditioner the static solve uses, but a
// caller-set (tight by default) tolerance: the compliance sensitivities are
// quadratic in u, so an under-converged solve biases them. Kept separate from
// solve_mfem.cpp's run_cg_solve, whose fixed 1e-6 tolerance and error wording
// are load-bearing for the static solve.
int simp_cg_solve(mfem::SparseMatrix& A, const mfem::Vector& B, mfem::Vector& X,
                  double rel_tol) {
    mfem::GSSmoother prec(A);
    mfem::CGSolver cg;
    cg.SetRelTol(rel_tol);
    cg.SetMaxIter(10000);
    cg.SetPrintLevel(0);
    cg.SetPreconditioner(prec);
    cg.SetOperator(A);
    cg.Mult(B, X);
    if (!cg.GetConverged()) {
        std::array<char, 224> msg;
        std::snprintf(msg.data(), msg.size(),
                      "SIMP CG solve did not converge: relative residual %g after "
                      "%d iterations (target %g). Check that the design domain is "
                      "fully supported.",
                      (double)cg.GetFinalRelNorm(), cg.GetNumIterations(), rel_tol);
        throw std::runtime_error(msg.data());
    }
    return cg.GetNumIterations();
}

}  // namespace

double simp_scale(double rho, double penalty, double emin_rel) {
    return emin_rel + std::pow(rho, penalty) * (1.0 - emin_rel);
}

double simp_scale_deriv(double rho, double penalty, double emin_rel) {
    return penalty * std::pow(rho, penalty - 1.0) * (1.0 - emin_rel);
}

ElementStiffnessCache build_element_stiffness_cache(mfem::FiniteElementSpace& fespace,
                                                    double E0, double nu) {
    const double lam = E0 * nu / ((1.0 + nu) * (1.0 - 2.0 * nu));
    const double mu = E0 / (2.0 * (1.0 + nu));
    mfem::ConstantCoefficient lam_c(lam), mu_c(mu);
    mfem::ElasticityIntegrator integ(lam_c, mu_c);

    mfem::Mesh* mesh = fespace.GetMesh();
    const int ne = fespace.GetNE();

    ElementStiffnessCache cache;
    cache.k0.resize(ne);
    cache.vdofs.resize(ne);
    cache.volume.resize(ne);
    for (int e = 0; e < ne; ++e) {
        const mfem::FiniteElement& fe = *fespace.GetFE(e);
        mfem::ElementTransformation& T = *fespace.GetElementTransformation(e);
        integ.AssembleElementMatrix(fe, T, cache.k0[e]);
        fespace.GetElementVDofs(e, cache.vdofs[e]);
        cache.volume[e] = mesh->GetElementVolume(e);
    }
    return cache;
}

ComplianceEvaluation evaluate_compliance(mfem::FiniteElementSpace& fespace,
                                         const ElementStiffnessCache& cache,
                                         const mfem::Array<int>& ess_tdof,
                                         const mfem::LinearForm& load,
                                         const std::vector<double>& rho,
                                         double penalty, double emin_rel,
                                         double cg_rtol) {
    const int ne = fespace.GetNE();
    if ((int)rho.size() != ne)
        throw std::runtime_error(
            "evaluate_compliance: density field has " + std::to_string(rho.size()) +
            " entries but the mesh has " + std::to_string(ne) + " elements");

    std::vector<double> scale(ne);
    for (int e = 0; e < ne; ++e)
        scale[e] = simp_scale(rho[e], penalty, emin_rel);

    // K(ρ) = Σ_e scale[e]·k0[e]. The BilinearForm takes ownership of the
    // integrator; `scale` outlives it (declared first, destroyed last).
    mfem::BilinearForm a(&fespace);
    a.AddDomainIntegrator(new ScaledElementMatrixIntegrator(cache.k0, scale));
    a.Assemble();

    // Homogeneous essential BCs: u = 0 on the clamped supports (see the header
    // for why inhomogeneous Dirichlet is excluded). FormLinearSystem eliminates
    // those DOFs, driving them to the zero seeded here.
    mfem::GridFunction x(&fespace);
    x = 0.0;

    // FormLinearSystem eliminates the essential DOFs into the RHS in place, so
    // work on a copy and leave the caller's `load` untouched for reuse.
    mfem::Vector b_local(load);
    mfem::OperatorPtr A;
    mfem::Vector B, X;
    a.FormLinearSystem(ess_tdof, x, b_local, A, X, B);

    const int iters = simp_cg_solve(*A.As<mfem::SparseMatrix>(), B, X, cg_rtol);
    a.RecoverFEMSolution(X, b_local, x);

    ComplianceEvaluation ev;
    ev.dcompliance.resize(ne);
    ev.strain_energy.resize(ne);
    ev.cg_iterations = iters;

    // c = Σ_e s(ρ_e)·qₑ with qₑ = uₑᵀk0ₑuₑ; the self-adjoint sensitivity is
    // dc/dρ_e = −s'(ρ_e)·qₑ (the ∂u terms cancel because K is symmetric and the
    // load is design-independent).
    mfem::Vector ue;
    for (int e = 0; e < ne; ++e) {
        x.GetSubVector(cache.vdofs[e], ue);
        const double qe = cache.k0[e].InnerProduct(ue, ue);
        ev.strain_energy[e] = qe;
        ev.compliance += scale[e] * qe;
        ev.dcompliance[e] = -simp_scale_deriv(rho[e], penalty, emin_rel) * qe;
    }

    const int nv = fespace.GetMesh()->GetNV();
    ev.displacements.assign(3 * (size_t)nv, 0.0);
    for (int vi = 0; vi < nv; ++vi) {
        mfem::Array<int> vdofs;
        fespace.GetVertexVDofs(vi, vdofs);
        for (int c = 0; c < dim && c < vdofs.Size(); ++c)
            ev.displacements[3 * vi + c] = x[vdofs[c]];
    }
    return ev;
}

}  // namespace kofem::topopt
