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
// Either can additionally carry a maximum von Mises stress constraint (KOF-236),
// σ_PN(ρ) ≤ σ_allow, on the aggregated relaxed stress (topology_stress.h). A
// min_volume run may then drop the compliance limit and be bounded by stress
// alone. Constraint rows are ordered [volume | compliance, stress].
//
// All are written in the normalized form MMA wants (objective and constraints
// O(1), constraints as f_i ≤ 0). MFEM-free so the shell path can share it.
#pragma once

#include <string>
#include <vector>

namespace kofem::topopt {

enum class TopOptObjective { MinCompliance, MinVolume };

// Relative slack on the compliance limit for a min_volume run to count as
// converged: MMA approaches an active constraint from either side, so the last
// iterate sits within a fraction of a percent of c_allow rather than exactly on it.
constexpr double kComplianceLimitSlack = 5e-3;

// The same slack for the stress limit, judged on the TRUE max relaxed stress
// (not the aggregate MMA sees). The adaptive P-norm normalization lags the true
// max by one iteration, so the iterate oscillates around σ_allow by a few
// percent before it settles; 2% separates "on the limit" from "violating it".
constexpr double kStressLimitSlack = 2e-2;

// Relative slack on the volume cap when a min_compliance run also carries a
// stress limit and so has to be judged feasible on both (see kStressLimitSlack).
constexpr double kVolumeLimitSlack = 5e-3;

// How the per-element relaxed stresses are aggregated into one differentiable
// constraint (KOF-236): the P-norm (Σ s_e^P)^(1/P) or the Kreisselmeier–
// Steinhauser function (1/P)·ln Σ exp(P·s_e), both over s_e = σ̃_e/σ_allow.
enum class StressAggregation { PNorm, KS };

// Maximum von Mises stress constraint (KOF-236). Disabled by default; the
// Embind entry enables it when the payload carries constraints.maxStress.
struct StressConstraintConfig {
    bool enabled = false;
    double limit = 0.0;  // σ_allow, > 0, in the model's stress units
    StressAggregation aggregation = StressAggregation::PNorm;
    // P: the P-norm exponent or the KS parameter. P-norm is typically 6–12, KS
    // (on σ/σ_allow ≈ 1) 20–60 — larger tracks the max more tightly but makes
    // the constraint less smooth.
    double aggregation_p = 8.0;
    // qp-relaxation (Bruggi 2008; Le et al. 2010): σ̃_e = σ_e^SIMP / ρ_e^q with
    // 0 ≤ q < p, i.e. ρ_e^(p−q)·σ_e^solid. q = 2.5 with p = 3 gives the ρ^½
    // interpolation of Le et al.
    double relaxation_q = 2.5;
    // Adaptive normalization c_k = α·(σ_max/σ_PN)_k + (1−α)·c_{k−1} (Le et al.
    // 2010, eq. 17), so c·σ_PN tracks the true max as the design evolves. α in
    // (0, 1]; α = 0 would freeze c at its first value.
    double normalization_alpha = 0.5;
};

// Suffix for describe_formulation: " + max_stress σ_allow=… (pnorm P=8, q=2.5)".
std::string describe_stress_constraint(const StressConstraintConfig& stress);

// The last analysed min_volume design that met c ≤ c_allow. If the run reaches
// max_iterations on an iterate above the limit, the loop returns this design (and
// truncates the history to it) instead of an infeasible one. Iteration 1 — full
// material — is always feasible, otherwise the run was rejected up front, so a
// capped min_volume run always has one to fall back to.
struct FeasibleDesign {
    int it = 0;
    std::vector<double> rho;
    std::vector<double> displacements;
};

// Everything one MMA step needs, over the active design variables.
struct MmaStepData {
    double f0 = 0.0;
    std::vector<double> df0;
    std::vector<double> fval;  // m constraint values (see num_constraints)
    std::vector<double> dfdx;  // m × n, row-major
};

struct FormulationInputs {
    TopOptObjective objective = TopOptObjective::MinCompliance;
    const std::vector<int>* active = nullptr;          // design element per variable
    const std::vector<double>* elem_volume = nullptr;  // V_e per design element
    double vtotal = 0.0;                               // Σ_e V_e
    double vol_used = 0.0;                             // Σ_e ρ_e·V_e
    double compliance = 0.0;                           // c(ρ)
    const std::vector<double>* dcompliance = nullptr;  // filtered dc/dρ_e, per element
    // dV/dρ_e per element. Null → the element volumes V_e (exact when ρ is the
    // design variable); a density-filtered run passes the chained H-weighted form.
    const std::vector<double>* dvolume = nullptr;
    double volume_cap = 0.0;        // min_compliance: volfrac·V_total
    double compliance_limit = 0.0;  // min_volume: c_allow; 0 → no compliance row
    double compliance_scale = 1.0;  // min_compliance: 1/c₀
    // Stress row (KOF-236), present when `dstress` is set: `stress_measure` is
    // the normalized aggregate g = c·σ_PN/σ_allow and `dstress` its gradient
    // dg/dρ_e per element; the row is f = g − 1.
    double stress_measure = 0.0;
    const std::vector<double>* dstress = nullptr;
};

// Number of MMA constraint rows the formulation produces — the `m` to build the
// MMAOptimizer with. Throws std::runtime_error for a min_volume run with neither
// a compliance limit nor a stress constraint (nothing bounds the volume).
int num_constraints(TopOptObjective objective, bool has_compliance_limit, bool has_stress);

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
//   min_volume:     f0 = V/V_total,    f₁ = c/c_allow − 1   (when c_allow > 0)
//   + stress:                          f_m = g − 1           (when dstress set)
// The compliance sensitivity is the (already filtered) dc/dρ; the volume gradient
// V_e is exact, as in the Phase-A sensitivity-filter scheme (ADR-0002 decision 5).
MmaStepData formulate_mma_step(const FormulationInputs& in);

}  // namespace kofem::topopt
