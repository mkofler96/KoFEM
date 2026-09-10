// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// SIMP minimum-compliance optimization loop (KOF-230, Phase A of the KOF-226
// epic; ADR-0002). This is the first end-to-end topology optimization: the loop
// that drives the per-iteration SIMP math (topology_simp_core.h), the
// mesh-independence filter (topology_filter.h) and the MMA optimizer
// (topology_mma.h) to a minimum-compliance layout under a volume constraint.
//
//   minimize   c(ρ) = fᵀu(ρ)      (structural compliance)
//   subject to Σ_e ρ_e·V_e ≤ volfrac·Σ_e V_e     (volume fraction)
//              ρ_min ≤ ρ_e ≤ 1
//
// One iteration:
//   1. SIMP-penalized solve → compliance c and dc/dρ (evaluate_compliance);
//   2. filter the sensitivities for mesh-independence (DensityFilter);
//   3. feed (c, dc/dρ) as the objective and the volume constraint (with dV/dρ) to
//      one MMA step, updating ρ within the move limit and [ρ_min, 1] bounds;
//   4. converge on max|Δρ| < tolerance, or stop at max_iterations.
//
// This is the numerical core only — NO JS boundary. The `optimize_topology` Embind
// entry, its payload parsing and the live-progress/cancellation worker handler are
// KOF-231; that entry parses the TopOptSettings block into a ComplianceOptConfig
// and calls this. The MMA optimizer here is what the general constrained
// formulation (KOF-235) and the stress constraint (KOF-236) build on unchanged.
#pragma once

#include "topology_simp_core.h"

#include <mfem.hpp>

#include <vector>

namespace kofem::topopt {

// One optimizer iteration in the returned history. `compliance` is the objective
// being minimized; `volume` is the current volume fraction Σρ_e·V_e / ΣV_e;
// `max_change` is max|Δρ_e| over the design variables this iteration. Mirrors the
// TopOptHistoryEntry wire type (kofem_wasm.d.ts), minus the stress field that only
// a stress-constrained run (KOF-236) fills.
struct TopOptHistoryEntry {
    int it;
    double compliance;
    double volume;
    double max_change;
};

struct ComplianceOptConfig {
    double volume_fraction = 0.5;  // target Σρ_e·V_e / ΣV_e
    double penalty = 3.0;          // SIMP penalty p
    double filter_radius = 0.0;    // r_min; ≤ 0 → default 1.5× mean element size
    double move_limit = 0.2;       // MMA move limit
    int max_iterations = 100;
    double tolerance = 0.01;       // convergence on max|Δρ|
    double emin_rel = 1e-9;        // stiffness floor E_min/E₀ (ADR-0002)
    double rho_min = 0.0;          // design lower bound
    double cg_rtol = 1e-8;         // CG tolerance for each SIMP solve

    // Passive regions (ADR-0002 decision 6): element indices whose density is
    // pinned — `passive_solid` to 1 (kept solid: supports, loaded elements,
    // keep-in), `passive_void` to `rho_min` (kept void: keep-out). Pinned elements
    // are excluded from the MMA design vector but still count toward the volume
    // constraint and still participate in the sensitivity filter's smoothing. In
    // v1 these are empty (the whole solid mesh is the design domain); the explicit
    // keep-in/keep-out picker that populates them is KOF-238.
    std::vector<int> passive_solid;
    std::vector<int> passive_void;
};

struct ComplianceOptResult {
    std::vector<double> density;        // final ρ_e, one per element (solve order)
    std::vector<double> displacements;  // nodal solution of the last analysed design
                                        // (the iterate of the final history entry),
                                        // 3 per vertex
    std::vector<TopOptHistoryEntry> history;
    int iterations = 0;
    bool converged = false;  // true if it stopped on the tolerance, not max_iterations
};

// Run the SIMP minimum-compliance loop on a prebuilt design mesh. `cache`, the
// clamped essential DOFs `ess_tdof` and the assembled `load` are the same objects
// the static solve builds (built once by the caller, reused every iteration —
// ADR-0002 decision 1). Streams one `[topopt] it N: c=… vol=… change=…` line per
// iteration over the printf→worker channel. Throws std::runtime_error on an
// ill-posed problem (no design elements, invalid volume fraction, a solve that
// fails to converge).
ComplianceOptResult optimize_compliance(mfem::FiniteElementSpace& fespace,
                                        const ElementStiffnessCache& cache,
                                        const mfem::Array<int>& ess_tdof,
                                        const mfem::LinearForm& load,
                                        const ComplianceOptConfig& config);

}  // namespace kofem::topopt
