// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Density/sensitivity filter for SIMP topology optimization (KOF-229, Phase A of
// the KOF-226 epic; ADR-0002 decision 5).
//
// Without a filter, SIMP produces checkerboard patterns and mesh-dependent
// designs. This applies a radius-r_min linear ("cone") weighting over element
// centroids — the standard mesh-independence filter of Sigmund, in the form
// written by Andreassen et al. (2011), "Efficient topology optimization in MATLAB
// using 88 lines of code", Struct. Multidisc. Optim. 43:1–16 (their H / Hs).
//
// The neighbor weights are precomputed once per run (the filter is immutable
// after construction) over the shared uniform-grid neighbor search
// (spatial_grid.h) — the fifth caller of the pattern KOF-198 tracks, built on the
// engine's shared primitive rather than a sixth ad-hoc copy.
//
// One symmetric weight matrix H (H_ei = max(0, r_min − ‖x_e − x_i‖)) backs two
// filter modes:
//   * Sensitivity filter (the Phase-A default, ADR-0002): smooth the compliance
//     sensitivity,
//       d̃c/dρ_e = (1/(ρ̂_e·Σ_i H_ei)) · Σ_i H_ei·ρ_i·(dc/dρ_i),   ρ̂_e = max(ρ_e, γ),
//     with γ a small floor (Andreassen use 1e-3) so ρ_e→0 cannot divide by zero.
//   * Density filter (swappable in; Phase-B/stress work prefers it): the physical
//     density is ρ̃_e = (Σ_i H_ei·ρ_i)/Σ_i H_ei, and any objective/constraint
//     sensitivity taken w.r.t. ρ̃ is chained back to the design variable ρ with
//       ∂f/∂ρ_j = Σ_i (H_ij/Σ_k H_ik)·∂f/∂ρ̃_i.
#pragma once

#include <array>
#include <cstddef>
#include <vector>

namespace kofem::topopt {

// Mean element size estimated from per-element volumes as the cube root of the
// mean volume. Throws std::runtime_error on an empty set or a non-positive
// volume.
double mean_element_size(const std::vector<double>& element_volumes);

// Default filter radius r_min ≈ 1.5× the mean element size (ADR-0002 / KOF-229).
double default_filter_radius(const std::vector<double>& element_volumes);

class DensityFilter {
public:
    // Precompute the cone-weight neighbor lists for every element centroid within
    // r_min. r_min is in model length units and must be > 0; `centroids` must be
    // non-empty. Throws std::runtime_error otherwise.
    DensityFilter(const std::vector<std::array<double, 3>>& centroids, double r_min);

    int num_elements() const { return static_cast<int>(row_sum_.size()); }

    // Σ_i H_ei for element e (the "Hs" of Andreassen et al.). Always > 0, because
    // an element is its own neighbor with weight H_ee = r_min.
    double row_sum(int e) const { return row_sum_[e]; }

    // Sensitivity filter (Sigmund): overwrite `sens` (dc/dρ) with its filtered
    // form, given the current densities `rho`. In place; both sizes must equal
    // num_elements().
    void filter_sensitivity(const std::vector<double>& rho,
                            std::vector<double>& sens) const;

    // Density filter: return the physical densities ρ̃ = (Hρ)/Hs for `rho`.
    std::vector<double> filter_density(const std::vector<double>& rho) const;

    // Chain rule for the density filter: overwrite a sensitivity taken w.r.t. the
    // physical density ρ̃ with the sensitivity w.r.t. the design variable ρ.
    void filter_density_sensitivity(std::vector<double>& sens) const;

    // Stored nonzero weights in total, and per-element access to the sparse rows
    // of H — exposed for validation against a reference matrix.
    std::size_t num_weights() const;
    int neighbor_count(int e) const { return static_cast<int>(neighbors_[e].size()); }
    int neighbor_index(int e, int j) const { return neighbors_[e][j].index; }
    double neighbor_weight(int e, int j) const { return neighbors_[e][j].weight; }

private:
    struct Neighbor {
        int index;
        double weight;
    };
    // Floor γ applied to ρ_e in the sensitivity-filter denominator (Andreassen).
    static constexpr double kRhoFloor = 1e-3;

    std::vector<std::vector<Neighbor>> neighbors_;  // H in sparse row form
    std::vector<double> row_sum_;                   // Hs_e = Σ_i H_ei
};

}  // namespace kofem::topopt
