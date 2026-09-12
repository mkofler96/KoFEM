// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// SIMP minimum-compliance topology optimization for shell + coupled shell/solid
// design domains — see topology_shell.h (KOF-237).

#include "topology_shell.h"

#include "shell_core.h"
#include "topology_filter.h"
#include "topology_mma.h"

#include <array>
#include <cmath>
#include <cstdio>
#include <stdexcept>
#include <string>
#include <vector>

namespace kofem::topopt {

namespace {

// SIMP stiffness interpolation and its derivative — the same modified-SIMP with a
// stiffness floor the solid path uses (topology_simp_core.cpp / ADR-0002),
// re-declared here so this translation unit stays MFEM-free.
double simp_scale(double rho, double penalty, double emin_rel) {
    return emin_rel + std::pow(rho, penalty) * (1.0 - emin_rel);
}
double simp_scale_deriv(double rho, double penalty, double emin_rel) {
    return penalty * std::pow(rho, penalty - 1.0) * (1.0 - emin_rel);
}

// Design elements with a live variable (every element except the pinned passive
// ones), mirroring topology_optimize.cpp's DesignDomain.
struct DesignDomain {
    std::vector<int> active;   // design-element index of each variable
    std::vector<char> pinned;  // 0 active, 1 passive solid, 2 passive void
};

DesignDomain build_design_domain(int ne, const std::vector<int>& passive_solid,
                                 const std::vector<int>& passive_void) {
    DesignDomain dom;
    dom.pinned.assign(ne, 0);
    auto mark = [&](const std::vector<int>& set, char kind, const char* which) {
        for (const int e : set) {
            if (e < 0 || e >= ne)
                throw std::runtime_error(std::string("optimize_shell_compliance: passive ") +
                                         which + " element index " + std::to_string(e) +
                                         " out of range [0, " + std::to_string(ne) + ")");
            if (dom.pinned[e] != 0 && dom.pinned[e] != kind)
                throw std::runtime_error(
                    "optimize_shell_compliance: element " + std::to_string(e) +
                    " is listed as both passive solid and passive void");
            dom.pinned[e] = kind;
        }
    };
    mark(passive_solid, 1, "solid");
    mark(passive_void, 2, "void");
    for (int e = 0; e < ne; ++e)
        if (dom.pinned[e] == 0) dom.active.push_back(e);
    return dom;
}

// uₑᵀk0ₑuₑ for one design element: gather the element displacement from the full
// solution at the element's global DOFs, then the base-stiffness quadratic form.
double element_strain_energy(const std::vector<double>& k0, const std::vector<int>& dofs,
                             const std::vector<double>& u) {
    const int nd = static_cast<int>(dofs.size());
    std::vector<double> ue(nd);
    for (int a = 0; a < nd; ++a) ue[a] = u[dofs[a]];
    double q = 0.0;
    for (int a = 0; a < nd; ++a) {
        double row = 0.0;
        for (int b = 0; b < nd; ++b) row += k0[a * nd + b] * ue[b];
        q += ue[a] * row;
    }
    return q;
}

}  // namespace

ShellStiffnessCache build_shell_stiffness_cache(const ShellTopOptInput& in) {
    if (static_cast<int>(in.vertices.size()) != 3 * in.n_nodes)
        throw std::runtime_error("build_shell_stiffness_cache: vertices length does not match n_nodes");
    if (in.tets.size() % 4 != 0)
        throw std::runtime_error("build_shell_stiffness_cache: tets length not divisible by 4");
    if (in.triangles.size() % 3 != 0)
        throw std::runtime_error("build_shell_stiffness_cache: triangles length not divisible by 3");

    const int n_tets = static_cast<int>(in.tets.size() / 4);
    const int n_facets = static_cast<int>(in.triangles.size() / 3);
    // Thickness must be a valid per-facet field or a positive uniform scalar —
    // the same rule solve_shell_core enforces. A zero/negative/non-finite value
    // would give a zero-or-negative facet volume and a degenerate stiffness, so
    // refuse it with a clear error rather than optimize on garbage.
    const bool per_facet = static_cast<int>(in.thicknesses.size()) == n_facets;
    if (n_facets > 0) {
        if (per_facet) {
            for (const double tk : in.thicknesses)
                if (!std::isfinite(tk) || tk <= 0.0)
                    throw std::runtime_error(
                        "build_shell_stiffness_cache: every per-facet shell thickness must be "
                        "finite and positive");
        } else if (!std::isfinite(in.thickness) || in.thickness <= 0.0) {
            throw std::runtime_error(
                "build_shell_stiffness_cache: shell thickness must be finite and positive");
        }
    }

    ShellStiffnessCache cache;
    cache.n_tets = n_tets;
    cache.n_facets = n_facets;
    const int ne = n_tets + n_facets;
    cache.k0.resize(ne);
    cache.dofs.resize(ne);
    cache.volume.resize(ne);
    cache.centroid.resize(ne);

    auto vtx = [&](int n, int c) { return in.vertices[3 * static_cast<size_t>(n) + c]; };

    // Solid tets first.
    for (int e = 0; e < n_tets; ++e) {
        const size_t e4 = 4 * static_cast<size_t>(e);
        const std::array<int, 4> nd = {in.tets[e4], in.tets[e4 + 1], in.tets[e4 + 2],
                                       in.tets[e4 + 3]};
        const auto Ke = kofem::shell::tet_element_stiffness(
            in.vertices, nd[0], nd[1], nd[2], nd[3], in.solid_young, in.solid_poisson);
        std::vector<double>& k0 = cache.k0[e];
        k0.resize(static_cast<size_t>(12) * 12);
        for (int a = 0; a < 12; ++a)
            for (int b = 0; b < 12; ++b) k0[a * 12 + b] = Ke[a][b];
        std::vector<int>& dofs = cache.dofs[e];
        dofs.resize(12);
        for (int i = 0; i < 4; ++i)
            for (int c = 0; c < 3; ++c) dofs[3 * i + c] = 6 * nd[i] + c;
        // Tet volume = |det(edge Jacobian)| / 6.
        const double j00 = vtx(nd[1], 0) - vtx(nd[0], 0), j01 = vtx(nd[2], 0) - vtx(nd[0], 0),
                     j02 = vtx(nd[3], 0) - vtx(nd[0], 0);
        const double j10 = vtx(nd[1], 1) - vtx(nd[0], 1), j11 = vtx(nd[2], 1) - vtx(nd[0], 1),
                     j12 = vtx(nd[3], 1) - vtx(nd[0], 1);
        const double j20 = vtx(nd[1], 2) - vtx(nd[0], 2), j21 = vtx(nd[2], 2) - vtx(nd[0], 2),
                     j22 = vtx(nd[3], 2) - vtx(nd[0], 2);
        const double det = j00 * (j11 * j22 - j12 * j21) - j01 * (j10 * j22 - j12 * j20) +
                           j02 * (j10 * j21 - j11 * j20);
        cache.volume[e] = std::fabs(det) / 6.0;
        for (int c = 0; c < 3; ++c)
            cache.centroid[e][c] =
                0.25 * (vtx(nd[0], c) + vtx(nd[1], c) + vtx(nd[2], c) + vtx(nd[3], c));
    }

    // Shell facets.
    for (int f = 0; f < n_facets; ++f) {
        const int e = n_tets + f;
        const size_t f3 = 3 * static_cast<size_t>(f);
        const std::array<int, 3> nd = {in.triangles[f3], in.triangles[f3 + 1],
                                       in.triangles[f3 + 2]};
        const double t = per_facet ? in.thicknesses[f] : in.thickness;
        const auto Ke = kofem::shell::facet_global_stiffness(in.vertices, nd[0], nd[1], nd[2], t,
                                                             in.shell_young, in.shell_poisson);
        std::vector<double>& k0 = cache.k0[e];
        k0.resize(static_cast<size_t>(18) * 18);
        for (int a = 0; a < 18; ++a)
            for (int b = 0; b < 18; ++b) k0[a * 18 + b] = Ke[a][b];
        std::vector<int>& dofs = cache.dofs[e];
        dofs.resize(18);
        for (int i = 0; i < 3; ++i)
            for (int c = 0; c < 6; ++c) dofs[6 * i + c] = 6 * nd[i] + c;
        // Facet material volume = area · thickness (area from the edge cross product).
        const double ux = vtx(nd[1], 0) - vtx(nd[0], 0), uy = vtx(nd[1], 1) - vtx(nd[0], 1),
                     uz = vtx(nd[1], 2) - vtx(nd[0], 2);
        const double vx = vtx(nd[2], 0) - vtx(nd[0], 0), vy = vtx(nd[2], 1) - vtx(nd[0], 1),
                     vz = vtx(nd[2], 2) - vtx(nd[0], 2);
        const double cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
        const double area = 0.5 * std::sqrt(cx * cx + cy * cy + cz * cz);
        cache.volume[e] = area * t;
        for (int c = 0; c < 3; ++c)
            cache.centroid[e][c] = (vtx(nd[0], c) + vtx(nd[1], c) + vtx(nd[2], c)) / 3.0;
    }
    return cache;
}

ShellComplianceEvaluation evaluate_shell_compliance(const ShellTopOptInput& in,
                                                    const ShellStiffnessCache& cache,
                                                    const std::vector<double>& rho,
                                                    double penalty, double emin_rel,
                                                    double cg_rtol) {
    const int ne = cache.num_elements();
    if (static_cast<int>(rho.size()) != ne)
        throw std::runtime_error(
            "evaluate_shell_compliance: density field has " + std::to_string(rho.size()) +
            " entries but the design domain has " + std::to_string(ne) + " elements");

    std::vector<double> scale(ne);
    for (int e = 0; e < ne; ++e) scale[e] = simp_scale(rho[e], penalty, emin_rel);

    // Assemble the SIMP-penalized system through the coupled assembler: scaled
    // solid triplets (3·node+comp numbering, as tet_solid_stiffness emits) plus a
    // per-facet shell scale. A pure-shell model has no tets and no couplings, so
    // the reduction is the identity and this reduces to the plain shell solve.
    kofem::shell::CoupledInput ci;
    ci.n_nodes = in.n_nodes;
    ci.vertices = in.vertices;
    ci.triangles = in.triangles;
    ci.shell_young = in.shell_young;
    ci.shell_poisson = in.shell_poisson;
    ci.thickness = in.thickness;
    ci.thicknesses = in.thicknesses;
    ci.couplings = in.couplings;
    ci.fixed_dofs = in.fixed_dofs;
    ci.prescribed_dofs = in.prescribed_dofs;
    ci.loads = in.loads;
    ci.cg_rel_tol = cg_rtol;

    ci.solid_stiffness.reserve(static_cast<size_t>(cache.n_tets) * 144);
    for (int e = 0; e < cache.n_tets; ++e) {
        const std::vector<double>& k0 = cache.k0[e];
        const std::vector<int>& dofs = cache.dofs[e];
        const double s = scale[e];
        for (int a = 0; a < 12; ++a) {
            const int ia = 3 * (dofs[a] / 6) + dofs[a] % 6;  // → 3·node+comp
            for (int b = 0; b < 12; ++b) {
                const double v = k0[a * 12 + b];
                if (v == 0.0) continue;
                const int jb = 3 * (dofs[b] / 6) + dofs[b] % 6;
                ci.solid_stiffness.push_back({ia, jb, s * v});
            }
        }
    }
    if (cache.n_facets > 0) {
        ci.shell_scale.resize(cache.n_facets);
        for (int f = 0; f < cache.n_facets; ++f) ci.shell_scale[f] = scale[cache.n_tets + f];
    }

    const kofem::shell::ShellResult r = kofem::shell::solve_solid_shell_core(ci);
    if (!r.converged)
        throw std::runtime_error(
            "evaluate_shell_compliance: the SIMP solve did not converge (relative residual " +
            std::to_string(r.rel_residual) + " after " + std::to_string(r.iterations) +
            " iterations) — check that the design domain is fully supported");

    ShellComplianceEvaluation ev;
    ev.strain_energy.resize(ne);
    ev.dcompliance.resize(ne);
    ev.cg_iterations = r.iterations;
    for (int e = 0; e < ne; ++e) {
        const double qe = element_strain_energy(cache.k0[e], cache.dofs[e], r.dofs);
        ev.strain_energy[e] = qe;
        ev.compliance += scale[e] * qe;
        ev.dcompliance[e] = -simp_scale_deriv(rho[e], penalty, emin_rel) * qe;
    }

    ev.displacements.assign(3 * static_cast<size_t>(in.n_nodes), 0.0);
    for (int v = 0; v < in.n_nodes; ++v)
        for (int c = 0; c < 3; ++c)
            ev.displacements[3 * v + c] = r.dofs[6 * static_cast<size_t>(v) + c];
    return ev;
}

ShellTopOptResult optimize_shell_compliance(const ShellTopOptInput& in,
                                            const ShellTopOptConfig& config) {
    if (!in.prescribed_dofs.empty())
        throw std::runtime_error(
            "optimize_shell_compliance: prescribed (non-zero) displacements are not "
            "supported — the minimum-compliance objective is self-adjoint only for "
            "homogeneous supports (u = 0)");
    if (std::isnan(config.volume_fraction) || config.volume_fraction <= 0.0 ||
        config.volume_fraction > 1.0)
        throw std::runtime_error("optimize_shell_compliance: volume_fraction must be in (0, 1]");
    if (std::isnan(config.rho_min) || config.rho_min < 0.0 || config.rho_min >= 1.0)
        throw std::runtime_error("optimize_shell_compliance: rho_min must be in [0, 1)");
    if (config.max_iterations <= 0)
        throw std::runtime_error("optimize_shell_compliance: max_iterations must be positive");
    if (!std::isfinite(config.penalty) || config.penalty <= 0.0)
        throw std::runtime_error("optimize_shell_compliance: penalty must be finite and positive");
    if (!std::isfinite(config.filter_radius))
        throw std::runtime_error("optimize_shell_compliance: filter_radius must be finite");
    if (!std::isfinite(config.move_limit) || config.move_limit <= 0.0)
        throw std::runtime_error("optimize_shell_compliance: move_limit must be finite and positive");
    if (!std::isfinite(config.tolerance) || config.tolerance <= 0.0)
        throw std::runtime_error("optimize_shell_compliance: tolerance must be finite and positive");
    if (!std::isfinite(config.emin_rel) || config.emin_rel <= 0.0 || config.emin_rel >= 1.0)
        throw std::runtime_error("optimize_shell_compliance: emin_rel must be in (0, 1)");
    if (!std::isfinite(config.cg_rtol) || config.cg_rtol <= 0.0)
        throw std::runtime_error("optimize_shell_compliance: cg_rtol must be finite and positive");

    const ShellStiffnessCache cache = build_shell_stiffness_cache(in);
    const int ne = cache.num_elements();
    if (ne <= 0) throw std::runtime_error("optimize_shell_compliance: design domain has no elements");

    const DesignDomain dom =
        build_design_domain(ne, config.passive_solid, config.passive_void);
    const int nact = static_cast<int>(dom.active.size());
    if (nact == 0)
        throw std::runtime_error(
            "optimize_shell_compliance: every element is pinned — no design variables");

    double vtotal = 0.0;
    for (const double v : cache.volume) vtotal += v;
    const double vcap = config.volume_fraction * vtotal;
    if (!(vcap > 0.0)) throw std::runtime_error("optimize_shell_compliance: non-positive volume");

    double solid_volume = 0.0;
    for (int e = 0; e < ne; ++e)
        if (dom.pinned[e] == 1) solid_volume += cache.volume[e];
    const double min_volume = solid_volume + config.rho_min * (vtotal - solid_volume);
    if (min_volume > vcap * (1.0 + 1e-9))
        throw std::runtime_error(
            "optimize_shell_compliance: volume fraction " +
            std::to_string(config.volume_fraction) +
            " is infeasible — the minimum reachable volume fraction is " +
            std::to_string(min_volume / vtotal) + " given rho_min and the pinned-solid volume");

    const double r_min = config.filter_radius > 0.0 ? config.filter_radius
                                                     : default_filter_radius(cache.volume);
    const DensityFilter filter(cache.centroid, r_min);

    std::vector<double> rho(ne, config.rho_min);
    for (const int e : config.passive_solid) rho[e] = 1.0;
    for (const int e : dom.active) rho[e] = config.volume_fraction;

    const std::vector<double> xmin(nact, config.rho_min);
    const std::vector<double> xmax(nact, 1.0);
    MMAOptimizer mma(nact, 1, xmin, xmax, config.move_limit);

    std::vector<double> x(nact);
    for (int k = 0; k < nact; ++k) x[k] = rho[dom.active[k]];

    ShellTopOptResult result;
    result.history.reserve(config.max_iterations);
    double obj_scale = -1.0;  // 1/c₀, fixed at iteration 1 to keep MMA scaled

    for (int it = 1;; ++it) {
        ShellComplianceEvaluation ev = evaluate_shell_compliance(
            in, cache, rho, config.penalty, config.emin_rel, config.cg_rtol);
        result.displacements = ev.displacements;
        if (obj_scale < 0.0) obj_scale = ev.compliance > 0.0 ? 1.0 / ev.compliance : 1.0;

        std::vector<double> sens = ev.dcompliance;
        filter.filter_sensitivity(rho, sens);

        double vol_used = 0.0;
        for (int e = 0; e < ne; ++e) vol_used += rho[e] * cache.volume[e];
        const double vol_frac = vol_used / vtotal;

        std::vector<double> df0(nact);
        std::vector<double> dfdx(nact);
        for (int k = 0; k < nact; ++k) {
            const int e = dom.active[k];
            df0[k] = sens[e] * obj_scale;
            dfdx[k] = cache.volume[e] / vcap;
        }
        const std::vector<double> fval = {(vol_used / vcap) - 1.0};
        const double f0 = ev.compliance * obj_scale;

        const std::vector<double> xnew = mma.update(x, f0, df0, fval, dfdx);
        double change = 0.0;
        for (int k = 0; k < nact; ++k) change = std::max(change, std::abs(xnew[k] - x[k]));

        std::array<char, 128> line;
        std::snprintf(line.data(), line.size(),
                      "[topopt] it %d: c=%.6g vol=%.4f change=%.4g", it, ev.compliance,
                      vol_frac, change);
        std::printf("%s\n", line.data());
        std::fflush(stdout);
        result.history.push_back({it, ev.compliance, vol_frac, change});
        result.iterations = it;

        if (change < config.tolerance) {
            result.converged = true;
            break;
        }
        if (it >= config.max_iterations) break;

        x = xnew;
        for (int k = 0; k < nact; ++k) rho[dom.active[k]] = xnew[k];
    }

    result.density = rho;
    return result;
}

}  // namespace kofem::topopt
