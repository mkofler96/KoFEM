// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Density/sensitivity filter for SIMP topology optimization — see
// topology_filter.h.

#include "topology_filter.h"

#include "spatial_grid.h"

#include <algorithm>
#include <cmath>
#include <stdexcept>
#include <string>

namespace kofem::topopt {

double mean_element_size(const std::vector<double>& element_volumes) {
    if (element_volumes.empty())
        throw std::runtime_error("mean_element_size: no elements");
    double sum = 0.0;
    for (const double v : element_volumes) {
        if (!(v > 0.0))
            throw std::runtime_error("mean_element_size: non-positive element volume");
        sum += v;
    }
    const double mean_volume = sum / static_cast<double>(element_volumes.size());
    return std::cbrt(mean_volume);
}

double default_filter_radius(const std::vector<double>& element_volumes) {
    return 1.5 * mean_element_size(element_volumes);
}

DensityFilter::DensityFilter(const std::vector<std::array<double, 3>>& centroids,
                             double r_min) {
    if (!(r_min > 0.0))
        throw std::runtime_error("DensityFilter: r_min must be positive");
    const int ne = static_cast<int>(centroids.size());
    if (ne == 0) throw std::runtime_error("DensityFilter: no element centroids");

    // Cell size = r_min keeps each neighbor query to a 3×3×3 cell scan: a centroid
    // within r_min sits at most one cell away on each axis.
    const SpatialGrid grid(centroids, r_min);

    neighbors_.resize(ne);
    row_sum_.assign(ne, 0.0);
    std::vector<int> candidates;
    for (int e = 0; e < ne; ++e) {
        candidates.clear();
        grid.query_radius(centroids[e], r_min, candidates);
        double hs = 0.0;
        for (const int i : candidates) {
            double d2 = 0.0;
            for (int k = 0; k < 3; ++k) {
                const double diff = centroids[e][k] - centroids[i][k];
                d2 += diff * diff;
            }
            const double w = r_min - std::sqrt(d2);
            if (w > 0.0) {
                neighbors_[e].push_back({i, w});
                hs += w;
            }
        }
        row_sum_[e] = hs;  // > 0: the e==i candidate contributes H_ee = r_min.
    }
}

void DensityFilter::filter_sensitivity(const std::vector<double>& rho,
                                       std::vector<double>& sens) const {
    const int ne = num_elements();
    if (static_cast<int>(rho.size()) != ne || static_cast<int>(sens.size()) != ne)
        throw std::runtime_error(
            "DensityFilter::filter_sensitivity: size mismatch (rho " +
            std::to_string(rho.size()) + ", sens " + std::to_string(sens.size()) +
            ", elements " + std::to_string(ne) + ")");

    // d̃c_e = (Σ_i H_ei·ρ_i·dc_i) / (Hs_e · max(ρ_e, γ)). Computed into a fresh
    // buffer so every entry uses the unfiltered neighbors.
    std::vector<double> filtered(ne, 0.0);
    for (int e = 0; e < ne; ++e) {
        double num = 0.0;
        for (const Neighbor& nb : neighbors_[e])
            num += nb.weight * rho[nb.index] * sens[nb.index];
        filtered[e] = num / (row_sum_[e] * std::max(rho[e], kRhoFloor));
    }
    sens.swap(filtered);
}

std::vector<double> DensityFilter::filter_density(const std::vector<double>& rho) const {
    const int ne = num_elements();
    if (static_cast<int>(rho.size()) != ne)
        throw std::runtime_error("DensityFilter::filter_density: size mismatch (rho " +
                                 std::to_string(rho.size()) + ", elements " +
                                 std::to_string(ne) + ")");

    std::vector<double> physical(ne, 0.0);
    for (int e = 0; e < ne; ++e) {
        double num = 0.0;
        for (const Neighbor& nb : neighbors_[e])
            num += nb.weight * rho[nb.index];
        physical[e] = num / row_sum_[e];
    }
    return physical;
}

void DensityFilter::filter_density_sensitivity(std::vector<double>& sens) const {
    const int ne = num_elements();
    if (static_cast<int>(sens.size()) != ne)
        throw std::runtime_error(
            "DensityFilter::filter_density_sensitivity: size mismatch (sens " +
            std::to_string(sens.size()) + ", elements " + std::to_string(ne) + ")");

    // ∂f/∂ρ_j = Σ_i (H_ij/Hs_i)·∂f/∂ρ̃_i. Scatter each row i's contribution to its
    // neighbors j; H_ij is read straight from row i, so no symmetry assumption.
    std::vector<double> chained(ne, 0.0);
    for (int i = 0; i < ne; ++i) {
        const double scaled = sens[i] / row_sum_[i];
        for (const Neighbor& nb : neighbors_[i])
            chained[nb.index] += nb.weight * scaled;
    }
    sens.swap(chained);
}

std::size_t DensityFilter::num_weights() const {
    std::size_t total = 0;
    for (const std::vector<Neighbor>& row : neighbors_) total += row.size();
    return total;
}

}  // namespace kofem::topopt
