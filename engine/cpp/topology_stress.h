// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Stress-constrained SIMP (KOF-236, Phase A of the KOF-226 epic): the relaxed
// element von Mises stress, its aggregation into one differentiable constraint,
// and the adjoint sensitivity of that aggregate. The loop that puts the
// constraint into the MMA formulation is topology_optimize.cpp.
//
// The three textbook difficulties of stress-constrained TO and the fixes used:
//
//  1. Singularity. SIMP drives the physical stress of a vanishing element to
//     zero while its strain stays finite, so the feasible set has degenerate
//     "singular" optima MMA cannot reach. qp-relaxation (Bruggi 2008) divides the
//     SIMP stress by ρ^q, 0 ≤ q < p:
//        σ̃_e = σ_e^SIMP / ρ_e^q = ρ_e^(p−q) · σ_vm(D₀·B_e·u_e)
//     so the constrained stress still vanishes as ρ→0, but only like ρ^(p−q) —
//     ρ^½ for the usual p = 3, q = 2.5 (Le et al. 2010, "Stress-based topology
//     optimization for continua", SMO 41:605–620, eq. 11).
//  2. Many local constraints. One aggregate over s_e = σ̃_e/σ_allow replaces them:
//        P-norm  g = (Σ_e s_e^P)^(1/P)                          ≥ max s_e
//        KS      g = (1/P)·ln Σ_e exp(P·s_e)                     ≥ max s_e
//     The loop scales g by the adaptive normalization of Le et al. (eq. 17) so
//     the constraint tracks the true max; that factor is lagged and treated as a
//     constant in the sensitivities, as in the paper.
//  3. Non-self-adjoint sensitivities. g depends on u, so dg/dρ needs an adjoint:
//        K(ρ)·λ = ∂g/∂u,   dg/dρ_e = ∂g/∂ρ_e − λ_eᵀ·s'(ρ_e)·k0_e·u_e
//     solved with the same SIMP assembly and CG as the state (solve_simp_system).
//
// The stress is sampled once per element at its centroid (constant for linear
// tets), the same point compute_von_mises in solve_mfem.cpp uses for the static
// result.
#pragma once

#include "topology_formulation.h"
#include "topology_simp_core.h"

#include <mfem.hpp>

#include <vector>

namespace kofem::topopt {

// Per-element full-material stress operator S_e = D₀·B_e at the centroid, so the
// solid Voigt stress (xx, yy, zz, yz, xz, xy) is σ_e = S_e·u_e with u_e gathered
// by cache.vdofs[e]. 6 × (3·nodes) per element, built once per run.
struct ElementStressCache {
    std::vector<mfem::DenseMatrix> S;
};

ElementStressCache build_element_stress_cache(mfem::FiniteElementSpace& fespace, double E0,
                                              double nu);

// One evaluation of the aggregated stress at a solved design.
struct StressEvaluation {
    std::vector<double> relaxed;  // σ̃_e per element (stress units); 0 if excluded
    double max_relaxed = 0.0;     // max_e σ̃_e over the included elements
    int argmax = -1;              // element attaining it
    double aggregate = 0.0;       // g over s_e = σ̃_e/σ_allow (dimensionless, raw)
    std::vector<double> daggregate;  // dg/dρ_e, explicit + adjoint (per element)
    int adjoint_cg_iterations = 0;
};

// Evaluate g and dg/dρ at the design `rho` whose state `u` (a vdof vector — the
// ComplianceEvaluation::solution of the same ρ) is given. `exponent` is the
// relaxation exponent p − q (> 0). Elements with `excluded[e]` set (passive void)
// carry no stress and are left out of g; `excluded` may be null. Every included
// element needs ρ_e > 0 when exponent < 1 (the explicit term has ρ^(exponent−1)).
// Runs one adjoint solve. Throws std::runtime_error on invalid inputs.
StressEvaluation evaluate_stress(mfem::FiniteElementSpace& fespace,
                                 const ElementStiffnessCache& cache,
                                 const ElementStressCache& stress_cache,
                                 const mfem::Array<int>& ess_tdof,
                                 const std::vector<double>& rho, const mfem::Vector& u,
                                 double penalty, double emin_rel, double cg_rtol,
                                 double exponent, const StressConstraintConfig& stress,
                                 const std::vector<char>* excluded = nullptr);

}  // namespace kofem::topopt
