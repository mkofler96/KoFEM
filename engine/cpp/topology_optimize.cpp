// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// SIMP optimization loop (min_compliance / min_volume, optionally stress-
// constrained) — see topology_optimize.h.

#include "topology_optimize.h"

#include "topology_filter.h"
#include "topology_formulation.h"
#include "topology_mma.h"
#include "topology_simp_core.h"
#include "topology_stress.h"

#include <array>
#include <cmath>
#include <cstdio>
#include <limits>
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
                                        const ComplianceOptConfig& config,
                                        const ElementStressCache* stress_cache) {
    const int ne = fespace.GetNE();
    if (ne <= 0) throw std::runtime_error("optimize_compliance: mesh has no elements");
    if (static_cast<int>(cache.volume.size()) != ne)
        throw std::runtime_error("optimize_compliance: stiffness cache does not match mesh");
    const bool min_volume = config.objective == TopOptObjective::MinVolume;
    const StressConstraintConfig& stress = config.stress;
    const bool stress_on = stress.enabled;
    // Reject NaN explicitly: the range test alone would let a NaN through (every
    // comparison against NaN is false), so an isnan guard has to lead. Each
    // formulation validates only the constraint bound it actually uses.
    if (!min_volume && (std::isnan(config.volume_fraction) ||
                        config.volume_fraction <= 0.0 || config.volume_fraction > 1.0))
        throw std::runtime_error("optimize_compliance: volume_fraction must be in (0, 1]");
    // A min_volume run needs a positive compliance limit unless a stress limit
    // bounds it instead, in which case 0 means "no compliance limit".
    const bool has_compliance_limit = min_volume && config.compliance_limit > 0.0;
    if (min_volume && (!std::isfinite(config.compliance_limit) ||
                       config.compliance_limit < 0.0 ||
                       (config.compliance_limit == 0.0 && !stress_on)))
        throw std::runtime_error(
            "optimize_compliance: compliance_limit must be finite and positive for the "
            "min_volume objective (or 0 together with a stress limit)");
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
    if (stress_on) {
        if (stress_cache == nullptr || static_cast<int>(stress_cache->S.size()) != ne)
            throw std::runtime_error(
                "optimize_compliance: a stress limit needs the element stress cache "
                "built for this mesh");
        if (!std::isfinite(stress.limit) || stress.limit <= 0.0)
            throw std::runtime_error(
                "optimize_compliance: the stress limit sigma_allow must be finite and "
                "positive");
        if (!std::isfinite(stress.aggregation_p) || stress.aggregation_p < 1.0)
            throw std::runtime_error(
                "optimize_compliance: the stress aggregation parameter P must be >= 1");
        if (!std::isfinite(stress.relaxation_q) || stress.relaxation_q < 0.0 ||
            stress.relaxation_q >= config.penalty)
            throw std::runtime_error(
                "optimize_compliance: the stress relaxation q must satisfy 0 <= q < p "
                "(penalty " + std::to_string(config.penalty) + ")");
        if (!std::isfinite(stress.normalization_alpha) || stress.normalization_alpha <= 0.0 ||
            stress.normalization_alpha > 1.0)
            throw std::runtime_error(
                "optimize_compliance: the stress normalization alpha must be in (0, 1]");
        // σ̃ = ρ^(p−q)·σ_solid with p − q < 1 has an unbounded derivative at ρ = 0.
        if (config.penalty - stress.relaxation_q < 1.0 && !(config.rho_min > 0.0))
            throw std::runtime_error(
                "optimize_compliance: a stress-constrained run needs rho_min > 0 — the "
                "relaxed stress rho^(p-q) has an unbounded derivative at rho = 0");
    }
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

    // Design field `xfull` (one entry per element): passives are pinned; active
    // elements start at the volume fraction (min_compliance: feasible and uniform)
    // or at full material (min_volume: the stiffest reachable design, so the first
    // solve doubles as the feasibility check of c_allow and MMA starts inside the
    // compliance-feasible set). Without a stress limit the analysed density `rho`
    // IS the design field; with one it is the density-filtered field, re-pinned.
    std::vector<double> xfull(ne, config.rho_min);  // = passive-void value
    for (const int e : config.passive_solid) xfull[e] = 1.0;
    const double rho_start = min_volume ? 1.0 : config.volume_fraction;
    for (const int e : dom.active) xfull[e] = rho_start;
    auto physical = [&](const std::vector<double>& xf) {
        if (!stress_on) return xf;
        std::vector<double> r = filter.filter_density(xf);
        for (int e = 0; e < ne; ++e)
            if (dom.pinned[e] != 0) r[e] = xf[e];
        return r;
    };
    std::vector<double> rho = physical(xfull);
    const bool track_feasible = min_volume || stress_on;
    FeasibleDesign best_feasible;

    // Stress bookkeeping: the passive-void elements are kept empty by
    // construction, so their (relaxed) stress is not constrained.
    std::vector<char> stress_excluded(ne, 0);
    for (int e = 0; e < ne; ++e) stress_excluded[e] = dom.pinned[e] == 2 ? 1 : 0;
    const double stress_exponent = config.penalty - stress.relaxation_q;
    double stress_norm = -1.0;       // adaptive normalization c_k (Le et al. eq. 17)
    double lowest_max_stress = -1.0; // for the infeasibility message
    int lowest_max_stress_it = 0;

    // MMA design vector over the active elements, bounds [rho_min, 1].
    const int m = num_constraints(config.objective, has_compliance_limit, stress_on);
    const std::vector<double> xmin(nact, config.rho_min);
    const std::vector<double> xmax(nact, 1.0);
    MMAOptimizer mma(nact, m, xmin, xmax, config.move_limit);

    std::vector<double> x(nact);
    for (int k = 0; k < nact; ++k) x[k] = xfull[dom.active[k]];

    ComplianceOptResult result;
    result.history.reserve(config.max_iterations);
    double obj_scale = -1.0;  // 1/c₀, fixed at the first iteration to keep MMA scaled
    const double nan = std::numeric_limits<double>::quiet_NaN();

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
        if (has_compliance_limit && it == 1 &&
            ev.compliance > config.compliance_limit * (1.0 + 1e-9))
            throw std::runtime_error(
                "optimize_compliance: compliance limit " +
                std::to_string(config.compliance_limit) +
                " is infeasible — even the full-material design has compliance " +
                std::to_string(ev.compliance) + "; raise the limit above that value");

        // (1b) Relaxed stress, its aggregate and the adjoint sensitivity.
        StressEvaluation sev;
        double stress_measure = 0.0;  // c_k·g, the normalized constrained value
        if (stress_on) {
            sev = evaluate_stress(fespace, cache, *stress_cache, ess_tdof, rho, ev.solution,
                                  config.penalty, config.emin_rel, config.cg_rtol,
                                  stress_exponent, stress, &stress_excluded);
            const double ratio = sev.aggregate > 0.0
                                     ? (sev.max_relaxed / stress.limit) / sev.aggregate
                                     : 1.0;
            stress_norm = stress_norm < 0.0
                              ? ratio
                              : stress.normalization_alpha * ratio +
                                    (1.0 - stress.normalization_alpha) * stress_norm;
            stress_measure = stress_norm * sev.aggregate;
        }

        // (2) Sensitivities for MMA. Without a stress limit: Sigmund's sensitivity
        // filter on dc/dρ, exact volume gradient. With one: every gradient is taken
        // w.r.t. the physical density and chained back through the density filter;
        // pinned elements do not depend on x, so their entries are dropped first.
        std::vector<double> sens = ev.dcompliance;
        std::vector<double> dvol;
        std::vector<double> dstress;
        if (!stress_on) {
            filter.filter_sensitivity(rho, sens);
        } else {
            dvol = cache.volume;
            dstress = sev.daggregate;
            for (double& d : dstress) d *= stress_norm;
            for (int e = 0; e < ne; ++e)
                if (dom.pinned[e] != 0) sens[e] = dvol[e] = dstress[e] = 0.0;
            filter.filter_density_sensitivity(sens);
            filter.filter_density_sensitivity(dvol);
            filter.filter_density_sensitivity(dstress);
        }

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
        fin.dvolume = stress_on ? &dvol : nullptr;
        fin.volume_cap = vcap;
        fin.compliance_limit = has_compliance_limit ? config.compliance_limit : 0.0;
        fin.compliance_scale = obj_scale;
        fin.stress_measure = stress_measure;
        fin.dstress = stress_on ? &dstress : nullptr;
        const MmaStepData step = formulate_mma_step(fin);

        // (3) One MMA step; measure the change it would make to the design.
        const std::vector<double> xnew =
            mma.update(x, step.f0, step.df0, step.fval, step.dfdx);
        double change = 0.0;
        for (int k = 0; k < nact; ++k)
            change = std::max(change, std::abs(xnew[k] - x[k]));

        // (4) Stream progress and record the analysed design's history entry.
        const double agg_stress = stress_on ? stress_measure * stress.limit : nan;
        const double max_stress = stress_on ? sev.max_relaxed : nan;
        std::array<char, 192> line;
        if (stress_on)
            std::snprintf(line.data(), line.size(),
                          "[topopt] it %d: c=%.6g vol=%.4f change=%.4g sigma=%.6g "
                          "sigma_max=%.6g",
                          it, ev.compliance, vol_frac, change, agg_stress, max_stress);
        else
            std::snprintf(line.data(), line.size(),
                          "[topopt] it %d: c=%.6g vol=%.4f change=%.4g", it, ev.compliance,
                          vol_frac, change);
        std::printf("%s\n", line.data());
        result.history.push_back(
            {it, ev.compliance, vol_frac, change, agg_stress, max_stress});
        result.iterations = it;

        // A constrained design has only converged once it also honours its limits
        // (c ≤ c_allow for min_volume; the true max stress ≤ σ_allow and, beside
        // it, V ≤ V_cap for min_compliance). A stalled-but-infeasible iterate runs
        // on to max_iterations, and if the cap lands on one, the last feasible
        // design is returned instead.
        const bool compliance_ok =
            !has_compliance_limit ||
            ev.compliance <= config.compliance_limit * (1.0 + kComplianceLimitSlack);
        const bool stress_ok =
            !stress_on || sev.max_relaxed <= stress.limit * (1.0 + kStressLimitSlack);
        // With two constraints MMA can trade one against the other, so a
        // stress-constrained min_compliance design must also be judged on volume.
        const bool volume_ok =
            min_volume || !stress_on || vol_used <= vcap * (1.0 + kVolumeLimitSlack);
        const bool feasible = compliance_ok && stress_ok && volume_ok;
        if (stress_on && volume_ok &&
            (lowest_max_stress < 0.0 || sev.max_relaxed < lowest_max_stress)) {
            lowest_max_stress = sev.max_relaxed;
            lowest_max_stress_it = it;
        }
        if (track_feasible && feasible) best_feasible = {it, rho, result.displacements};
        const bool converged = change < config.tolerance && feasible;
        const bool last = converged || it >= config.max_iterations;
        if (last && !feasible) {
            // No iterate ever met the limits. Only a stress limit can get here —
            // the full-material first iterate of a compliance-limited min_volume
            // run is always feasible, or it was rejected above — so σ_allow is (as
            // far as this run can tell) infeasible for the loads and the volume
            // budget. Say so instead of returning a design that violates it.
            if (best_feasible.it == 0) {
                const std::string reached =
                    lowest_max_stress < 0.0
                        ? std::string("no iterate even met the volume budget alongside it")
                        : "the lowest max von Mises stress reached" +
                              std::string(min_volume ? "" : " within the volume budget") +
                              " was " + std::to_string(lowest_max_stress) + " (iteration " +
                              std::to_string(lowest_max_stress_it) + ")";
                throw std::runtime_error(
                    "optimize_compliance: maximum-stress limit " +
                    std::to_string(stress.limit) + " was not met" +
                    (min_volume ? std::string() : std::string(" within the volume budget")) +
                    " by any of the " + std::to_string(it) + " iterations — " + reached +
                    ". The limit looks infeasible for these loads" +
                    (min_volume ? std::string() : std::string(" and this volume fraction")) +
                    ": raise it" +
                    (min_volume ? std::string() : std::string(", raise the volume fraction")) +
                    " or allow more iterations.");
            }
            if (stress_on)
                std::printf("[topopt] hit max_iterations on a design above its limits (c=%.6g, "
                            "vol=%.4f, max stress=%.6g); returning the last design that met "
                            "them (it %d)\n",
                            ev.compliance, vol_frac, sev.max_relaxed, best_feasible.it);
            else
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

        // Apply the step: `x` becomes the next design and `rho` the density the
        // loop will analyse.
        x = xnew;
        for (int k = 0; k < nact; ++k) xfull[dom.active[k]] = xnew[k];
        rho = physical(xfull);
    }

    result.density = rho;
    return result;
}

}  // namespace kofem::topopt
