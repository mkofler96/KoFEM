// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Relaxed von Mises stress, aggregation and adjoint sensitivity — see
// topology_stress.h (KOF-236).

#include "topology_stress.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <stdexcept>
#include <string>

namespace kofem::topopt {

namespace {

constexpr int dim = 3;
constexpr int kVoigt = 6;  // xx, yy, zz, yz, xz, xy

// Von Mises of a Voigt stress, σ_vm² = σᵀ·V·σ with V the deviatoric metric
// (1 on the normal diagonal, −½ off it, 3 on the shears) — the same invariant as
// √(3/2 s:s) in compute_von_mises. `grad` receives V·σ/σ_vm = ∂σ_vm/∂σ, or zeros
// at σ_vm = 0 where the norm is not differentiable (its subgradient 0 is used).
double von_mises(const std::array<double, kVoigt>& s, std::array<double, kVoigt>& grad) {
    const std::array<double, kVoigt> vs = {
        s[0] - 0.5 * (s[1] + s[2]), s[1] - 0.5 * (s[0] + s[2]), s[2] - 0.5 * (s[0] + s[1]),
        3.0 * s[3],                 3.0 * s[4],                 3.0 * s[5]};
    double vm2 = 0.0;
    for (int i = 0; i < kVoigt; ++i) vm2 += s[i] * vs[i];
    const double vm = std::sqrt(std::max(vm2, 0.0));
    for (int i = 0; i < kVoigt; ++i) grad[i] = vm > 0.0 ? vs[i] / vm : 0.0;
    return vm;
}

}  // namespace

ElementStressCache build_element_stress_cache(mfem::FiniteElementSpace& fespace, double E0,
                                              double nu) {
    if (!std::isfinite(E0) || E0 <= 0.0 || !std::isfinite(nu) || nu <= -1.0 || nu >= 0.5)
        throw std::runtime_error("build_element_stress_cache: need E0 > 0 and -1 < nu < 0.5");
    const double lam = E0 * nu / ((1.0 + nu) * (1.0 - 2.0 * nu));
    const double mu = E0 / (2.0 * (1.0 + nu));

    // D₀ in Voigt form with engineering shear strains.
    mfem::DenseMatrix D(kVoigt);
    D = 0.0;
    for (int i = 0; i < dim; ++i) {
        for (int j = 0; j < dim; ++j) D(i, j) = lam;
        D(i, i) = lam + 2.0 * mu;
        D(dim + i, dim + i) = mu;
    }

    const int ne = fespace.GetNE();
    ElementStressCache out;
    out.S.resize(ne);
    mfem::DenseMatrix dshape, B;
    for (int e = 0; e < ne; ++e) {
        const mfem::FiniteElement& fe = *fespace.GetFE(e);
        mfem::ElementTransformation& T = *fespace.GetElementTransformation(e);
        const mfem::IntegrationPoint& center = mfem::Geometries.GetCenter(fe.GetGeomType());
        T.SetIntPoint(&center);
        const int nd = fe.GetDof();
        dshape.SetSize(nd, dim);
        fe.CalcPhysDShape(T, dshape);

        // Element vdofs are component-major (all x, then y, then z), matching the
        // ElasticityIntegrator k0 layout, so column (c, a) is c·nd + a.
        B.SetSize(kVoigt, dim * nd);
        B = 0.0;
        for (int a = 0; a < nd; ++a) {
            const double dx = dshape(a, 0);
            const double dy = dshape(a, 1);
            const double dz = dshape(a, 2);
            const int cx = a;
            const int cy = nd + a;
            const int cz = 2 * nd + a;
            B(0, cx) = dx;
            B(1, cy) = dy;
            B(2, cz) = dz;
            B(3, cy) = dz;  // γ_yz
            B(3, cz) = dy;
            B(4, cx) = dz;  // γ_xz
            B(4, cz) = dx;
            B(5, cx) = dy;  // γ_xy
            B(5, cy) = dx;
        }
        out.S[e].SetSize(kVoigt, dim * nd);
        mfem::Mult(D, B, out.S[e]);
    }
    return out;
}

StressEvaluation evaluate_stress(mfem::FiniteElementSpace& fespace,
                                 const ElementStiffnessCache& cache,
                                 const ElementStressCache& stress_cache,
                                 const mfem::Array<int>& ess_tdof,
                                 const std::vector<double>& rho, const mfem::Vector& u,
                                 double penalty, double emin_rel, double cg_rtol,
                                 double exponent, const StressConstraintConfig& stress,
                                 const std::vector<char>* excluded) {
    const int ne = fespace.GetNE();
    if (static_cast<int>(rho.size()) != ne || static_cast<int>(stress_cache.S.size()) != ne)
        throw std::runtime_error("evaluate_stress: density field / stress cache size " +
                                 std::to_string(rho.size()) + " / " +
                                 std::to_string(stress_cache.S.size()) +
                                 " does not match the mesh's " + std::to_string(ne) +
                                 " elements");
    if (u.Size() != fespace.GetVSize())
        throw std::runtime_error("evaluate_stress: state vector does not match the FE space");
    if (excluded != nullptr && static_cast<int>(excluded->size()) != ne)
        throw std::runtime_error("evaluate_stress: exclusion mask does not match the mesh");
    if (!(exponent > 0.0))
        throw std::runtime_error("evaluate_stress: relaxation exponent p − q must be > 0");
    if (!(stress.limit > 0.0) || !(stress.aggregation_p > 0.0))
        throw std::runtime_error("evaluate_stress: stress limit and aggregation P must be > 0");

    auto included = [&](int e) { return excluded == nullptr || (*excluded)[e] == 0; };

    // Per element: solid stress σ_e = S_e·u_e, its von Mises and ∂σ_vm/∂u_e.
    StressEvaluation ev;
    ev.relaxed.assign(ne, 0.0);
    std::vector<double> s(ne, 0.0);           // s_e = σ̃_e / σ_allow
    std::vector<double> vm_solid(ne, 0.0);    // σ_vm(D₀·B_e·u_e)
    std::vector<mfem::Vector> dvm_du(ne);     // ∂σ_vm/∂u_e = S_eᵀ·V·σ/σ_vm
    mfem::Vector ue;
    mfem::Vector sig(kVoigt);
    mfem::Vector g6(kVoigt);
    std::array<double, kVoigt> sa{};
    std::array<double, kVoigt> ga{};
    double smax = 0.0;
    for (int e = 0; e < ne; ++e) {
        if (!included(e)) continue;
        if (exponent < 1.0 && !(rho[e] > 0.0))
            throw std::runtime_error(
                "evaluate_stress: element " + std::to_string(e) +
                " has density " + std::to_string(rho[e]) +
                " — the relaxed stress needs ρ > 0 (set rho_min > 0)");
        u.GetSubVector(cache.vdofs[e], ue);
        stress_cache.S[e].Mult(ue, sig);
        for (int i = 0; i < kVoigt; ++i) sa[i] = sig[i];
        vm_solid[e] = von_mises(sa, ga);
        for (int i = 0; i < kVoigt; ++i) g6[i] = ga[i];
        dvm_du[e].SetSize(ue.Size());
        stress_cache.S[e].MultTranspose(g6, dvm_du[e]);

        ev.relaxed[e] = std::pow(rho[e], exponent) * vm_solid[e];
        s[e] = ev.relaxed[e] / stress.limit;
        if (ev.argmax < 0 || ev.relaxed[e] > ev.max_relaxed) {
            ev.max_relaxed = ev.relaxed[e];
            ev.argmax = e;
        }
        smax = std::max(smax, s[e]);
    }
    if (ev.argmax < 0)
        throw std::runtime_error("evaluate_stress: every element is excluded from the "
                                 "stress constraint");

    // Aggregate and its partials w_e = ∂g/∂s_e, shifted by the max for stability.
    const double P = stress.aggregation_p;
    std::vector<double> w(ne, 0.0);
    if (stress.aggregation == StressAggregation::PNorm) {
        if (smax > 0.0) {
            // g = smax·(Σ (s_e/smax)^P)^(1/P);  ∂g/∂s_e = (s_e/g)^(P−1).
            double sum = 0.0;
            for (int e = 0; e < ne; ++e)
                if (included(e)) sum += std::pow(s[e] / smax, P);
            ev.aggregate = smax * std::pow(sum, 1.0 / P);
            for (int e = 0; e < ne; ++e)
                if (included(e)) w[e] = std::pow(s[e] / ev.aggregate, P - 1.0);
        }
        // All-zero stress: g = 0 and, for P > 1, every partial is 0 as well.
    } else {
        // g = smax + (1/P)·ln Σ exp(P·(s_e − smax));  ∂g/∂s_e = softmax_e.
        double sum = 0.0;
        for (int e = 0; e < ne; ++e)
            if (included(e)) sum += std::exp(P * (s[e] - smax));
        ev.aggregate = smax + std::log(sum) / P;
        for (int e = 0; e < ne; ++e)
            if (included(e)) w[e] = std::exp(P * (s[e] - smax)) / sum;
    }

    // Explicit term ∂g/∂ρ_e and the adjoint load ∂g/∂u = Σ_e w_e·(ρ_e^a/σ_allow)·∂σ_vm/∂u_e.
    ev.daggregate.assign(ne, 0.0);
    mfem::Vector adj_rhs(fespace.GetVSize());
    adj_rhs = 0.0;
    for (int e = 0; e < ne; ++e) {
        if (!included(e) || w[e] == 0.0) continue;
        ev.daggregate[e] = w[e] * exponent * std::pow(rho[e], exponent - 1.0) * vm_solid[e] /
                           stress.limit;
        mfem::Vector contrib(dvm_du[e]);
        contrib *= w[e] * std::pow(rho[e], exponent) / stress.limit;
        adj_rhs.AddElementVector(cache.vdofs[e], contrib);
    }

    // K(ρ)·λ = ∂g/∂u with λ = 0 on the clamped DOFs (u is fixed there, so ∂u/∂ρ = 0),
    // then dg/dρ_e −= λ_eᵀ·(∂K/∂ρ_e)·u_e = s'(ρ_e)·λ_eᵀ·k0_e·u_e.
    const mfem::Vector lambda = solve_simp_system(fespace, cache, ess_tdof, adj_rhs, rho,
                                                  penalty, emin_rel, cg_rtol,
                                                  &ev.adjoint_cg_iterations);
    mfem::Vector le;
    mfem::Vector k0u;
    for (int e = 0; e < ne; ++e) {
        u.GetSubVector(cache.vdofs[e], ue);
        lambda.GetSubVector(cache.vdofs[e], le);
        k0u.SetSize(ue.Size());
        cache.k0[e].Mult(ue, k0u);
        ev.daggregate[e] -= simp_scale_deriv(rho[e], penalty, emin_rel) * (le * k0u);
    }
    return ev;
}

}  // namespace kofem::topopt
