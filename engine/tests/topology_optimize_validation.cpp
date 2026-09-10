// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Native validation of the SIMP minimum-compliance loop
// (engine/cpp/topology_optimize.{h,cpp}) driving the MMA optimizer
// (topology_mma.{h,cpp}), the SIMP core (topology_simp_core.{h,cpp}) and the
// filter (topology_filter.{h,cpp}) end to end — KOF-230, Phase A of KOF-226.
//
// Like topology_simp_validation and unlike the filter/MMA tests, the loop solves a
// real elastic problem every iteration, so this links MFEM and runs under node via
// Emscripten (scripts/test-topology-optimize.sh). It is NOT run by CI (see
// CLAUDE.md); the visual "textbook truss" layout is validated properly in KOF-234.
// This is the fast local proof of the trajectory the issue asks for.
//
// The problem is a tiny 2D-in-3D MBB half-beam: a thin slab meshed into tets, with
// out-of-plane motion fully suppressed (u_z ≡ 0) so it behaves as 2D. The left face
// is the symmetry plane (u_x = 0), the bottom-right edge is a roller (u_y = 0), and
// a downward load sits at the top of the symmetry edge — the standard MBB half
// model.
//
// The checks the issue asks for:
//   1. The volume constraint is met to < 1% (final Σρ_e·V_e ≈ volfrac·V_total).
//   2. Compliance decreases: far below the uniform-density start and monotonically
//      non-increasing over the tail — the design is stiffening, not oscillating.
//   3. A topology actually emerges (material concentrates: some elements → solid,
//      some → void), rather than the run stalling at the uniform gray field.
//   4. Fixed/passive elements are honoured: ρ pinned to 1 stays exactly solid and
//      ρ pinned to rho_min stays exactly void, and the constraint is still met.
//   5. The loop is deterministic and respects max_iterations.
// Exits non-zero on any failure so it can gate a local run.

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

// The fixed MBB half-beam FE model, built once and shared across cases.
struct Model {
    mfem::Mesh mesh;
    mfem::H1_FECollection fec{1, dim};
    mfem::FiniteElementSpace fespace;
    mfem::Array<int> ess_tdof;
    mfem::LinearForm load;
    ElementStiffnessCache cache;

    double Lx, Ly, Lz;

    Model(double lx, double ly, double lz, int nx, int ny, int nz)
        : mesh(mfem::Mesh::MakeCartesian3D(nx, ny, nz, mfem::Element::TETRAHEDRON, lx, ly,
                                           lz)),
          fespace(&mesh, &fec, dim),
          load(&fespace),
          Lx(lx),
          Ly(ly),
          Lz(lz) {
        const double tol = 1e-9;

        // Essential DOFs: u_z ≡ 0 everywhere (2D-in-3D), u_x = 0 on the symmetry
        // face x=0, u_y = 0 on the bottom-right roller edge (x=Lx, y=0).
        for (int vi = 0; vi < mesh.GetNV(); ++vi) {
            const double* xv = mesh.GetVertex(vi);
            mfem::Array<int> vdofs;
            fespace.GetVertexVDofs(vi, vdofs);
            ess_tdof.Append(vdofs[2]);  // u_z
            if (xv[0] < tol) ess_tdof.Append(vdofs[0]);  // symmetry: u_x
            if (xv[0] > Lx - tol && xv[1] < tol) ess_tdof.Append(vdofs[1]);  // roller: u_y
        }
        ess_tdof.Sort();
        ess_tdof.Unique();

        // Downward unit load spread over the top of the symmetry edge (x=0, y=Ly).
        load = 0.0;
        std::vector<int> load_vertices;
        for (int vi = 0; vi < mesh.GetNV(); ++vi) {
            const double* xv = mesh.GetVertex(vi);
            if (xv[0] < tol && xv[1] > Ly - tol) load_vertices.push_back(vi);
        }
        for (const int vi : load_vertices) {
            mfem::Array<int> vdofs;
            fespace.GetVertexVDofs(vi, vdofs);
            load[vdofs[1]] -= 1.0 / static_cast<double>(load_vertices.size());
        }

        cache = build_element_stiffness_cache(fespace, 1.0 /*E0*/, 0.3 /*nu*/);
    }

    // Element indices whose centroid lies in the axis-aligned box [lo, hi].
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

ComplianceOptConfig base_config() {
    ComplianceOptConfig cfg;
    cfg.volume_fraction = 0.5;
    cfg.penalty = 3.0;
    cfg.filter_radius = 0.6;  // ~1.8 element spacings — strong mesh-independence
    cfg.move_limit = 0.2;
    cfg.max_iterations = 60;
    cfg.tolerance = 0.01;
    return cfg;
}

}  // namespace

int main() {
    int failures = 0;

    Model model(6.0, 2.0, 1.0 / 3.0, 18, 6, 1);
    std::printf("MBB half-beam: %d elements, %d dofs\n\n", model.fespace.GetNE(),
                model.fespace.GetTrueVSize());

    // ── Baseline optimization ─────────────────────────────────────────────────
    std::printf("Baseline min-compliance run (volfrac=0.5):\n");
    const ComplianceOptResult res = optimize_compliance(
        model.fespace, model.cache, model.ess_tdof, model.load, base_config());

    const int niter = static_cast<int>(res.history.size());
    check(failures, "produced an iteration history", niter > 0);
    check(failures, "respected max_iterations", niter <= base_config().max_iterations);
    check(failures, "converged on the tolerance within the iteration budget",
          res.converged);

    // (1) Volume constraint met to < 1%.
    const double vol_final = res.history.back().volume;
    std::printf("  final volume fraction = %.5f (target %.5f)\n", vol_final,
                base_config().volume_fraction);
    check(failures, "volume constraint met to < 1%",
          std::abs(vol_final - base_config().volume_fraction) < 0.01);

    // (2) Compliance decreases far below the start and is non-increasing on the tail.
    const double c0 = res.history.front().compliance;
    const double cN = res.history.back().compliance;
    std::printf("  compliance: start %.6g  end %.6g  (ratio %.3f)\n", c0, cN, cN / c0);
    check(failures, "final compliance well below the uniform-density start",
          cN < 0.75 * c0);
    bool tail_monotone = true;
    double worst_rise = 0.0;
    for (int i = 6; i + 1 < niter; ++i) {
        const double a = res.history[i].compliance;
        const double b = res.history[i + 1].compliance;
        if (b > a) worst_rise = std::max(worst_rise, (b - a) / a);
        if (b > a * 1.02) tail_monotone = false;  // allow ≤2% MMA wiggle
    }
    std::printf("  worst compliance rise after it 6: %.3e (relative)\n", worst_rise);
    check(failures, "compliance is non-increasing (≤2% wiggle) after the transient",
          tail_monotone);

    // (3) A topology emerges: material redistributes from the uniform ρ≡volfrac
    // start toward both extremes. (Crispness is not asserted — the Phase-A
    // sensitivity filter deliberately leaves intermediate densities; the clean
    // black-and-white layout is the visual validation in KOF-234.) The uniform-gray
    // stall failure mode is exactly zero spread, so the population standard
    // deviation cleanly separates a real topology from a stalled run.
    int near_solid = 0;
    int near_void = 0;
    double mean = 0.0;
    for (const double r : res.density) {
        mean += r;
        if (r > 0.9) ++near_solid;
        if (r < 0.1) ++near_void;
    }
    mean /= static_cast<double>(res.density.size());
    double var = 0.0;
    for (const double r : res.density) var += (r - mean) * (r - mean);
    const double stddev = std::sqrt(var / static_cast<double>(res.density.size()));
    std::printf("  density: %d solid, %d void, mean %.3f, std %.3f (of %d elements)\n",
                near_solid, near_void, mean, stddev, static_cast<int>(res.density.size()));
    check(failures, "material concentrated into solid regions", near_solid > 0);
    check(failures, "material cleared into void regions", near_void > 0);
    check(failures, "density spread away from the uniform gray start (std > 0.1)",
          stddev > 0.1);

    // (3b) The returned density IS the analysed design: re-evaluating it reproduces
    // the final history entry's compliance and volume exactly (guards against the
    // returned density being one un-analysed MMA step ahead of its reported metrics).
    {
        double vtotal = 0.0;
        for (const double v : model.cache.volume) vtotal += v;
        double vfin = 0.0;
        for (int e = 0; e < model.fespace.GetNE(); ++e)
            vfin += res.density[e] * model.cache.volume[e];
        const ComplianceEvaluation ev_final = evaluate_compliance(
            model.fespace, model.cache, model.ess_tdof, model.load, res.density,
            base_config().penalty, base_config().emin_rel, base_config().cg_rtol);
        std::printf("  re-evaluated returned density: c=%.6g (history %.6g), vol=%.5f\n",
                    ev_final.compliance, res.history.back().compliance, vfin / vtotal);
        check(failures, "returned density's compliance matches the final history entry",
              std::abs(ev_final.compliance - res.history.back().compliance) <=
                  1e-9 * std::abs(res.history.back().compliance));
        check(failures, "returned density's volume matches the final history entry",
              std::abs((vfin / vtotal) - res.history.back().volume) < 1e-9);
    }

    // ── (4) Passive elements: pinned solid stays 1, pinned void stays rho_min ──
    std::printf("\nPassive regions (keep-in solid + keep-out void):\n");
    ComplianceOptConfig pcfg = base_config();
    pcfg.rho_min = 1e-3;
    // Both boxes sit in the interior, clear of the symmetry face (x=0), the roller
    // corner (x=Lx, y=0) and the load (x=0, y=Ly) — voiding a support would create
    // a near-mechanism, not a valid design. Keep-in: an upper-left block; keep-out:
    // a central block.
    const std::vector<int> solid_box =
        model.elements_in_box({1.0, 1.2, -1.0}, {2.5, 2.0, 1.0});
    const std::vector<int> void_box =
        model.elements_in_box({3.0, 0.6, -1.0}, {4.5, 1.4, 1.0});
    pcfg.passive_solid = solid_box;
    pcfg.passive_void = void_box;
    std::printf("  pinned %d elements solid, %d elements void\n",
                static_cast<int>(solid_box.size()), static_cast<int>(void_box.size()));
    check(failures, "the keep-in region is non-empty", !solid_box.empty());
    check(failures, "the keep-out region is non-empty", !void_box.empty());

    const ComplianceOptResult pres = optimize_compliance(
        model.fespace, model.cache, model.ess_tdof, model.load, pcfg);

    bool solid_pinned = true;
    for (const int e : solid_box)
        if (pres.density[e] != 1.0) solid_pinned = false;
    bool void_pinned = true;
    for (const int e : void_box)
        if (pres.density[e] != pcfg.rho_min) void_pinned = false;
    check(failures, "ρ pinned to 1 stays exactly solid", solid_pinned);
    check(failures, "ρ pinned to rho_min stays exactly void", void_pinned);
    check(failures, "volume constraint still met with passive regions",
          std::abs(pres.history.back().volume - pcfg.volume_fraction) < 0.01);
    // Guard against a passive region that accidentally disconnects a support: the
    // interior boxes above keep the model well-posed, so the compliance stays a
    // sensible structural value rather than a near-mechanism blow-up.
    const double pc = pres.history.back().compliance;
    std::printf("  passive-run final compliance = %.6g\n", pc);
    check(failures, "passive run stays a well-posed structure (finite, non-mechanism)",
          std::isfinite(pc) && pc < 1e6);

    // ── (4b) Ill-posed inputs are rejected loudly, not silently mishandled ─────
    std::printf("\nInput validation:\n");
    auto throws = [&](const ComplianceOptConfig& cfg) {
        try {
            optimize_compliance(model.fespace, model.cache, model.ess_tdof, model.load, cfg);
        } catch (const std::runtime_error&) {
            return true;
        }
        return false;
    };
    // An element listed as both keep-in and keep-out has contradictory pins.
    {
        ComplianceOptConfig bad = base_config();
        const int e = solid_box.front();  // non-empty, checked above
        bad.passive_solid = {e};
        bad.passive_void = {e};
        check(failures, "overlapping passive solid/void is rejected", throws(bad));
    }
    // rho_min above the volume fraction makes the minimum reachable volume exceed
    // the cap — an unsatisfiable constraint.
    {
        ComplianceOptConfig bad = base_config();
        bad.volume_fraction = 0.3;
        bad.rho_min = 0.5;  // every element ≥ 0.5 ⇒ volume ≥ 0.5 > 0.3
        check(failures, "infeasible volume fraction (rho_min > volfrac) is rejected",
              throws(bad));
    }
    // Pinning most of the mesh solid also overruns a small volume fraction.
    {
        ComplianceOptConfig bad = base_config();
        bad.volume_fraction = 0.1;
        bad.passive_solid = model.elements_in_box({0.0, 0.0, -1.0}, {5.0, 2.0, 1.0});
        check(failures, "infeasible volume fraction (too much pinned solid) is rejected",
              throws(bad));
    }
    // Repeating an index does not pin any additional material. Treat passive
    // regions as sets when checking feasibility rather than counting duplicate
    // entries repeatedly.
    {
        ComplianceOptConfig duplicate = base_config();
        duplicate.max_iterations = 1;
        duplicate.passive_solid.assign(1000, solid_box.front());
        check(failures, "duplicate passive indices are counted only once",
              !throws(duplicate));
    }
    // A non-positive iteration budget is a malformed request. In particular,
    // max_iterations=0 must not perform one unrequested analysis iteration.
    {
        ComplianceOptConfig bad = base_config();
        bad.max_iterations = 0;
        check(failures, "non-positive max_iterations is rejected", throws(bad));
    }

    // ── (5) Determinism: identical inputs → identical final density ───────────
    std::printf("\nDeterminism:\n");
    const ComplianceOptResult res2 = optimize_compliance(
        model.fespace, model.cache, model.ess_tdof, model.load, base_config());
    bool identical = res2.density.size() == res.density.size() &&
                     res2.history.size() == res.history.size();
    for (std::size_t i = 0; identical && i < res.density.size(); ++i)
        if (res2.density[i] != res.density[i]) identical = false;
    check(failures, "two runs give a bit-identical final density", identical);

    std::printf(failures != 0 ? "\n%d check(s) FAILED\n" : "\nall checks passed\n",
                failures);
    return failures != 0 ? 1 : 0;
}
