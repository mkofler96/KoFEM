// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Native validation of stress-constrained SIMP (KOF-236): the relaxed von Mises
// stress, its P-norm/KS aggregate and adjoint sensitivity
// (engine/cpp/topology_stress.{h,cpp}), and the constraint inside the MMA loop
// (topology_optimize.cpp). Links MFEM and runs under node via Emscripten
// (scripts/test-topology-stress.sh). NOT run by CI (see AGENTS.md).
//
// The benchmark is the L-bracket — the canonical stress-concentration problem of
// Le et al. (2010) — as a 2D-in-3D slab (u_z ≡ 0): a unit square with the upper-
// right 0.6 × 0.6 block removed, clamped along its top edge, loaded downward on
// the end of the horizontal arm. A minimum-compliance design runs its members
// straight into the re-entrant corner at (0.4, 0.4), where the stress
// concentrates; a stress limit should round that corner off.
//
// Checks:
//   1. The element stress operator reproduces an analytic uniform stress state.
//   2. FD check of the aggregated-stress adjoint sensitivities, P-norm and KS, on a
//      handful of elements at a non-uniform density field (≤ 1e-4 relative).
//   3. L-bracket: the compliance-only design peaks at the re-entrant corner.
//      min_volume s.t. σ ≤ σ_allow meets the limit (within the loop's slack) with
//      a peak ≥ 10% below a compliance-only design of the same volume; and the
//      stress limit added to a min_compliance run meets both limits where it is
//      binding.
//   4. An infeasible σ_allow ends in a clear error, not a silent non-converged run;
//      malformed stress settings are rejected.
// Given a directory argument it also writes the L-bracket density fields
// (centroid x, y, ρ per element) there for the before/after evidence plot.
// Exits non-zero on any failure.

#include "topology_optimize.h"
#include "topology_simp_core.h"
#include "topology_stress.h"

#include <mfem.hpp>

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdio>
#include <stdexcept>
#include <string>
#include <vector>

using namespace kofem::topopt;

namespace {

constexpr int dim = 3;

void check(int& failures, const char* name, bool ok) {
    if (!ok) ++failures;
    std::printf("  [%s] %s\n", ok ? "PASS" : "FAIL", name);
}

// Structured L-bracket tet mesh: n × n square cells of size 1/n (one layer
// thick), keeping the cells outside the removed upper-right block, each split
// into 6 Kuhn tets.
mfem::Mesh make_l_bracket(int n, double thickness) {
    const double h = 1.0 / n;
    const double cut = 0.4;  // arms are 0.4 wide
    auto vid = [&](int i, int j, int k) { return (k * (n + 1) + j) * (n + 1) + i; };
    auto kept = [&](int i, int j) { return (i + 0.5) * h <= cut || (j + 0.5) * h <= cut; };
    int ncells = 0;
    for (int j = 0; j < n; ++j)
        for (int i = 0; i < n; ++i) ncells += kept(i, j) ? 1 : 0;
    const int nv = (n + 1) * (n + 1) * 2;
    mfem::Mesh mesh(dim, nv, 6 * ncells, 0, dim);
    for (int k = 0; k <= 1; ++k)
        for (int j = 0; j <= n; ++j)
            for (int i = 0; i <= n; ++i) mesh.AddVertex(i * h, j * h, k * thickness);
    // Kuhn subdivision of the unit cube along the main diagonal 0 → 7.
    const std::array<std::array<int, 4>, 6> kuhn = {{{0, 1, 3, 7},
                                                     {0, 1, 5, 7},
                                                     {0, 2, 3, 7},
                                                     {0, 2, 6, 7},
                                                     {0, 4, 5, 7},
                                                     {0, 4, 6, 7}}};
    for (int j = 0; j < n; ++j)
        for (int i = 0; i < n; ++i) {
            if (!kept(i, j)) continue;
            // Cube corner c = bx + 2·by + 4·bz.
            std::array<int, 8> corner{};
            for (int c = 0; c < 8; ++c)
                corner[c] = vid(i + (c & 1), j + ((c >> 1) & 1), (c >> 2) & 1);
            for (const std::array<int, 4>& t : kuhn) {
                const std::array<int, 4> v = {corner[t[0]], corner[t[1]], corner[t[2]],
                                              corner[t[3]]};
                mesh.AddTet(v.data(), 1);
            }
        }
    mesh.FinalizeTetMesh(1, 1, true);
    mesh.RemoveUnusedVertices();
    return mesh;
}

struct Model {
    mfem::Mesh mesh;
    mfem::H1_FECollection fec{1, dim};
    mfem::FiniteElementSpace fespace;
    mfem::Array<int> ess_tdof;
    mfem::LinearForm load;
    ElementStiffnessCache cache;
    ElementStressCache stress_cache;

    explicit Model(int n)
        : mesh(make_l_bracket(n, 1.0 / n)), fespace(&mesh, &fec, dim), load(&fespace) {
        const double tol = 1e-9;
        std::vector<int> load_vertices;
        for (int vi = 0; vi < mesh.GetNV(); ++vi) {
            const double* xv = mesh.GetVertex(vi);
            mfem::Array<int> vdofs;
            fespace.GetVertexVDofs(vi, vdofs);
            ess_tdof.Append(vdofs[2]);  // u_z ≡ 0 (2D-in-3D)
            if (xv[1] > 1.0 - tol) {    // clamped top edge
                ess_tdof.Append(vdofs[0]);
                ess_tdof.Append(vdofs[1]);
            }
            // Downward shear on the upper half of the arm's end face, spread over
            // its nodes so no single element carries a point-load singularity.
            if (xv[0] > 1.0 - tol && xv[1] > 0.2 - tol) load_vertices.push_back(vi);
        }
        ess_tdof.Sort();
        ess_tdof.Unique();
        load = 0.0;
        for (const int vi : load_vertices) {
            mfem::Array<int> vdofs;
            fespace.GetVertexVDofs(vi, vdofs);
            load[vdofs[1]] -= 1.0 / static_cast<double>(load_vertices.size());
        }
        cache = build_element_stiffness_cache(fespace, 1.0 /*E0*/, 0.3 /*nu*/);
        stress_cache = build_element_stress_cache(fespace, 1.0, 0.3);
    }
};

StressConstraintConfig stress_config(double limit, StressAggregation agg, double p) {
    StressConstraintConfig s;
    s.enabled = true;
    s.limit = limit;
    s.aggregation = agg;
    s.aggregation_p = p;
    return s;
}

ComplianceOptConfig l_config() {
    ComplianceOptConfig cfg;
    cfg.volume_fraction = 0.4;
    cfg.penalty = 3.0;
    cfg.filter_radius = 0.06;  // ~1.5 cells at n = 25
    cfg.move_limit = 0.2;
    cfg.max_iterations = 150;
    cfg.tolerance = 0.01;
    cfg.rho_min = 1e-3;
    return cfg;
}

// Max qp-relaxed von Mises stress of a design — the same measure the constraint
// bounds — evaluated independently of the loop.
double peak_stress(Model& m, const std::vector<double>& rho, double penalty, double q,
                   int* argmax = nullptr) {
    const ComplianceEvaluation ev =
        evaluate_compliance(m.fespace, m.cache, m.ess_tdof, m.load, rho, penalty, 1e-9, 1e-10);
    const StressEvaluation sev =
        evaluate_stress(m.fespace, m.cache, m.stress_cache, m.ess_tdof, rho, ev.solution,
                        penalty, 1e-9, 1e-10, penalty - q,
                        stress_config(1.0, StressAggregation::PNorm, 8.0));
    if (argmax != nullptr) *argmax = sev.argmax;
    return sev.max_relaxed;
}

void dump_density(const Model& m, const std::vector<double>& rho, const std::string& path) {
    FILE* f = std::fopen(path.c_str(), "w");
    if (f == nullptr) throw std::runtime_error("cannot write " + path);
    std::fprintf(f, "x,y,rho\n");
    for (std::size_t e = 0; e < rho.size(); ++e)
        std::fprintf(f, "%.6f,%.6f,%.6f\n", m.cache.centroid[e][0], m.cache.centroid[e][1],
                     rho[e]);
    std::fclose(f);
}

}  // namespace

int run(int argc, char** argv) {
    int failures = 0;

    // ── 1. Stress operator vs. an analytic uniform state ──────────────────────
    std::printf("Element stress operator:\n");
    {
        Model m(6);
        // u = (ε·x, −ν·ε·y, −ν·ε·z) is uniaxial tension σ_xx = E·ε with every other
        // component zero, so σ_vm = E·ε exactly on every element.
        const double eps = 1e-3;
        mfem::Vector u(m.fespace.GetVSize());
        for (int vi = 0; vi < m.mesh.GetNV(); ++vi) {
            const double* xv = m.mesh.GetVertex(vi);
            mfem::Array<int> vd;
            m.fespace.GetVertexVDofs(vi, vd);
            u[vd[0]] = eps * xv[0];
            u[vd[1]] = -0.3 * eps * xv[1];
            u[vd[2]] = -0.3 * eps * xv[2];
        }
        const std::vector<double> rho(m.fespace.GetNE(), 1.0);
        const StressEvaluation sev =
            evaluate_stress(m.fespace, m.cache, m.stress_cache, m.ess_tdof, rho, u, 3.0,
                            1e-9, 1e-10, 0.5, stress_config(1.0, StressAggregation::PNorm, 8));
        double worst = 0.0;
        for (const double s : sev.relaxed) worst = std::max(worst, std::abs(s - eps) / eps);
        std::printf("  uniaxial σ_vm = E·ε: worst relative error %.2e over %d elements\n",
                    worst, m.fespace.GetNE());
        check(failures, "σ_vm of uniaxial tension equals E·ε on every element", worst < 1e-10);
    }

    // ── 2. FD check of the adjoint sensitivities ──────────────────────────────
    std::printf("\nAdjoint sensitivity vs. central finite differences:\n");
    {
        Model m(10);
        const int ne = m.fespace.GetNE();
        std::vector<double> rho(ne);
        for (int e = 0; e < ne; ++e)  // deterministic, non-uniform field in [0.3, 1]
            rho[e] = 0.65 + 0.35 * std::sin(0.7 * e + 0.3 * std::cos(1.3 * e));
        const double penalty = 3.0;
        const double emin = 1e-9;
        const double rtol = 1e-13;
        auto evaluate = [&](const std::vector<double>& r, const StressConstraintConfig& sc) {
            const ComplianceEvaluation ev =
                evaluate_compliance(m.fespace, m.cache, m.ess_tdof, m.load, r, penalty, emin,
                                    rtol);
            return evaluate_stress(m.fespace, m.cache, m.stress_cache, m.ess_tdof, r,
                                   ev.solution, penalty, emin, rtol, penalty - 2.5, sc);
        };
        const std::array<StressConstraintConfig, 2> configs = {
            stress_config(0.5, StressAggregation::PNorm, 8.0),
            stress_config(0.5, StressAggregation::KS, 40.0)};
        const std::array<const char*, 2> names = {"P-norm (P=8)", "KS (P=40)"};
        // A spread of elements, including the most stressed one (the gradient is
        // largest there) and low-density ones.
        for (std::size_t c = 0; c < configs.size(); ++c) {
            const std::vector<double> grad = evaluate(rho, configs[c]).daggregate;
            // Probe elements whose sensitivity is non-negligible (≥ 1% of the
            // largest): below that the FD quotient is dominated by the CG solve
            // noise of the two perturbed states, not by the derivative. Take the
            // largest plus six spread across the rest of that set.
            double gmax = 0.0;
            for (const double g : grad) gmax = std::max(gmax, std::abs(g));
            std::vector<int> significant;
            for (int e = 0; e < ne; ++e)
                if (std::abs(grad[e]) >= 1e-2 * gmax) significant.push_back(e);
            std::sort(significant.begin(), significant.end(),
                      [&](int a, int b) { return std::abs(grad[a]) > std::abs(grad[b]); });
            std::vector<int> probe;
            const int ns = static_cast<int>(significant.size());
            for (int k = 0; k < 7 && k < ns; ++k) probe.push_back(significant[(k * (ns - 1)) / 6]);
            std::printf("  %s: %d of %d elements have |dg/dρ| ≥ 1%% of the max\n", names[c], ns,
                        ne);
            double worst = 0.0;
            for (const int e : probe) {
                const double h = 1e-5;
                std::vector<double> rp = rho;
                std::vector<double> rm = rho;
                rp[e] += h;
                rm[e] -= h;
                const double fd =
                    (evaluate(rp, configs[c]).aggregate - evaluate(rm, configs[c]).aggregate) /
                    (2.0 * h);
                const double rel = std::abs(fd - grad[e]) / std::max(std::abs(fd), 1e-12);
                worst = std::max(worst, rel);
                std::printf("  %-13s e=%5d  adjoint % .8e  FD % .8e  rel %.2e\n", names[c], e,
                            grad[e], fd, rel);
            }
            const std::string label =
                std::string(names[c]) + ": adjoint matches FD to ≤ 1e-4 relative";
            check(failures, label.c_str(), worst <= 1e-4);
        }
    }

    // ── 3. L-bracket: compliance-only vs. stress-constrained ──────────────────
    std::printf("\nL-bracket benchmark:\n");
    Model lb(25);
    std::printf("  %d elements, %d dofs\n", lb.fespace.GetNE(), lb.fespace.GetTrueVSize());
    const char* dump_dir = argc > 1 ? argv[1] : nullptr;
    auto dump = [&](const std::vector<double>& rho, const char* name) {
        if (dump_dir != nullptr) dump_density(lb, rho, std::string(dump_dir) + "/" + name);
    };
    auto near_corner = [&](int e) {
        return std::hypot(lb.cache.centroid[e][0] - 0.4, lb.cache.centroid[e][1] - 0.4) < 0.05;
    };

    std::printf("\n  compliance-only (min_compliance, volfrac 0.4):\n");
    const ComplianceOptResult base =
        optimize_compliance(lb.fespace, lb.cache, lb.ess_tdof, lb.load, l_config());
    int base_arg = -1;
    const double base_peak = peak_stress(lb, base.density, 3.0, 2.5, &base_arg);
    std::printf("  compliance-only: c=%.6g vol=%.4f, peak relaxed σ_vm=%.6g at (%.3f, %.3f)\n",
                base.history.back().compliance, base.history.back().volume, base_peak,
                lb.cache.centroid[base_arg][0], lb.cache.centroid[base_arg][1]);
    check(failures, "compliance-only peak stress sits at the re-entrant corner",
          near_corner(base_arg));
    check(failures, "compliance-only history carries no stress",
          std::isnan(base.history.back().stress) && std::isnan(base.history.back().max_stress));
    dump(base.density, "lbracket_compliance.csv");

    // (a) min_volume s.t. σ ≤ σ_allow — the formulation of Le et al. (2010) —
    // against a compliance-only design at the SAME volume. (At a fixed volume
    // fraction of 0.4 there is little room: the clamp's bending stress puts a
    // floor ~0.75× the corner peak under any design at this resolution.)
    const double sigma_allow = 0.7 * base_peak;
    std::printf("\n  min_volume s.t. max stress ≤ %.6g (0.7× the compliance-only peak):\n",
                sigma_allow);
    ComplianceOptConfig vcfg = l_config();
    vcfg.objective = TopOptObjective::MinVolume;
    vcfg.compliance_limit = 0.0;
    vcfg.stress = stress_config(sigma_allow, StressAggregation::PNorm, 8.0);
    vcfg.max_iterations = 300;
    const ComplianceOptResult vres =
        optimize_compliance(lb.fespace, lb.cache, lb.ess_tdof, lb.load, vcfg, &lb.stress_cache);
    int v_arg = -1;
    const double v_peak = peak_stress(lb, vres.density, 3.0, 2.5, &v_arg);
    const TopOptHistoryEntry& vlast = vres.history.back();
    std::printf("  min_volume: %d its (%s), vol=%.4f c=%.6g, peak σ_vm=%.6g, aggregate %.6g\n",
                vres.iterations, vres.converged ? "converged" : "capped", vlast.volume,
                vlast.compliance, v_peak, vlast.stress);
    check(failures, "history carries the aggregated and true max stress",
          std::isfinite(vlast.stress) && std::isfinite(vlast.max_stress));
    check(failures, "history max_stress matches an independent re-evaluation",
          std::abs(vlast.max_stress - v_peak) <= 1e-6 * v_peak);
    check(failures, "min_volume s.t. stress meets σ_allow (within the loop slack)",
          v_peak <= sigma_allow * (1.0 + kStressLimitSlack));
    check(failures, "min_volume s.t. stress started from full material",
          std::abs(vres.history.front().volume - 1.0) < 1e-12);
    check(failures, "min_volume s.t. stress removed material (volume < 0.7)",
          vlast.volume < 0.7);
    dump(vres.density, "lbracket_minvol_stress.csv");

    ComplianceOptConfig eq = l_config();
    eq.volume_fraction = vlast.volume;
    const ComplianceOptResult eq_res =
        optimize_compliance(lb.fespace, lb.cache, lb.ess_tdof, lb.load, eq);
    int eq_arg = -1;
    const double eq_peak = peak_stress(lb, eq_res.density, 3.0, 2.5, &eq_arg);
    std::printf("  compliance-only at the same volume %.4f: peak σ_vm=%.6g at (%.3f, %.3f)\n",
                vlast.volume, eq_peak, lb.cache.centroid[eq_arg][0],
                lb.cache.centroid[eq_arg][1]);
    std::printf("  peak stress reduction at equal volume: %.1f%%\n",
                100.0 * (1.0 - v_peak / eq_peak));
    check(failures, "stress design's peak ≥ 10% below the compliance design at equal volume",
          v_peak <= 0.9 * eq_peak);
    dump(eq_res.density, "lbracket_compliance_equal_volume.csv");

    // (b) The stress limit as an added constraint on a compliance objective, at a
    // volume fraction where the limit is reachable but binding: the
    // compliance-only design at that volume exceeds it.
    {
        const double vf = 0.55;
        const double limit = 0.75 * base_peak;
        std::printf("\n  min_compliance s.t. volfrac %.2f and max stress ≤ %.6g:\n", vf, limit);
        ComplianceOptConfig ccfg = l_config();
        ccfg.volume_fraction = vf;
        const ComplianceOptResult cref =
            optimize_compliance(lb.fespace, lb.cache, lb.ess_tdof, lb.load, ccfg);
        const double cref_peak = peak_stress(lb, cref.density, 3.0, 2.5);
        ccfg.stress = stress_config(limit, StressAggregation::PNorm, 8.0);
        ccfg.max_iterations = 300;
        const ComplianceOptResult cres = optimize_compliance(lb.fespace, lb.cache, lb.ess_tdof,
                                                             lb.load, ccfg, &lb.stress_cache);
        const double c_peak = peak_stress(lb, cres.density, 3.0, 2.5);
        const TopOptHistoryEntry& cl = cres.history.back();
        std::printf("  compliance-only: c=%.6g, peak %.6g; stress-constrained: %d its (%s), "
                    "c=%.6g vol=%.4f, peak %.6g\n",
                    cref.history.back().compliance, cref_peak, cres.iterations,
                    cres.converged ? "converged" : "capped", cl.compliance, cl.volume, c_peak);
        check(failures, "the stress limit is binding (compliance-only design exceeds it)",
              cref_peak > limit * (1.0 + kStressLimitSlack));
        check(failures, "min_compliance + stress meets σ_allow",
              c_peak <= limit * (1.0 + kStressLimitSlack));
        check(failures, "min_compliance + stress meets the volume fraction",
              cl.volume <= vf * (1.0 + kVolumeLimitSlack));
        check(failures, "the stress constraint costs some stiffness (compliance ≥ unconstrained)",
              cl.compliance >= cref.history.back().compliance * 0.99);
    }

    // ── 4. Infeasible and malformed settings ──────────────────────────────────
    std::printf("\nInfeasible / invalid stress settings:\n");
    auto error_of = [&](const ComplianceOptConfig& cfg) -> std::string {
        try {
            optimize_compliance(lb.fespace, lb.cache, lb.ess_tdof, lb.load, cfg,
                                &lb.stress_cache);
        } catch (const std::runtime_error& err) {
            // The rejection IS the expected outcome here: log it and hand the
            // message back so each case can check its wording.
            std::printf("  rejected: %s\n", err.what());
            return err.what();
        }
        return "";
    };
    {
        // A limit far below anything the loads allow: no iterate can meet it.
        ComplianceOptConfig bad = l_config();
        bad.volume_fraction = 0.2;
        bad.max_iterations = 25;
        bad.stress = stress_config(0.02 * base_peak, StressAggregation::PNorm, 8.0);
        const std::string msg = error_of(bad);
        check(failures, "an unreachable σ_allow is rejected with a clear error",
              msg.find("was not met") != std::string::npos &&
                  msg.find("lowest max von Mises") != std::string::npos);
    }
    {
        ComplianceOptConfig bad = l_config();
        bad.stress = stress_config(sigma_allow, StressAggregation::PNorm, 8.0);
        bad.stress.relaxation_q = 3.0;  // q = p
        check(failures, "q ≥ p is rejected", !error_of(bad).empty());
        bad.stress.relaxation_q = 2.5;
        bad.rho_min = 0.0;
        check(failures, "rho_min = 0 with a ρ^½ relaxation is rejected", !error_of(bad).empty());
        bad.rho_min = 1e-3;
        bad.stress.limit = -1.0;
        check(failures, "a non-positive σ_allow is rejected", !error_of(bad).empty());
        bad.stress.limit = sigma_allow;
        bad.stress.aggregation_p = 0.5;
        check(failures, "an aggregation P < 1 is rejected", !error_of(bad).empty());
    }
    {
        ComplianceOptConfig bad = l_config();
        bad.objective = TopOptObjective::MinVolume;
        bad.compliance_limit = 0.0;
        check(failures, "min_volume with neither a compliance nor a stress limit is rejected",
              !error_of(bad).empty());
    }
    {
        ComplianceOptConfig bad = l_config();
        bad.stress = stress_config(sigma_allow, StressAggregation::PNorm, 8.0);
        bool threw = false;
        try {
            optimize_compliance(lb.fespace, lb.cache, lb.ess_tdof, lb.load, bad, nullptr);
        } catch (const std::runtime_error&) {
            threw = true;
        }
        check(failures, "a stress limit without the stress cache is rejected", threw);
    }

    std::printf("\n%s\n", failures == 0 ? "all checks passed" : "SOME CHECKS FAILED");
    return failures == 0 ? 0 : 1;
}

int main(int argc, char** argv) {
    try {
        return run(argc, argv);
    } catch (const std::exception& err) {
        std::printf("\nUNEXPECTED EXCEPTION: %s\n", err.what());
        return 1;
    }
}
