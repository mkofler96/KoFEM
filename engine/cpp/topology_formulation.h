// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// The objective/constraint pair a SIMP run hands to MMA (KOF-235). Both the solid
// loop (topology_optimize.cpp) and the shell/coupled loop (topology_shell.cpp)
// evaluate the same two responses every iteration — compliance c(ρ) with its
// self-adjoint sensitivity, and volume V(ρ) = Σρ_e·V_e — and only differ in which
// one is minimized and which one is bounded:
//
//   min_compliance:  minimize c(ρ)   s.t.  V(ρ) ≤ volfrac·V_total     (KOF-230)
//   min_volume:      minimize V(ρ)   s.t.  c(ρ) ≤ c_allow             (KOF-235)
//
// Both are written in the normalized form MMA wants (objective and constraint
// O(1), constraint as f₁ ≤ 0). MFEM-free so the shell path can share it.
#pragma once

#include <string>
#include <vector>

namespace kofem::topopt {

enum class TopOptObjective { MinCompliance, MinVolume };

// Relative slack on the compliance limit for a min_volume run to count as
// converged: MMA approaches an active constraint from either side, so the last
// iterate sits within a fraction of a percent of c_allow rather than exactly on it.
constexpr double kComplianceLimitSlack = 5e-3;

// Everything one MMA step needs, over the active design variables.
struct MmaStepData {
    double f0 = 0.0;
    std::vector<double> df0;
    std::vector<double> fval;  // m = 1
    std::vector<double> dfdx;  // m × n, row-major (one row)
};

struct FormulationInputs {
    TopOptObjective objective = TopOptObjective::MinCompliance;
    const std::vector<int>* active = nullptr;          // design element per variable
    const std::vector<double>* elem_volume = nullptr;  // V_e per design element
    double vtotal = 0.0;                               // Σ_e V_e
    double vol_used = 0.0;                             // Σ_e ρ_e·V_e
    double compliance = 0.0;                           // c(ρ)
    const std::vector<double>* dcompliance = nullptr;  // filtered dc/dρ_e, per element
    double volume_cap = 0.0;        // min_compliance: volfrac·V_total
    double compliance_limit = 0.0;  // min_volume: c_allow
    double compliance_scale = 1.0;  // min_compliance: 1/c₀
};

// "min_compliance volfrac=0.500" / "min_volume c_allow=12.5" — the run header the
// Embind entries log before the loop starts.
std::string describe_formulation(TopOptObjective objective, double volume_fraction,
                                 double compliance_limit);

// The minimized value of one history entry: compliance or volume fraction. This is
// the `objective` field of the TopOptHistoryEntry wire type (kofem_wasm.d.ts).
inline double objective_value(TopOptObjective objective, double compliance,
                              double volume_fraction) {
    return objective == TopOptObjective::MinVolume ? volume_fraction : compliance;
}

// Assemble (f0, df0, fval, dfdx) for the chosen formulation.
//   min_compliance: f0 = c/c₀,         f₁ = V/V_cap − 1
//   min_volume:     f0 = V/V_total,    f₁ = c/c_allow − 1
// The compliance sensitivity is the (already filtered) dc/dρ; the volume gradient
// V_e is exact, as in the Phase-A sensitivity-filter scheme (ADR-0002 decision 5).
MmaStepData formulate_mma_step(const FormulationInputs& in);

}  // namespace kofem::topopt
