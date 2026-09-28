// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Objective/constraint assembly for one MMA step — see topology_formulation.h.

#include "topology_formulation.h"

#include <array>
#include <cstdio>
#include <stdexcept>

namespace kofem::topopt {

std::string describe_formulation(TopOptObjective objective, double volume_fraction,
                                 double compliance_limit) {
    std::array<char, 64> buf{};
    if (objective == TopOptObjective::MinVolume && compliance_limit <= 0.0)
        std::snprintf(buf.data(), buf.size(), "min_volume");
    else if (objective == TopOptObjective::MinVolume)
        std::snprintf(buf.data(), buf.size(), "min_volume c_allow=%.6g", compliance_limit);
    else
        std::snprintf(buf.data(), buf.size(), "min_compliance volfrac=%.3f", volume_fraction);
    return buf.data();
}

std::string describe_stress_constraint(const StressConstraintConfig& stress) {
    if (!stress.enabled) return "";
    std::array<char, 128> buf{};
    std::snprintf(buf.data(), buf.size(), " + max_stress sigma_allow=%.6g (%s P=%.3g, q=%.3g)",
                  stress.limit,
                  stress.aggregation == StressAggregation::KS ? "ks" : "pnorm",
                  stress.aggregation_p, stress.relaxation_q);
    return buf.data();
}

int num_constraints(TopOptObjective objective, bool has_compliance_limit, bool has_stress) {
    const int primary =
        objective == TopOptObjective::MinCompliance || has_compliance_limit ? 1 : 0;
    const int m = primary + (has_stress ? 1 : 0);
    if (m == 0)
        throw std::runtime_error(
            "min_volume needs a compliance limit, a maximum-stress limit, or both — "
            "without one nothing bounds how much material is removed");
    return m;
}

MmaStepData formulate_mma_step(const FormulationInputs& in) {
    if (in.active == nullptr || in.elem_volume == nullptr || in.dcompliance == nullptr)
        throw std::runtime_error("formulate_mma_step: missing active set, volumes or "
                                 "compliance sensitivities");
    const std::vector<int>& active = *in.active;
    const std::vector<double>& vol = *in.elem_volume;
    const std::vector<double>& dc = *in.dcompliance;
    const std::vector<double>& dv = in.dvolume != nullptr ? *in.dvolume : vol;
    const int nact = static_cast<int>(active.size());
    const bool min_volume = in.objective == TopOptObjective::MinVolume;
    const bool has_compliance_row = !min_volume || in.compliance_limit > 0.0;
    const bool has_stress_row = in.dstress != nullptr;
    const int m = num_constraints(in.objective, in.compliance_limit > 0.0, has_stress_row);

    MmaStepData d;
    d.df0.resize(nact);
    d.fval.reserve(m);
    d.dfdx.reserve(static_cast<std::size_t>(m) * nact);

    if (!min_volume) {
        d.f0 = in.compliance * in.compliance_scale;
        for (int k = 0; k < nact; ++k) d.df0[k] = dc[active[k]] * in.compliance_scale;
        d.fval.push_back((in.vol_used / in.volume_cap) - 1.0);
        for (int k = 0; k < nact; ++k) d.dfdx.push_back(dv[active[k]] / in.volume_cap);
    } else {
        d.f0 = in.vol_used / in.vtotal;
        for (int k = 0; k < nact; ++k) d.df0[k] = dv[active[k]] / in.vtotal;
        if (has_compliance_row) {
            d.fval.push_back((in.compliance / in.compliance_limit) - 1.0);
            for (int k = 0; k < nact; ++k)
                d.dfdx.push_back(dc[active[k]] / in.compliance_limit);
        }
    }
    if (has_stress_row) {
        const std::vector<double>& ds = *in.dstress;
        d.fval.push_back(in.stress_measure - 1.0);
        for (int k = 0; k < nact; ++k) d.dfdx.push_back(ds[active[k]]);
    }
    return d;
}

}  // namespace kofem::topopt
