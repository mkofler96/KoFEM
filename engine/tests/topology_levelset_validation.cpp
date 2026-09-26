// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Native validation of the reaction–diffusion level-set optimizer
// (engine/cpp/topology_levelset.{h,cpp}).
//
// Links MFEM and runs under node via Emscripten
// (scripts/test-topology-levelset.sh). It is NOT run by CI (see CLAUDE.md).
//
// Checks:
//   1. The exact tet volume fraction of {φ > 0}: the four sign patterns, the
//      complement identity f(φ) + f(−φ) = 1, and the Kuhn split of a hex.
//   2. On the MBB half-beam of topology_optimize_validation.cpp: the volume
//      constraint is met, the run converges, and the design is far crisper than
//      SIMP's (only the elements the φ = 0 surface cuts through are gray).
//   3. Its compliance is competitive with the SIMP optimum at the same volume.
//   4. The level set is returned per vertex, bounded to [−1, 1], and its element
//      volume fractions are exactly the returned density.
//   5. Passive solid/void regions are honoured; the stream ends on the returned
//      density; identical inputs give identical designs.
// Exits non-zero on any failure.

#include "topology_filter.h"
#include "topology_levelset.h"
#include "topology_optimize.h"
#include "topology_simp_core.h"

#include <mfem.hpp>

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdio>
#include <stdexcept>
#include <vector>

using namespace kofem::topopt;

namespace {

constexpr int dim = 3;

void check(int& failures, const char* name, bool ok) {
    if (!ok) ++failures;
    std::printf("  [%s] %s\n", ok ? "PASS" : "FAIL", name);
}

bool near(double a, double b, double tol = 1e-12) { return std::abs(a - b) <= tol; }

// The MBB half-beam of topology_optimize_validation.cpp: a thin slab, u_z ≡ 0,
// symmetry on x = 0, roller at the bottom-right edge, load at the top of x = 0.
struct Model {
    mfem::Mesh mesh;
    mfem::H1_FECollection fec{1, dim};
    mfem::FiniteElementSpace fespace;
    mfem::Array<int> ess_tdof;
    mfem::LinearForm load;
    ElementStiffnessCache cache;

    Model(double lx, double ly, double lz, int nx, int ny, int nz)
        : mesh(mfem::Mesh::MakeCartesian3D(nx, ny, nz, mfem::Element::TETRAHEDRON, lx, ly,
                                           lz)),
          fespace(&mesh, &fec, dim),
          load(&fespace) {
        const double tol = 1e-9;
        for (int vi = 0; vi < mesh.GetNV(); ++vi) {
            const double* xv = mesh.GetVertex(vi);
            mfem::Array<int> vdofs;
            fespace.GetVertexVDofs(vi, vdofs);
            ess_tdof.Append(vdofs[2]);
            if (xv[0] < tol) ess_tdof.Append(vdofs[0]);
            if (xv[0] > lx - tol && xv[1] < tol) ess_tdof.Append(vdofs[1]);
        }
        ess_tdof.Sort();
        ess_tdof.Unique();

        load = 0.0;
        std::vector<int> load_vertices;
        for (int vi = 0; vi < mesh.GetNV(); ++vi) {
            const double* xv = mesh.GetVertex(vi);
            if (xv[0] < tol && xv[1] > ly - tol) load_vertices.push_back(vi);
        }
        for (const int vi : load_vertices) {
            mfem::Array<int> vdofs;
            fespace.GetVertexVDofs(vi, vdofs);
            load[vdofs[1]] -= 1.0 / static_cast<double>(load_vertices.size());
        }
        cache = build_element_stiffness_cache(fespace, 1.0, 0.3);
    }

    std::vector<int> elements_in_box(const std::array<double, 3>& lo,
                                     const std::array<double, 3>& hi) const {
        std::vector<int> out;
        for (int e = 0; e < static_cast<int>(cache.centroid.size()); ++e) {
            const std::array<double, 3>& c = cache.centroid[e];
            if (c[0] >= lo[0] && c[0] <= hi[0] && c[1] >= lo[1] && c[1] <= hi[1] &&
                c[2] >= lo[2] && c[2] <= hi[2])
                out.push_back(e);
        }
        return out;
    }
};

LevelSetOptConfig base_config() {
    LevelSetOptConfig cfg;
    cfg.volume_fraction = 0.5;
    cfg.regularization_length = 0.0;  // default: the mean element size
    cfg.max_iterations = 120;
    cfg.tolerance = 0.01;
    return cfg;
}

}  // namespace

int main() {
    int failures = 0;

    // ── (1) Exact tet volume fraction ─────────────────────────────────────────
    std::printf("Tet volume fraction of {phi > 0}:\n");
    check(failures, "all positive -> 1", near(tet_positive_fraction({1, 2, 3, 4}), 1.0));
    check(failures, "all non-positive -> 0",
          near(tet_positive_fraction({-1, -2, 0, -4}), 0.0));
    check(failures, "one positive corner at the edge midpoints -> 1/8",
          near(tet_positive_fraction({1, -1, -1, -1}), 0.125));
    check(failures, "three positive -> 7/8",
          near(tet_positive_fraction({-1, 1, 1, 1}), 0.875));
    check(failures, "two and two, symmetric -> 1/2",
          near(tet_positive_fraction({1, 1, -1, -1}), 0.5));
    {
        // Linear φ = x − 0.3 on the reference tet: vol{x > 0.3} = (0.7)^3.
        const double f = tet_positive_fraction({-0.3, 0.7, -0.3, -0.3});
        check(failures, "linear field x > 0.3 -> 0.7^3", near(f, 0.343, 1e-12));
    }
    {
        bool complement = true;
        std::array<std::array<double, 4>, 5> samples{{{0.3, -0.7, 0.1, -0.2},
                                                      {0.9, 0.4, -0.05, -0.6},
                                                      {-0.2, 0.8, -0.9, 0.35},
                                                      {0.01, -0.02, 0.03, -0.04},
                                                      {1.0, 1.0, -1.0, 0.5}}};
        for (const std::array<double, 4>& s : samples) {
            const std::array<double, 4> neg{-s[0], -s[1], -s[2], -s[3]};
            const double sum = tet_positive_fraction(s) + tet_positive_fraction(neg);
            if (!near(sum, 1.0, 1e-12)) {
                complement = false;
                std::printf("    f(phi) + f(-phi) = %.15g for {%g, %g, %g, %g}\n", sum, s[0],
                            s[1], s[2], s[3]);
            }
        }
        check(failures, "f(phi) + f(-phi) = 1 on mixed-sign samples", complement);
    }
    {
        mfem::Mesh hex = mfem::Mesh::MakeCartesian3D(1, 1, 1, mfem::Element::HEXAHEDRON);
        std::vector<double> phi(hex.GetNV());
        for (int i = 0; i < hex.GetNV(); ++i) phi[i] = hex.GetVertex(i)[0] - 0.25;
        const std::vector<double> rho = level_set_density(hex, phi);
        check(failures, "hex (Kuhn split) is exact for a linear field: x > 0.25 -> 0.75",
              rho.size() == 1 && near(rho[0], 0.75, 1e-12));
    }

    // ── (2)–(4) MBB half-beam ─────────────────────────────────────────────────
    Model model(6.0, 2.0, 1.0 / 3.0, 36, 12, 1);
    const int ne = model.fespace.GetNE();
    const int nv = model.mesh.GetNV();
    std::printf("\nMBB half-beam: %d elements, %d vertices\n", ne, nv);
    double vtotal = 0.0;
    for (const double v : model.cache.volume) vtotal += v;

    const LevelSetOptResult res = optimize_level_set(model.fespace, model.cache,
                                                     model.ess_tdof, model.load, base_config());
    const TopOptHistoryEntry& last = res.history.back();
    std::printf("  %d iterations, %s; final c=%.6g vol=%.4f\n", res.iterations,
                res.converged ? "converged" : "hit max_iterations", last.compliance,
                last.volume);
    check(failures, "converged within the iteration budget", res.converged);
    check(failures, "volume constraint met to < 1%",
          std::abs(last.volume - base_config().volume_fraction) < 0.01);
    check(failures, "started from full material",
          near(res.history.front().volume, 1.0, 1e-12));

    // SIMP reference at the same volume fraction and length scale.
    ComplianceOptConfig scfg;
    scfg.volume_fraction = 0.5;
    scfg.filter_radius = 1.5 * mean_element_size(model.cache.volume);
    scfg.max_iterations = 120;
    const ComplianceOptResult simp =
        optimize_compliance(model.fespace, model.cache, model.ess_tdof, model.load, scfg);

    // Grayness Σ 4ρ(1−ρ)·V_e / V: 0 for a black-and-white design, 1 for uniform
    // ρ = 0.5. A level-set design is gray only in the elements its boundary cuts.
    auto grayness = [&](const std::vector<double>& rho) {
        double g = 0.0;
        for (int e = 0; e < ne; ++e) g += 4.0 * rho[e] * (1.0 - rho[e]) * model.cache.volume[e];
        return g / vtotal;
    };
    const double g_ls = grayness(res.density);
    const double g_simp = grayness(simp.density);
    std::printf("  grayness: level set %.3f, SIMP %.3f\n", g_ls, g_simp);
    // On this coarse slab the members are one or two elements thick, so the cut
    // elements alone are a sizeable share; the smooth shape comes from drawing the
    // φ = 0 surface, not from the element densities.
    check(failures, "level-set design is crisper than SIMP", g_ls < g_simp);

    // Compare each design as its own loop reports it (SIMP's p = 3 compliance of
    // its gray field, the level set's ersatz compliance of its cut elements).
    const double c_simp = simp.history.back().compliance;
    std::printf("  SIMP reference: c=%.6g (level set / SIMP = %.3f)\n", c_simp,
                last.compliance / c_simp);
    check(failures, "level-set compliance within 15% of the SIMP optimum",
          last.compliance < 1.15 * c_simp);

    check(failures, "level set returned per vertex",
          static_cast<int>(res.level_set.size()) == nv);
    bool bounded = true;
    for (const double p : res.level_set)
        if (!(p >= -1.0 && p <= 1.0)) bounded = false;
    check(failures, "level set bounded to [-1, 1]", bounded);
    {
        const std::vector<double> rho = level_set_density(model.mesh, res.level_set);
        bool same = rho.size() == res.density.size();
        for (std::size_t e = 0; same && e < rho.size(); ++e)
            if (rho[e] != res.density[e]) same = false;
        check(failures, "returned density is the volume fraction of the returned level set",
              same);
        double vol = 0.0;
        for (int e = 0; e < ne; ++e) vol += res.density[e] * model.cache.volume[e];
        check(failures, "returned design is the one the final history entry describes",
              near(vol / vtotal, last.volume, 1e-12));
    }

    // ── (5) Passive regions, streaming, determinism, validation ───────────────
    std::printf("\nPassive regions:\n");
    {
        LevelSetOptConfig cfg = base_config();
        cfg.passive_solid = model.elements_in_box({1.0, 1.2, -1.0}, {2.5, 2.0, 1.0});
        cfg.passive_void = model.elements_in_box({3.3, 0.7, -1.0}, {4.2, 1.3, 1.0});
        const LevelSetOptResult pres = optimize_level_set(model.fespace, model.cache,
                                                          model.ess_tdof, model.load, cfg);
        bool solid_ok = !cfg.passive_solid.empty();
        for (const int e : cfg.passive_solid)
            if (pres.density[e] != 1.0) solid_ok = false;
        bool void_ok = !cfg.passive_void.empty();
        for (const int e : cfg.passive_void)
            if (pres.density[e] != 0.0) void_ok = false;
        check(failures, "passive-solid elements stay fully solid", solid_ok);
        check(failures, "passive-void elements stay fully void", void_ok);
        check(failures, "volume constraint still met with passive regions",
              std::abs(pres.history.back().volume - cfg.volume_fraction) < 0.01);
    }

    std::printf("\nStreaming and determinism:\n");
    {
        LevelSetOptConfig cfg = base_config();
        cfg.stream.stream_every = 4;
        std::vector<int> its;
        std::vector<double> last_rho;
        cfg.stream.on_density = [&](int it, const std::vector<double>& rho) {
            its.push_back(it);
            last_rho = rho;
        };
        const LevelSetOptResult sres = optimize_level_set(model.fespace, model.cache,
                                                          model.ess_tdof, model.load, cfg);
        check(failures, "always streams the final iteration",
              !its.empty() && its.back() == sres.iterations);
        check(failures, "last streamed density equals the returned density",
              last_rho == sres.density);
        check(failures, "identical inputs give an identical design",
              sres.density == res.density && sres.level_set == res.level_set);
    }

    std::printf("\nInput validation:\n");
    auto throws = [&](const LevelSetOptConfig& cfg) {
        try {
            optimize_level_set(model.fespace, model.cache, model.ess_tdof, model.load, cfg);
        } catch (const std::runtime_error&) {
            return true;
        }
        return false;
    };
    {
        LevelSetOptConfig bad = base_config();
        bad.volume_fraction = 0.0;
        check(failures, "volume fraction 0 is rejected", throws(bad));
    }
    {
        LevelSetOptConfig bad = base_config();
        bad.max_iterations = 0;
        check(failures, "max_iterations 0 is rejected", throws(bad));
    }
    {
        LevelSetOptConfig bad = base_config();
        // Two blocks either side of the grid plane x = 7/3: the tets touching the
        // plane from both sides share its vertices.
        bad.passive_solid = model.elements_in_box({2.0, 0.5, -1.0}, {7.0 / 3.0, 0.9, 1.0});
        bad.passive_void = model.elements_in_box({7.0 / 3.0, 0.5, -1.0}, {2.6, 0.9, 1.0});
        check(failures, "adjacent passive solid/void sharing vertices is rejected",
              !bad.passive_solid.empty() && !bad.passive_void.empty() && throws(bad));
    }

    std::printf("\n%s: %d failure(s)\n", failures == 0 ? "OK" : "FAILED", failures);
    return failures == 0 ? 0 : 1;
}
