// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Native validation of the shell + coupled SIMP topology optimizer
// (engine/cpp/topology_shell.cpp, KOF-237). Builds with a plain host compiler —
// no MFEM, OCCT, Netgen or Emscripten — see scripts/test-topology-shell.sh.
// Exits non-zero if any case leaves its tolerance band, so it can gate CI.
//
// What it locks in:
//   1. Self-adjoint compliance sensitivities on the PURE SHELL path, verified
//      element-by-element against a central finite difference of the compliance
//      (the acceptance-criteria "native FD sensitivity check for the shell path").
//   2. The same FD check on a COUPLED shell/solid domain, where the RBE3
//      distributing coupling is a design-independent constraint eliminated every
//      iteration — proving the interface stays intact and the self-adjoint
//      identity carries through the master-slave reduction.
//   3. A thin-plate SIMP run (simply-supported square plate under pressure)
//      drives the compliance down under a volume constraint and redistributes
//      material into a non-uniform rib layout.

#include "shell_core.h"
#include "topology_shell.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdio>
#include <stdexcept>
#include <vector>

using namespace kofem::topopt;

namespace {

// The pass/fail counter is threaded through by reference rather than kept as a
// mutable global (matching shell_validation.cpp), so the checks stay pure.
void check(int& failures, const char* name, double got, double ref, double tol_pct) {
    const double err = std::fabs(got - ref) / std::max(std::fabs(ref), 1e-300) * 100.0;
    const bool ok = err <= tol_pct;
    if (!ok) ++failures;
    std::printf("  [%s] %-30s got=%.6e ref=%.6e err=%.3f%% (tol %.2f%%)\n",
                ok ? "PASS" : "FAIL", name, got, ref, err, tol_pct);
}

void expect(int& failures, const char* name, bool ok, const char* detail) {
    if (!ok) ++failures;
    std::printf("  [%s] %-30s %s\n", ok ? "PASS" : "FAIL", name, detail);
}

// Structured triangle mesh of the square [0,a]×[0,a] in the z=0 plane, n×n cells.
void plate_mesh(double a, int n, std::vector<double>& V, std::vector<int>& T) {
    auto id = [&](int i, int j) { return i * (n + 1) + j; };
    for (int i = 0; i <= n; ++i)
        for (int j = 0; j <= n; ++j) {
            V.push_back(a * i / n);
            V.push_back(a * j / n);
            V.push_back(0.0);
        }
    for (int i = 0; i < n; ++i)
        for (int j = 0; j < n; ++j) {
            const int a0 = id(i, j), a1 = id(i + 1, j), a2 = id(i + 1, j + 1), a3 = id(i, j + 1);
            T.push_back(a0); T.push_back(a1); T.push_back(a2);
            T.push_back(a0); T.push_back(a2); T.push_back(a3);
        }
}

// Simply-supported square plate: pin (u,v,w) on the boundary, rotations free.
// Returns the fixed-DOF list.
std::vector<int> plate_simply_supported(int n) {
    std::vector<int> fixed;
    auto id = [&](int i, int j) { return i * (n + 1) + j; };
    for (int i = 0; i <= n; ++i)
        for (int j = 0; j <= n; ++j)
            if (i == 0 || j == 0 || i == n || j == n)
                for (int c = 0; c < 3; ++c) fixed.push_back(6 * id(i, j) + c);
    return fixed;
}

// Central-difference dc/dρ_e at element e: (c(ρ+h·e) − c(ρ−h·e)) / 2h.
double fd_sensitivity(const ShellTopOptInput& in, const ShellStiffnessCache& cache,
                      std::vector<double> rho, int e, double h, double p, double emin) {
    const double r0 = rho[e];
    rho[e] = r0 + h;
    const double c_plus = evaluate_shell_compliance(in, cache, rho, p, emin).compliance;
    rho[e] = r0 - h;
    const double c_minus = evaluate_shell_compliance(in, cache, rho, p, emin).compliance;
    rho[e] = r0;
    return (c_plus - c_minus) / (2.0 * h);
}

// ── 1. Pure-shell FD sensitivity ──────────────────────────────────────────────
void test_shell_fd_sensitivity(int& failures) {
    std::printf("Pure-shell compliance sensitivity vs. finite difference:\n");
    const double a = 100.0, E = 210000.0, nu = 0.3, t = 2.0;
    const int n = 4;
    std::vector<double> V;
    std::vector<int> Tr;
    plate_mesh(a, n, V, Tr);

    ShellTopOptInput in;
    in.n_nodes = static_cast<int>(V.size() / 3);
    in.vertices = V;
    in.triangles = Tr;
    in.shell_young = E;
    in.shell_poisson = nu;
    in.thickness = t;
    in.fixed_dofs = plate_simply_supported(n);
    // Central transverse point load (−z) on the middle node.
    const int mid = (n / 2) * (n + 1) + (n / 2);
    in.loads.emplace_back(6 * mid + 2, -50.0);

    const ShellStiffnessCache cache = build_shell_stiffness_cache(in);
    const int ne = cache.num_elements();
    // A non-uniform density so every perturbed element has a distinct q_e.
    std::vector<double> rho(ne);
    for (int e = 0; e < ne; ++e) rho[e] = 0.35 + 0.5 * ((e * 7) % 11) / 11.0;

    const double p = 3.0, emin = 1e-9, h = 1e-6;
    const ShellComplianceEvaluation ev = evaluate_shell_compliance(in, cache, rho, p, emin);
    // Check a spread of elements (every 3rd) against the finite difference.
    for (int e = 0; e < ne; e += 3) {
        const double fd = fd_sensitivity(in, cache, rho, e, h, p, emin);
        std::array<char, 48> name{};
        std::snprintf(name.data(), name.size(), "facet %d dc/drho", e);
        check(failures, name.data(), ev.dcompliance[e], fd, 0.5);
    }
}

// ── 2. Coupled shell/solid FD sensitivity (RBE3 interface) ────────────────────
// A solid block cantilevered at x=0 with a thin shell wall hanging from its
// under-face on the mid-surface y=W/2, joined by distributing (RBE3) couplings.
// The whole thing — tets AND facets — is one design domain; the coupling is not.
void test_coupled_fd_sensitivity(int& failures) {
    std::printf("Coupled shell/solid sensitivity vs. finite difference (RBE3 interface):\n");
    const double L = 40.0, W = 8.0, H = 8.0, Hw = 20.0, t = 1.5;
    const double Es = 210000.0, nus = 0.3, Esh = 70000.0, nush = 0.33;
    const int nx = 2, ny = 1, nz = 1, nzw = 2;

    std::vector<double> V;
    auto sid = [&](int i, int j, int k) { return (i * (ny + 1) + j) * (nz + 1) + k; };
    for (int i = 0; i <= nx; ++i)
        for (int j = 0; j <= ny; ++j)
            for (int k = 0; k <= nz; ++k) {
                V.push_back(L * i / nx);
                V.push_back(W * j / ny);
                V.push_back(H * k / nz);
            }
    std::vector<int> tets;
    for (int i = 0; i < nx; ++i)
        for (int j = 0; j < ny; ++j)
            for (int k = 0; k < nz; ++k) {
                const int a = sid(i, j, k), b = sid(i + 1, j, k), c = sid(i + 1, j + 1, k),
                          d = sid(i, j + 1, k), e = sid(i, j, k + 1), f = sid(i + 1, j, k + 1),
                          g = sid(i + 1, j + 1, k + 1), hh = sid(i, j + 1, k + 1);
                const std::array<std::array<int, 4>, 6> q = {{{a, b, c, g},
                                                              {a, c, d, g},
                                                              {a, d, hh, g},
                                                              {a, hh, e, g},
                                                              {a, e, f, g},
                                                              {a, f, b, g}}};
                for (const auto& tt : q)
                    for (int m = 0; m < 4; ++m) tets.push_back(tt[m]);
            }
    const int nSolid = static_cast<int>(V.size() / 3);

    const int base = nSolid;
    auto wid = [&](int i, int k) { return base + i * (nzw + 1) + k; };
    for (int i = 0; i <= nx; ++i)
        for (int k = 0; k <= nzw; ++k) {
            V.push_back(L * i / nx);
            V.push_back(W / 2);
            V.push_back(-Hw * k / nzw);
        }
    std::vector<int> tris;
    for (int i = 0; i < nx; ++i)
        for (int k = 0; k < nzw; ++k) {
            const int a = wid(i, k), b = wid(i + 1, k), c = wid(i + 1, k + 1), d = wid(i, k + 1);
            tris.push_back(a); tris.push_back(b); tris.push_back(c);
            tris.push_back(a); tris.push_back(c); tris.push_back(d);
        }

    ShellTopOptInput in;
    in.n_nodes = static_cast<int>(V.size() / 3);
    in.vertices = V;
    in.tets = tets;
    in.triangles = tris;
    in.solid_young = Es;
    in.solid_poisson = nus;
    in.shell_young = Esh;
    in.shell_poisson = nush;
    in.thickness = t;

    // Distributing (RBE3) couplings: each wall top-row node ties to the block
    // nodes within a generous radius (≥3 for a well-posed inertia solve).
    const double radius = 1.3 * L;
    for (int i = 0; i <= nx; ++i) {
        const int rn = wid(i, 0);
        std::vector<int> patch;
        for (int sn = 0; sn < nSolid; ++sn) {
            const size_t bs = 3 * static_cast<size_t>(sn), br = 3 * static_cast<size_t>(rn);
            const double dx = V[bs] - V[br], dy = V[bs + 1] - V[br + 1], dz = V[bs + 2] - V[br + 2];
            if (dx * dx + dy * dy + dz * dz <= radius * radius) patch.push_back(sn);
        }
        if (patch.size() < 3) continue;
        kofem::shell::Coupling cp;
        cp.ref_node = rn;
        cp.solid_nodes = patch;
        in.couplings.push_back(std::move(cp));
    }

    // Clamp the x=0 face of the block; pull the wall's bottom row sideways.
    for (int j = 0; j <= ny; ++j)
        for (int k = 0; k <= nz; ++k)
            for (int c = 0; c < 3; ++c) in.fixed_dofs.push_back(6 * sid(0, j, k) + c);
    for (int i = 0; i <= nx; ++i) in.loads.emplace_back(6 * wid(i, nzw) + 0, 30.0);

    const ShellStiffnessCache cache = build_shell_stiffness_cache(in);
    const int ne = cache.num_elements();
    std::printf("  design domain: %d tets + %d facets = %d elements, %zu couplings\n",
                cache.n_tets, cache.n_facets, ne, in.couplings.size());
    std::vector<double> rho(ne);
    for (int e = 0; e < ne; ++e) rho[e] = 0.4 + 0.4 * ((e * 5) % 7) / 7.0;

    const double p = 3.0, emin = 1e-9, h = 1e-6;
    const ShellComplianceEvaluation ev = evaluate_shell_compliance(in, cache, rho, p, emin);
    // Sample a couple of tets and a couple of facets.
    const std::array<int, 4> probe = {0, cache.n_tets / 2, cache.n_tets,
                                      cache.n_tets + cache.n_facets / 2};
    for (const int e : probe) {
        if (e >= ne) continue;
        const double fd = fd_sensitivity(in, cache, rho, e, h, p, emin);
        std::array<char, 48> name{};
        std::snprintf(name.data(), name.size(), "%s %d dc/drho",
                      e < cache.n_tets ? "tet" : "facet", e);
        check(failures, name.data(), ev.dcompliance[e], fd, 1.0);
    }
}

// ── 3. Thin-plate SIMP: compliance descent + rib layout ───────────────────────
void test_plate_optimization(int& failures) {
    std::printf("Simply-supported thin plate under pressure — SIMP rib layout:\n");
    const double a = 100.0, E = 210000.0, nu = 0.3, t = 2.0;
    const int n = 16;
    std::vector<double> V;
    std::vector<int> Tr;
    plate_mesh(a, n, V, Tr);

    ShellTopOptInput in;
    in.n_nodes = static_cast<int>(V.size() / 3);
    in.vertices = V;
    in.triangles = Tr;
    in.shell_young = E;
    in.shell_poisson = nu;
    in.thickness = t;
    in.fixed_dofs = plate_simply_supported(n);
    // Uniform downward pressure → equal transverse nodal loads on interior nodes.
    auto id = [&](int i, int j) { return i * (n + 1) + j; };
    for (int i = 1; i < n; ++i)
        for (int j = 1; j < n; ++j) in.loads.emplace_back(6 * id(i, j) + 2, -1.0);

    ShellTopOptConfig cfg;
    cfg.volume_fraction = 0.4;
    cfg.penalty = 3.0;
    cfg.filter_radius = 2.5 * (a / n);
    cfg.move_limit = 0.2;
    cfg.max_iterations = 40;
    cfg.tolerance = 0.01;

    const ShellTopOptResult res = optimize_shell_compliance(in, cfg);
    const auto& h = res.history;
    expect(failures, "plate ran iterations", !h.empty(),
           h.empty() ? "no history" : "history recorded");
    if (h.empty()) return;

    // Compliance descends from the uniform start.
    expect(failures, "compliance decreased", h.back().compliance < h.front().compliance * 0.999,
           h.back().compliance < h.front().compliance ? "c(final) < c(initial)" : "no descent");
    // Volume constraint respected (allow a small MMA overshoot band).
    check(failures, "final volume fraction", h.back().volume, cfg.volume_fraction, 8.0);

    // Rib layout: the design is non-uniform — material pulled into ribs, voids
    // elsewhere — rather than a uniform gray field. Measure the spread.
    double lo = 1e30, hi = -1e30, sum = 0.0;
    for (const double d : res.density) {
        lo = std::min(lo, d);
        hi = std::max(hi, d);
        sum += d;
    }
    const double mean = sum / res.density.size();
    std::printf("  density: min=%.3f mean=%.3f max=%.3f over %zu facets, %d iters (%s)\n",
                lo, mean, hi, res.density.size(), res.iterations,
                res.converged ? "converged" : "hit cap");
    expect(failures, "non-uniform (ribs form)", hi - lo > 0.5,
           hi - lo > 0.5 ? "clear solid/void separation" : "field too uniform");
}

// ── 4. Invalid per-facet thickness is rejected, not silently degenerate ───────
// A zero/negative/non-finite per-facet thickness would give a zero-or-negative
// facet volume and a degenerate stiffness; the cache builder must refuse it with
// a clear error (Codex review on #448), matching solve_shell_core.
void test_invalid_thickness_rejected(int& failures) {
    std::printf("Invalid per-facet thickness is rejected:\n");
    std::vector<double> V;
    std::vector<int> Tr;
    plate_mesh(100.0, 2, V, Tr);

    ShellTopOptInput in;
    in.n_nodes = static_cast<int>(V.size() / 3);
    in.vertices = V;
    in.triangles = Tr;
    in.shell_young = 210000.0;
    in.shell_poisson = 0.3;
    in.thicknesses.assign(Tr.size() / 3, 2.0);
    in.thicknesses[0] = 0.0;  // one degenerate facet

    bool threw = false;
    try {
        build_shell_stiffness_cache(in);
    } catch (const std::runtime_error&) {
        threw = true;
    }
    expect(failures, "zero per-facet thickness throws", threw,
           threw ? "rejected as expected" : "accepted a zero thickness");
}

}  // namespace

int main() {
    std::printf("\nKoFEM shell/coupled topology-optimization validation (KOF-237)\n\n");
    int failures = 0;
    test_shell_fd_sensitivity(failures);
    test_coupled_fd_sensitivity(failures);
    test_plate_optimization(failures);
    test_invalid_thickness_rejected(failures);
    std::printf("\n%s\n", failures == 0 ? "all checks passed" : "SOME CHECKS FAILED");
    return failures == 0 ? 0 : 1;
}
