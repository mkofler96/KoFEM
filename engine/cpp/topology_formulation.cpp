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
    if (objective == TopOptObjective::MinVolume)
        std::snprintf(buf.data(), buf.size(), "min_volume c_allow=%.6g", compliance_limit);
    else
        std::snprintf(buf.data(), buf.size(), "min_compliance volfrac=%.3f", volume_fraction);
    return buf.data();
}

MmaStepData formulate_mma_step(const FormulationInputs& in) {
    if (in.active == nullptr || in.elem_volume == nullptr || in.dcompliance == nullptr)
        throw std::runtime_error("formulate_mma_step: missing active set, volumes or "
                                 "compliance sensitivities");
    const std::vector<int>& active = *in.active;
    const std::vector<double>& vol = *in.elem_volume;
    const std::vector<double>& dc = *in.dcompliance;
    const int nact = static_cast<int>(active.size());

    MmaStepData d;
    d.df0.resize(nact);
    d.dfdx.resize(nact);

    if (in.objective == TopOptObjective::MinCompliance) {
        d.f0 = in.compliance * in.compliance_scale;
        d.fval = {(in.vol_used / in.volume_cap) - 1.0};
        for (int k = 0; k < nact; ++k) {
            const int e = active[k];
            d.df0[k] = dc[e] * in.compliance_scale;
            d.dfdx[k] = vol[e] / in.volume_cap;
        }
    } else {
        d.f0 = in.vol_used / in.vtotal;
        d.fval = {(in.compliance / in.compliance_limit) - 1.0};
        for (int k = 0; k < nact; ++k) {
            const int e = active[k];
            d.df0[k] = vol[e] / in.vtotal;
            d.dfdx[k] = dc[e] / in.compliance_limit;
        }
    }
    return d;
}

}  // namespace kofem::topopt
