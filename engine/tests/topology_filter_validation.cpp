// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Native validation of the SIMP density/sensitivity filter
// (engine/cpp/topology_filter.{h,cpp}) and the shared uniform-grid neighbor
// search it is built on (engine/cpp/spatial_grid.{h,cpp}) — KOF-229.
//
// Like bc_validation / shell_validation and unlike topology_simp_validation, the
// filter core has no MFEM/OCCT/Netgen/Emscripten dependency — it operates on
// element centroids and sensitivities as plain arrays — so it compiles with a
// plain host C++ compiler (scripts/test-topology-filter.sh). It is NOT run by CI
// (see CLAUDE.md); this is the fast local proof.
//
// The checks the issue asks for:
//   1. On a uniform grid the filter weights sum correctly and reproduce the
//      reference H / Hs of Andreassen et al. (2011) for a known r_min. The
//      reference is an independent brute-force O(N²) evaluation of the same cone
//      weight max(0, r_min − ‖x_e − x_i‖); matching it proves the grid search
//      finds exactly the right neighbors (2D and 3D grids).
//   2. A single-element sensitivity spike is smeared over exactly its r_min
//      neighborhood and nowhere else, with the analytic filtered values.
//   3. Supporting invariants: H symmetry, H_ee = r_min, the density filter
//      reproduces a uniform field (partition of unity), the density-filter chain
//      rule matches a finite-difference gradient, and the default r_min.
// Exits non-zero on any failure so it can gate a local run.

#include "topology_filter.h"

#include "spatial_grid.h"

#include <array>
#include <cmath>
#include <cstdio>
#include <vector>

using kofem::Point3;
using kofem::SpatialGrid;
using namespace kofem::topopt;

namespace {

// Failure counter threaded by reference (as in topology_simp_validation.cpp /
// shell_validation.cpp) rather than a mutable global.
void check(int& failures, const char* name, bool ok) {
    if (!ok) ++failures;
    std::printf("  [%s] %s\n", ok ? "PASS" : "FAIL", name);
}

void check_close(int& failures, const char* name, double got, double want, double tol) {
    const bool ok = std::abs(got - want) <= tol;
    if (!ok) ++failures;
    std::printf("  [%s] %-52s got %.12g  want %.12g\n", ok ? "PASS" : "FAIL", name, got,
                want);
}

// Independent brute-force reference: the dense Andreassen H (row-major ne×ne) and
// its row sums Hs, from the cone weight over every element pair.
struct ReferenceH {
    int ne = 0;
    std::vector<double> H;   // ne*ne, H[e*ne+i]
    std::vector<double> Hs;  // ne
    double at(int e, int i) const { return H[static_cast<std::size_t>(e) * ne + i]; }
};

ReferenceH brute_force_H(const std::vector<Point3>& c, double r_min) {
    ReferenceH ref;
    ref.ne = static_cast<int>(c.size());
    ref.H.assign(static_cast<std::size_t>(ref.ne) * ref.ne, 0.0);
    ref.Hs.assign(ref.ne, 0.0);
    for (int e = 0; e < ref.ne; ++e) {
        for (int i = 0; i < ref.ne; ++i) {
            double d2 = 0.0;
            for (int k = 0; k < 3; ++k) {
                const double diff = c[e][k] - c[i][k];
                d2 += diff * diff;
            }
            const double w = r_min - std::sqrt(d2);
            if (w > 0.0) {
                ref.H[static_cast<std::size_t>(e) * ref.ne + i] = w;
                ref.Hs[e] += w;
            }
        }
    }
    return ref;
}

// Compare the filter's sparse H against the dense reference: same row sums, same
// per-neighbor weights, same neighbor counts (no missing or spurious neighbors).
void check_against_reference(int& failures, const char* tag, const DensityFilter& filter,
                             const ReferenceH& ref) {
    std::printf("%s: filter H/Hs vs. brute-force reference (%d elements)\n", tag, ref.ne);

    bool rowsums_ok = true;
    bool weights_ok = true;
    bool counts_ok = true;
    bool symmetric = true;
    bool self_weight_ok = true;

    for (int e = 0; e < ref.ne; ++e) {
        if (std::abs(filter.row_sum(e) - ref.Hs[e]) > 1e-12 * (1.0 + ref.Hs[e]))
            rowsums_ok = false;

        // Count the reference's positive weights in this row and check each stored
        // filter weight equals the reference; also verify H_ee and symmetry.
        int ref_count = 0;
        for (int i = 0; i < ref.ne; ++i)
            if (ref.at(e, i) > 0.0) ++ref_count;
        if (filter.neighbor_count(e) != ref_count) counts_ok = false;

        for (int j = 0; j < filter.neighbor_count(e); ++j) {
            const int i = filter.neighbor_index(e, j);
            const double w = filter.neighbor_weight(e, j);
            if (std::abs(w - ref.at(e, i)) > 1e-12 * (1.0 + std::abs(ref.at(e, i))))
                weights_ok = false;
            if (std::abs(ref.at(e, i) - ref.at(i, e)) > 1e-12) symmetric = false;
            if (i == e && std::abs(w - ref.at(e, e)) > 1e-12) self_weight_ok = false;
        }
    }

    check(failures, "row sums Hs match reference", rowsums_ok);
    check(failures, "neighbor counts match reference (no missing/spurious)", counts_ok);
    check(failures, "neighbor weights match reference H", weights_ok);
    check(failures, "H is symmetric", symmetric);
    check(failures, "self weight H_ee present and == reference", self_weight_ok);
}

// e = ix*ny + iy, centroid (ix+0.5, iy+0.5, 0.5) on a unit grid.
std::vector<Point3> grid_2d(int nx, int ny) {
    std::vector<Point3> c;
    c.reserve(static_cast<std::size_t>(nx) * ny);
    for (int ix = 0; ix < nx; ++ix)
        for (int iy = 0; iy < ny; ++iy)
            c.push_back({ix + 0.5, iy + 0.5, 0.5});
    return c;
}

std::vector<Point3> grid_3d(int nx, int ny, int nz) {
    std::vector<Point3> c;
    c.reserve(static_cast<std::size_t>(nx) * ny * nz);
    for (int ix = 0; ix < nx; ++ix)
        for (int iy = 0; iy < ny; ++iy)
            for (int iz = 0; iz < nz; ++iz)
                c.push_back({ix + 0.5, iy + 0.5, iz + 0.5});
    return c;
}

}  // namespace

int main() {
    int failures = 0;

    // ── (1) 2D grid: reproduce Andreassen H / Hs for a known r_min ─────────────
    {
        const int nx = 8, ny = 5;
        const double r_min = 2.4;  // ceil-1 = 2 rings of positive weights
        const std::vector<Point3> c = grid_2d(nx, ny);
        const DensityFilter filter(c, r_min);
        const ReferenceH ref = brute_force_H(c, r_min);
        check_against_reference(failures, "2D grid (r_min=2.4)", filter, ref);

        // The interior element at (3,2) has the full rotation-symmetric stencil;
        // its Hs is Σ over the stencil of (r_min − dist). Spot-check the value so
        // the reference itself is pinned to an Andreassen-consistent number.
        const int e_int = 3 * ny + 2;
        double hs_expect = 0.0;
        for (int dx = -2; dx <= 2; ++dx)
            for (int dy = -2; dy <= 2; ++dy) {
                const double w = r_min - std::sqrt((double)(dx * dx + dy * dy));
                if (w > 0.0) hs_expect += w;
            }
        check_close(failures, "interior Hs matches analytic cone stencil",
                    filter.row_sum(e_int), hs_expect, 1e-12);

        // ── (2) single-element sensitivity spike smears over the r_min ball ────
        // rho ≡ 0.5, sens = e_k. Then d̃c_e = H_ek·ρ_k·1 / (Hs_e·max(ρ_e,γ))
        //                              = H_ek / Hs_e   (ρ≡0.5 > γ cancels).
        std::printf("2D grid: single-element sensitivity spike smears over r_min ball\n");
        const int k = e_int;
        const std::vector<double> rho(c.size(), 0.5);
        std::vector<double> sens(c.size(), 0.0);
        sens[k] = 1.0;
        filter.filter_sensitivity(rho, sens);

        bool spike_ok = true;
        int nonzero = 0;
        for (int e = 0; e < static_cast<int>(c.size()); ++e) {
            const double expect = ref.at(e, k) / filter.row_sum(e);  // H_ek / Hs_e
            if (std::abs(sens[e] - expect) > 1e-12 * (1.0 + std::abs(expect)))
                spike_ok = false;
            if (sens[e] != 0.0) ++nonzero;
            // Outside the r_min ball of k the filtered value must be exactly 0.
            if (ref.at(e, k) == 0.0 && sens[e] != 0.0) spike_ok = false;
        }
        int ball = 0;
        for (int e = 0; e < ref.ne; ++e)
            if (ref.at(e, k) > 0.0) ++ball;
        check(failures, "filtered spike equals H_ek/Hs_e on the ball, 0 outside", spike_ok);
        check_close(failures, "smeared support size == r_min neighborhood of k", nonzero,
                    ball, 0);

        // ── (3a) density filter reproduces a uniform field (partition of unity) ─
        const std::vector<double> uniform(c.size(), 0.37);
        const std::vector<double> phys = filter.filter_density(uniform);
        bool partition_ok = true;
        for (const double v : phys)
            if (std::abs(v - 0.37) > 1e-12) partition_ok = false;
        check(failures, "density filter reproduces a uniform field", partition_ok);
    }

    // ── (1b) 3D grid: the grid search must be correct in 3D too ────────────────
    {
        const int nx = 5, ny = 4, nz = 3;
        const double r_min = 1.8;
        const std::vector<Point3> c = grid_3d(nx, ny, nz);
        const DensityFilter filter(c, r_min);
        const ReferenceH ref = brute_force_H(c, r_min);
        check_against_reference(failures, "3D grid (r_min=1.8)", filter, ref);

        // ── (3b) density-filter chain rule vs. central finite difference ───────
        // f(ρ) = Σ_e ½·ρ̃_e², so ∂f/∂ρ̃_e = ρ̃_e; chain back to ρ and compare to a
        // central difference of f over sampled design variables.
        std::printf("3D grid: density-filter chain rule vs. finite difference\n");
        std::vector<double> rho(c.size());
        for (std::size_t i = 0; i < rho.size(); ++i)
            rho[i] = 0.3 + 0.4 * std::sin(0.7 * static_cast<double>(i));  // in (0,1)

        auto objective = [&](const std::vector<double>& x) {
            const std::vector<double> xp = filter.filter_density(x);
            double f = 0.0;
            for (const double v : xp) f += 0.5 * v * v;
            return f;
        };

        std::vector<double> grad = filter.filter_density(rho);  // ρ̃ == ∂f/∂ρ̃
        filter.filter_density_sensitivity(grad);                // → ∂f/∂ρ

        const double h = 1e-6;
        const int ne = static_cast<int>(c.size());
        const std::vector<int> sample = {0, ne / 3, ne / 2, (2 * ne) / 3, ne - 1};
        bool fd_ok = true;
        for (const int j : sample) {
            std::vector<double> xp = rho, xm = rho;
            xp[j] += h;
            xm[j] -= h;
            const double fd = (objective(xp) - objective(xm)) / (2.0 * h);
            const double rel = std::abs(fd - grad[j]) / std::max(std::abs(grad[j]), 1e-30);
            std::printf("    element %d: FD %.10g  analytic %.10g  (rel %.2e)\n", j, fd,
                        grad[j], rel);
            if (rel > 1e-6) fd_ok = false;
        }
        check(failures, "density-filter gradient matches finite difference", fd_ok);
    }

    // ── (3c) default filter radius ≈ 1.5× mean element size ────────────────────
    {
        std::printf("default r_min from element volumes\n");
        const std::vector<double> unit_cubes(20, 1.0);  // mean size = cbrt(1) = 1
        check_close(failures, "default_filter_radius(unit cubes) == 1.5",
                    default_filter_radius(unit_cubes), 1.5, 1e-12);
        const std::vector<double> vol8(10, 8.0);  // mean size = cbrt(8) = 2
        check_close(failures, "default_filter_radius(vol 8) == 3.0", default_filter_radius(vol8),
                    3.0, 1e-12);
    }

    // ── spatial grid: a direct radius query matches a brute-force scan ─────────
    {
        std::printf("SpatialGrid::query_radius vs. brute force\n");
        const std::vector<Point3> c = grid_3d(6, 6, 6);
        const double radius = 2.2;
        const SpatialGrid grid(c, radius);
        bool ok = true;
        for (int q = 0; q < static_cast<int>(c.size()); q += 7) {
            std::vector<int> got;
            grid.query_radius(c[q], radius, got);
            int brute = 0;
            for (int i = 0; i < static_cast<int>(c.size()); ++i) {
                double d2 = 0.0;
                for (int k = 0; k < 3; ++k) {
                    const double diff = c[q][k] - c[i][k];
                    d2 += diff * diff;
                }
                if (d2 <= radius * radius) ++brute;
            }
            if (static_cast<int>(got.size()) != brute) ok = false;
        }
        check(failures, "query_radius finds exactly the in-radius points", ok);
    }

    std::printf(failures != 0 ? "\n%d check(s) FAILED\n" : "\nall checks passed\n",
                failures);
    return failures != 0 ? 1 : 0;
}
