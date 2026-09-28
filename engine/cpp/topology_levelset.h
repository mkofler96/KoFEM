// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Level-set topology optimization (minimum compliance, solid design domain).
//
// The alternative to SIMP for users who want a crisp, smooth boundary instead of
// an element-wise density field. The design is a NODAL level-set function
// φ ∈ [−1, 1] (φ > 0 material, φ < 0 void, φ = 0 the boundary), updated with the
// reaction–diffusion equation of
//
//   T. Yamada, K. Izui, S. Nishiwaki, A. Takezawa (2010), "A topology
//   optimization method based on the level set method incorporating a fictitious
//   interface energy", CMAME 199:2876–2891 — eq. (19)–(24);
//   implementation notes after Otomori et al. (2015), SMO 51:1159–1172.
//
//   ∂φ/∂t = d − λ + τ·∇²φ       (d: normalized sensitivity, λ: volume multiplier)
//
// discretized semi-implicitly on the same linear H1 space the elastic solve uses:
//
//   (M + Δt·τ·L) φⁿ⁺¹ = M φⁿ + Δt·(F − λ·M·1),   then φ ← clamp(φ, −1, 1)
//
// with M the scalar mass matrix and L the Laplacian. Because L·1 = 0, the λ term
// is an exact uniform shift of φⁿ⁺¹, so one linear solve per iteration suffices
// and λ is fixed afterwards by bisection on the volume constraint. The diffusion
// coefficient τ = ℓ² sets the smallest feature/curvature scale ℓ (the level-set
// analogue of SIMP's filter radius) and is what makes the boundary smooth. Unlike
// Hamilton–Jacobi level sets, this needs no reinitialization and nucleates holes
// on its own, and it runs on the unstructured tet meshes Netgen produces.
//
// Material mapping (ersatz material): each element's density is the exact volume
// fraction of {φ > 0} inside it (linear φ on a tet; hexes are split into six
// Kuhn tets), and the element stiffness is E_min + ρ_e·(E₀ − E_min). The
// sensitivity is the strain-energy density of that material — the topological
// derivative of compliance up to a positive material factor (Yamada eq. 30),
// which the normalization absorbs.
//
// The per-element density is returned alongside φ so every SIMP-era consumer
// (threshold slider, convergence plot, live streaming) keeps working unchanged;
// the viewport draws the φ = 0 isosurface for the smooth shape.
#pragma once

#include "topology_optimize.h"
#include "topology_simp_core.h"
#include "topology_stream.h"

#include <mfem.hpp>

#include <array>
#include <vector>

namespace kofem::topopt {

struct LevelSetOptConfig {
    double volume_fraction = 0.5;  // target Σρ_e·V_e / ΣV_e, in (0, 1]
    // Regularization length ℓ (model length units), τ = ℓ²: members and
    // boundary curvature finer than ~ℓ are diffused away. ≤ 0 → the mean element
    // size. Keep it near the element size: at SIMP's 1.5–3× filter radii the
    // diffusion already erases the thin diagonals of an MBB truss and leaves a
    // flanged beam of ~1.7× the compliance.
    double regularization_length = 0.0;
    // Pseudo-time step of the reaction–diffusion update. The converged design is
    // independent of it (the steady state of the update does not contain Δt);
    // it only sets how far φ can move per iteration.
    double time_step = 0.5;
    // Largest reduction of the volume fraction per iteration. The run starts from
    // full material (φ ≡ 1) and walks the volume target down to volume_fraction
    // at this rate, so the structure is carved out gradually (Yamada §4).
    double volume_step = 0.03;
    int max_iterations = 100;
    double tolerance = 0.01;    // convergence on max|Δρ_e| once the volume is met
    double emin_rel = 1e-3;     // ersatz-material stiffness ratio (Yamada §3.3)
    double cg_rtol = 1e-8;      // CG tolerance for each elastic solve

    // Element indices kept solid / void. Their nodes are pinned to φ = +1 / −1.
    std::vector<int> passive_solid;
    std::vector<int> passive_void;

    // Live element-density observer — see topology_stream.h.
    DensityStream stream;
};

struct LevelSetOptResult {
    std::vector<double> density;        // ρ_e = vol{φ > 0 in e}/V_e, solve order
    std::vector<double> level_set;      // φ per mesh vertex (vertex order)
    std::vector<double> displacements;  // nodal solution of the returned design
    std::vector<TopOptHistoryEntry> history;
    int iterations = 0;
    bool converged = false;
};

// Volume fraction of {φ > 0} inside a linear tetrahedron with nodal values
// `phi`. Exact for linear φ; invariant under the affine map, so it depends on the
// four nodal values alone.
double tet_positive_fraction(const std::array<double, 4>& phi);

// ρ_e for every element of `mesh` given nodal φ (one value per vertex). Tets are
// exact; hexes are split into the six Kuhn tets around the 0–6 diagonal.
std::vector<double> level_set_density(const mfem::Mesh& mesh, const std::vector<double>& phi);

// Run the level-set loop on a prebuilt design mesh. Arguments as for
// optimize_compliance (topology_optimize.h). Streams one
// `[topopt] it N: c=… vol=… change=…` line per iteration, the same format the
// SIMP loop prints so the convergence plot parses both. Throws
// std::runtime_error on an ill-posed problem.
LevelSetOptResult optimize_level_set(mfem::FiniteElementSpace& fespace,
                                     const ElementStiffnessCache& cache,
                                     const mfem::Array<int>& ess_tdof,
                                     const mfem::LinearForm& load,
                                     const LevelSetOptConfig& config);

}  // namespace kofem::topopt
