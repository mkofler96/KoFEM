// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// SIMP topology-optimization numerical core (KOF-228, Phase A of the KOF-226
// epic; decisions recorded in ADR-0002).
//
// This is the per-iteration math the optimizer drives, with NO optimization
// loop and NO JS boundary: given a design-density field ρ (one value per solid
// element), it assembles the SIMP-penalized stiffness, solves the elastic
// problem, and returns the compliance objective together with its self-adjoint
// element sensitivities. The `optimize_topology` Embind entry (topology_simp.h)
// and the MMA/OC loop are later sub-issues (KOF-230/231) that build on this.
//
// Modified SIMP with a stiffness floor (ADR-0002):
//   E(ρ)/E₀ = E_min/E₀ + ρ^p·(1 − E_min/E₀),   E_min/E₀ ≈ 1e-9
// keeps the operator positive-definite as ρ→0. Because the element stiffness is
// linear in E, k_e(ρ_e) = s(ρ_e)·k0_e with k0_e the full-material element
// stiffness — assembled once (build_element_stiffness_cache), then scaled per
// iteration, never re-integrated.
#pragma once

#include <mfem.hpp>

#include <vector>

namespace kofem::topopt {

// SIMP stiffness interpolation s(ρ) = E(ρ)/E₀ and its derivative, with
// emin_rel = E_min/E₀ the relative stiffness floor. simp_scale(0) = emin_rel;
// simp_scale(1) = 1.
double simp_scale(double rho, double penalty, double emin_rel);
double simp_scale_deriv(double rho, double penalty, double emin_rel);

// Per-element quantities built once from the design mesh at the full material
// modulus E₀, reused across every optimization iteration:
//   k0[e]     full-material element stiffness (dof·dim square)
//   vdofs[e]  the element's global vdof indices (gather uₑ, scatter kₑ)
//   volume[e] element measure ∫_e dV (for the volume constraint + sensitivity)
struct ElementStiffnessCache {
    std::vector<mfem::DenseMatrix> k0;
    std::vector<mfem::Array<int>> vdofs;
    std::vector<double> volume;
};

// Assemble k0[e], vdofs[e] and volume[e] for a vector-H1 space (vdim = dim)
// whose single design material has Young's modulus E0 and Poisson ratio nu.
ElementStiffnessCache build_element_stiffness_cache(mfem::FiniteElementSpace& fespace,
                                                    double E0, double nu);

// Result of one SIMP evaluation at a given density field.
struct ComplianceEvaluation {
    double compliance = 0.0;            // c = Σ_e s(ρ_e)·uₑᵀk0ₑuₑ = fᵀu
    std::vector<double> dcompliance;    // dc/dρ_e = −s'(ρ_e)·uₑᵀk0ₑuₑ  (≤ 0)
    std::vector<double> strain_energy;  // qₑ = uₑᵀk0ₑuₑ  (≥ 0, cache-reusable)
    std::vector<double> displacements;  // full nodal solution, 3 per vertex
    int cg_iterations = 0;
};

// Assemble K(ρ) = Σ_e s(ρ_e)·k0[e], solve K u = f with the essential DOFs in
// `ess_tdof` (their prescribed values seeded into `x_dirichlet`), and return the
// compliance and its element sensitivities.
//
//   load    the assembled right-hand side (built once by the caller)
//   rho     one design density per element, in fespace element order
//   cg_rtol CG relative tolerance; defaults tight because the compliance
//           sensitivities are quadratic in u, so a loose solve visibly biases
//           them. Throws std::runtime_error if CG fails to converge.
// `load` is read but not modified — the essential-DOF elimination works on an
// internal copy, so the same right-hand side can be reused across FD checks and
// optimizer iterations.
ComplianceEvaluation evaluate_compliance(mfem::FiniteElementSpace& fespace,
                                         const ElementStiffnessCache& cache,
                                         const mfem::Array<int>& ess_tdof,
                                         const mfem::GridFunction& x_dirichlet,
                                         const mfem::LinearForm& load,
                                         const std::vector<double>& rho,
                                         double penalty, double emin_rel,
                                         double cg_rtol = 1e-10);

}  // namespace kofem::topopt
