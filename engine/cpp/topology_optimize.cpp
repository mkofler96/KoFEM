// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// SIMP optimization loop (min_compliance / min_volume) — see topology_optimize.h.

#include "topology_optimize.h"

#include "topology_filter.h"
#include "topology_formulation.h"
#include "topology_mma.h"
#include "topology_simp_core.h"

#include <array>
#include <cmath>
#include <cstdio>
#include <stdexcept>
#include <string>
#include <vector>

namespace kofem::topopt {

namespace {

// Element indices with a live design variable: every element except the pinned
// passive ones. `pinned[e]` is set for a passive-solid or passive-void element.
struct DesignDomain {
    std::vector<int> active;   // element index of each design variable
    std::vector<char> pinned;  // per element: 0 active, 1 passive solid, 2 passive void
};

DesignDomain build_design_domain(int ne, const std::vector<int>& passive_solid,
                                 const std::vector<int>& passive_void) {
    DesignDomain dom;
    dom.pinned.assign(ne, 0);
    auto mark = [&](const std::vector<int>& set, char kind, const char* which) {
        for (const int e : set) {
            if (e < 0 || e >= ne)
                throw std::runtime_error(std::string("optimize_compliance: passive ") +
                                         which + " element index " + std::to_string(e) +
                                         " out of range [0, " + std::to_string(ne) + ")");
            // An element cannot be both kept solid and kept void — the two pins
            // give it contradictory densities. Reject the overlap loudly rather
            // than silently letting one set win.
            if (dom.pinned[e] != 0 && dom.pinned[e] != kind)
                throw std::runtime_error(
                    "optimize_compliance: element " + std::to_string(e) +
                    " is listed as both passive solid and passive void");
            dom.pinned[e] = kind;
        }
    };
    mark(passive_solid, 1, "solid");
    mark(passive_void, 2, "void");
    for (int e = 0; e < ne; ++e)
        if (dom.pinned[e] == 0) dom.active.push_back(e);
    return dom;
}

}  // namespace

ComplianceOptResult optimize_compliance(mfem::FiniteElementSpace& fespace,
                                        const ElementStiffnessCache& cache,
                                        const mfem::Array<int>& ess_tdof,
                                        const mfem::LinearForm& load,
                                        const ComplianceOptConfig& config) {
    const int ne = fespace.GetNE();
    if (ne <= 0) throw std::runtime_error("optimize_compliance: mesh has no elements");
    if (static_cast<int>(cache.volume.size()) != ne)
        throw std::runtime_error("optimize_compliance: stiffness cache does not match mesh");
    const bool min_volume = config.objective == TopOptObjective::MinVolume;
    // Reject NaN explicitly: the range test alone would let a NaN through (every
    // comparison against NaN is false), so an isnan guard has to lead. Each
    // formulation validates only the constraint bound it actually uses.
    if (!min_volume && (std::isnan(config.volume_fraction) ||
                        config.volume_fraction <= 0.0 || config.volume_fraction > 1.0))
        throw std::runtime_error("optimize_compliance: volume_fraction must be in (0, 1]");
    if (min_volume && (!std::isfinite(config.compliance_limit) || config.compliance_limit <= 0.0))
        throw std::runtime_error(
            "optimize_compliance: compliance_limit must be finite and positive for the "
            "min_volume objective");
    if (std::isnan(config.rho_min) || config.rho_min < 0.0 || config.rho_min >= 1.0)
        throw std::runtime_error("optimize_compliance: rho_min must be in [0, 1)");
    if (config.max_iterations <= 0)
        throw std::runtime_error("optimize_compliance: max_iterations must be positive");
    if (!std::isfinite(config.penalty) || config.penalty <= 0.0)
        throw std::runtime_error("optimize_compliance: penalty must be finite and positive");
    if (!std::isfinite(config.filter_radius))
        throw std::runtime_error("optimize_compliance: filter_radius must be finite");
    if (!std::isfinite(config.move_limit) || config.move_limit <= 0.0)
        throw std::runtime_error("optimize_compliance: move_limit must be finite and positive");
    if (!std::isfinite(config.tolerance) || config.tolerance <= 0.0)
        throw std::runtime_error("optimize_compliance: tolerance must be finite and positive");
    if (!std::isfinite(config.emin_rel) || config.emin_rel <= 0.0 ||
        config.emin_rel >= 1.0)
        throw std::runtime_error("optimize_compliance: emin_rel must be in (0, 1)");
    if (!std::isfinite(config.cg_rtol) || config.cg_rtol <= 0.0)
        throw std::runtime_error("optimize_compliance: cg_rtol must be finite and positive");
    config.stream.validate("optimize_compliance");

    const DesignDomain dom =
        build_design_domain(ne, config.passive_solid, config.passive_void);
    const int nact = static_cast<int>(dom.active.size());
    if (nact == 0)
        throw std::runtime_error(
            "optimize_compliance: every element is pinned — no design variables");

    // Total volume and the min_compliance constraint scale volfrac·V_total.
    double vtotal = 0.0;
    for (const double v : cache.volume) vtotal += v;
    if (!(vtotal > 0.0)) throw std::runtime_error("optimize_compliance: non-positive volume");
    const double vcap = config.volume_fraction * vtotal;

    // Feasibility: the smallest volume the design can reach is the pinned-solid
    // volume plus rho_min over everything else (active variables cannot fall below
    // rho_min, passive solids are fixed at 1). If that already exceeds the cap the
    // constraint is unsatisfiable — the MMA artificial variables would absorb the
    // violation and the change-only stopping test could then report "convergence"
    // on an infeasible design, so reject it up front.
    double solid_volume = 0.0;
    for (int e = 0; e < ne; ++e)
        if (dom.pinned[e] == 1) solid_volume += cache.volume[e];
    const double least_volume = solid_volume + config.rho_min * (vtotal - solid_volume);
    if (!min_volume && least_volume > vcap * (1.0 + 1e-9))
        throw std::runtime_error(
            "optimize_compliance: volume fraction " +
            std::to_string(config.volume_fraction) +
            " is infeasible — the minimum reachable volume fraction is " +
            std::to_string(least_volume / vtotal) +
            " given rho_min and the pinned-solid volume");

    const double r_min = config.filter_radius > 0.0 ? config.filter_radius
                                                    : default_filter_radius(cache.volume);
    const DensityFilter filter(cache.centroid, r_min);

    // Densities: passives are pinned; active elements start at the volume fraction
    // (min_compliance: feasible and uniform) or at full material (min_volume: the
    // stiffest reachable design, so the first solve doubles as the feasibility
    // check of c_allow and MMA starts inside the feasible set).
    std::vector<double> rho(ne, 0.0);
    for (int e = 0; e < ne; ++e) rho[e] = config.rho_min;  // = passive-void value
    for (const int e : config.passive_solid) rho[e] = 1.0;
    const double rho_start = min_volume ? 1.0 : config.volume_fraction;
    for (const int e : dom.active) rho[e] = rho_start;
    FeasibleDesign best_feasible;  // min_volume only

    // MMA design vector over the active elements, bounds [rho_min, 1].
    const std::vector<double> xmin(nact, config.rho_min);
    const std::vector<double> xmax(nact, 1.0);
    MMAOptimizer mma(nact, 1, xmin, xmax, config.move_limit);

    std::vector<double> x(nact);
    for (int k = 0; k < nact; ++k) x[k] = rho[dom.active[k]];

    ComplianceOptResult result;
    result.history.reserve(config.max_iterations);
    double obj_scale = -1.0;  // 1/c₀, fixed at the first iteration to keep MMA scaled

    // The analysis, the recorded history entry and the returned density all
    // describe the SAME design `rho`: each pass analyses the current `rho`, records
    // it, then computes the MMA step. The step is applied only if another pass will
    // analyse the result — so on both convergence and the iteration cap the loop
    // exits with `rho` (and hence the returned density) equal to the last analysed
    // design, never one un-analysed MMA step ahead of the reported metrics.
    for (int it = 1;; ++it) {
        // (1) SIMP-penalized solve → compliance and self-adjoint sensitivities.
        ComplianceEvaluation ev = evaluate_compliance(
            fespace, cache, ess_tdof, load, rho, config.penalty, config.emin_rel,
            config.cg_rtol);
        result.displacements = ev.displacements;
        if (obj_scale < 0.0) obj_scale = ev.compliance > 0.0 ? 1.0 / ev.compliance : 1.0;

        // Compliance is non-increasing in every ρ_e (dc/dρ_e ≤ 0), so the
        // full-material start is the least compliance any design can reach. If it
        // already exceeds c_allow no design meets the limit — reject it rather than
        // let MMA's artificial variables absorb the violation.
        if (min_volume && it == 1 && ev.compliance > config.compliance_limit * (1.0 + 1e-9))
            throw std::runtime_error(
                "optimize_compliance: compliance limit " +
                std::to_string(config.compliance_limit) +
                " is infeasible — even the full-material design has compliance " +
                std::to_string(ev.compliance) + "; raise the limit above that value");

        // (2) Filter the sensitivities for mesh-independence (sensitivity filter,
        // the Phase-A default). The volume gradient is exact and unfiltered.
        std::vector<double> sens = ev.dcompliance;
        filter.filter_sensitivity(rho, sens);

        // Current volume fraction and the objective/constraint data for MMA over
        // the active variables.
        double vol_used = 0.0;
        for (int e = 0; e < ne; ++e) vol_used += rho[e] * cache.volume[e];
        const double vol_frac = vol_used / vtotal;

        FormulationInputs fin;
        fin.objective = config.objective;
        fin.active = &dom.active;
        fin.elem_volume = &cache.volume;
        fin.vtotal = vtotal;
        fin.vol_used = vol_used;
        fin.compliance = ev.compliance;
        fin.dcompliance = &sens;
        fin.volume_cap = vcap;
        fin.compliance_limit = config.compliance_limit;
        fin.compliance_scale = obj_scale;
        const MmaStepData step = formulate_mma_step(fin);

        // (3) One MMA step; measure the change it would make to the design.
        const std::vector<double> xnew =
            mma.update(x, step.f0, step.df0, step.fval, step.dfdx);
        double change = 0.0;
        for (int k = 0; k < nact; ++k)
            change = std::max(change, std::abs(xnew[k] - x[k]));

        // (4) Stream progress and record the analysed design's history entry.
        std::array<char, 128> line;
        std::snprintf(line.data(), line.size(),
                      "[topopt] it %d: c=%.6g vol=%.4f change=%.4g", it, ev.compliance,
                      vol_frac, change);
        std::printf("%s\n", line.data());
        result.history.push_back({it, ev.compliance, vol_frac, change});
        result.iterations = it;

        // A min_volume design has only converged once it also honours c ≤ c_allow;
        // a stalled-but-infeasible iterate runs on to max_iterations, and if the
        // cap lands on one, the last feasible design is returned instead.
        const bool feasible =
            !min_volume ||
            ev.compliance <= config.compliance_limit * (1.0 + kComplianceLimitSlack);
        if (min_volume && feasible) best_feasible = {it, rho, result.displacements};
        const bool converged = change < config.tolerance && feasible;
        const bool last = converged || it >= config.max_iterations;
        if (last && !feasible) {
            std::printf("[topopt] hit max_iterations with c=%.6g above c_allow=%.6g; "
                        "returning the last design that met the limit (it %d)\n",
                        ev.compliance, config.compliance_limit, best_feasible.it);
            rho = best_feasible.rho;
            result.displacements = best_feasible.displacements;
            result.history.resize(best_feasible.it);
            result.iterations = best_feasible.it;
            result.converged = false;
            config.stream.emit(best_feasible.it, true, rho);
            break;
        }
        config.stream.emit(it, last, rho);
        if (last) {
            result.converged = converged;
            break;
        }

        // Apply the step: `rho`/`x` become the next design the loop will analyse.
        x = xnew;
        for (int k = 0; k < nact; ++k) rho[dom.active[k]] = xnew[k];
    }

    result.density = rho;
    return result;
}

}  // namespace kofem::topopt
