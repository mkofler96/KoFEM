// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// SIMP minimum-compliance optimization loop — see topology_optimize.h.

#include "topology_optimize.h"

#include "topology_filter.h"
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
    std::vector<int> active;    // element index of each design variable
    std::vector<char> pinned;   // per element, 1 if density is fixed
};

DesignDomain build_design_domain(int ne, const std::vector<int>& passive_solid,
                                 const std::vector<int>& passive_void) {
    DesignDomain dom;
    dom.pinned.assign(ne, 0);
    auto mark = [&](const std::vector<int>& set, const char* which) {
        for (const int e : set) {
            if (e < 0 || e >= ne)
                throw std::runtime_error(std::string("optimize_compliance: passive ") +
                                         which + " element index " + std::to_string(e) +
                                         " out of range [0, " + std::to_string(ne) + ")");
            dom.pinned[e] = 1;
        }
    };
    mark(passive_solid, "solid");
    mark(passive_void, "void");
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
    if (!(config.volume_fraction > 0.0 && config.volume_fraction <= 1.0))
        throw std::runtime_error("optimize_compliance: volume_fraction must be in (0, 1]");
    if (!(config.rho_min >= 0.0 && config.rho_min < 1.0))
        throw std::runtime_error("optimize_compliance: rho_min must be in [0, 1)");

    const DesignDomain dom =
        build_design_domain(ne, config.passive_solid, config.passive_void);
    const int nact = static_cast<int>(dom.active.size());
    if (nact == 0)
        throw std::runtime_error(
            "optimize_compliance: every element is pinned — no design variables");

    // Total volume and the constraint scale volfrac·V_total. The constraint is
    // written normalized, f1 = (Σρ_e·V_e)/(volfrac·V_total) − 1 ≤ 0, so it and its
    // gradient are O(1) for MMA.
    double vtotal = 0.0;
    for (const double v : cache.volume) vtotal += v;
    const double vcap = config.volume_fraction * vtotal;
    if (!(vcap > 0.0)) throw std::runtime_error("optimize_compliance: non-positive volume");

    const double r_min = config.filter_radius > 0.0 ? config.filter_radius
                                                    : default_filter_radius(cache.volume);
    const DensityFilter filter(cache.centroid, r_min);

    // Densities: active elements start at the volume fraction, passives are pinned.
    std::vector<double> rho(ne, 0.0);
    for (int e = 0; e < ne; ++e) rho[e] = config.rho_min;  // = passive-void value
    for (const int e : config.passive_solid) rho[e] = 1.0;
    for (const int e : dom.active) rho[e] = config.volume_fraction;

    // MMA design vector over the active elements, bounds [rho_min, 1].
    const std::vector<double> xmin(nact, config.rho_min);
    const std::vector<double> xmax(nact, 1.0);
    MMAOptimizer mma(nact, 1, xmin, xmax, config.move_limit);

    std::vector<double> x(nact);
    for (int k = 0; k < nact; ++k) x[k] = rho[dom.active[k]];

    ComplianceOptResult result;
    result.history.reserve(config.max_iterations);
    double obj_scale = -1.0;  // 1/c₀, fixed at the first iteration to keep MMA scaled

    for (int it = 1; it <= config.max_iterations; ++it) {
        // (1) SIMP-penalized solve → compliance and self-adjoint sensitivities.
        ComplianceEvaluation ev = evaluate_compliance(
            fespace, cache, ess_tdof, load, rho, config.penalty, config.emin_rel,
            config.cg_rtol);
        result.displacements = ev.displacements;
        if (obj_scale < 0.0) obj_scale = ev.compliance > 0.0 ? 1.0 / ev.compliance : 1.0;

        // (2) Filter the sensitivities for mesh-independence (sensitivity filter,
        // the Phase-A default). The volume gradient is exact and unfiltered.
        std::vector<double> sens = ev.dcompliance;
        filter.filter_sensitivity(rho, sens);

        // Current volume fraction and the objective/constraint data for MMA over
        // the active variables.
        double vol_used = 0.0;
        for (int e = 0; e < ne; ++e) vol_used += rho[e] * cache.volume[e];
        const double vol_frac = vol_used / vtotal;

        std::vector<double> df0(nact);
        std::vector<double> dfdx(nact);  // m = 1 → the single constraint row
        for (int k = 0; k < nact; ++k) {
            const int e = dom.active[k];
            df0[k] = sens[e] * obj_scale;
            dfdx[k] = cache.volume[e] / vcap;
        }
        const std::vector<double> fval = {(vol_used / vcap) - 1.0};
        const double f0 = ev.compliance * obj_scale;

        // (3) One MMA step, then rebuild the density field and measure the change.
        const std::vector<double> xnew = mma.update(x, f0, df0, fval, dfdx);
        double change = 0.0;
        for (int k = 0; k < nact; ++k) {
            change = std::max(change, std::abs(xnew[k] - x[k]));
            rho[dom.active[k]] = xnew[k];
        }
        x = xnew;

        // (4) Stream progress and record history.
        std::array<char, 128> line;
        std::snprintf(line.data(), line.size(),
                      "[topopt] it %d: c=%.6g vol=%.4f change=%.4g", it, ev.compliance,
                      vol_frac, change);
        std::printf("%s\n", line.data());
        result.history.push_back({it, ev.compliance, vol_frac, change});
        result.iterations = it;

        if (change < config.tolerance) {
            result.converged = true;
            break;
        }
    }

    result.density = rho;
    return result;
}

}  // namespace kofem::topopt
