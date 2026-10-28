// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// KOF-215: compare a wall/block joint against an all-solid reference before
// changing distributing-coupling weights. This is a STUDY, not an accuracy gate:
// successful solves do not certify the reported junction stresses. Both loads
// lie in the wall's plane; a one-tet-thick wall is not a trustworthy reference
// for transverse bending (linear-tet shear locking).
// Run: CXX=g++ bash scripts/study-rbe3-junction.sh

#include "shell_core.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdio>
#include <stdexcept>
#include <vector>

using namespace kofem::shell;

namespace {

enum class Model { Solid, Flat, Mpc, Distance };

const char* model_name(Model model) {
    switch (model) {
        case Model::Solid: return "solid";
        case Model::Flat: return "flat-rbe3";
        case Model::Mpc: return "relaxed-mpc";
        case Model::Distance: return "distance-rbe3";
    }
    throw std::runtime_error("junction study: unknown model");
}

struct Result {
    double peak;
    double tip;
};

Result junction(int nx, Model model, int load_axis) {
    constexpr double L = 60, W = 40, H = 6, Hw = 30, t = 2;
    constexpr double E = 210e3, nu = 0.3, P = 100;
    constexpr int nz = 2, nzw = 10;
    // Footprint faces at y=19,21; the shell lies at y=20, with no coincident
    // solid node. Every model uses this exact same block discretisation.
    const std::array<double, 10> ys = {0, 5, 10, 15, 19, 21, 25, 30, 35, 40};
    const int ny = static_cast<int>(ys.size()) - 1;
    std::vector<double> vertices;
    std::vector<int> tets, top_layer;
    auto sid = [&](int i, int j, int k) { return (i * (ny + 1) + j) * (nz + 1) + k; };
    for (int i = 0; i <= nx; ++i)
        for (double y : ys)
            for (int k = 0; k <= nz; ++k)
                vertices.insert(vertices.end(), {L * i / nx, y, H * k / nz});
    auto cube = [&](const std::array<int, 8>& nodes, bool is_top) {
        constexpr std::array<std::array<int, 4>, 6> decomposition = {{
            {0, 1, 2, 6}, {0, 2, 3, 6}, {0, 3, 7, 6},
            {0, 7, 4, 6}, {0, 4, 5, 6}, {0, 5, 1, 6}}};
        for (const auto& tet : decomposition) {
            if (is_top) top_layer.push_back(static_cast<int>(tets.size() / 4));
            for (int n : tet) tets.push_back(nodes[n]);
        }
    };
    for (int i = 0; i < nx; ++i)
        for (int j = 0; j < ny; ++j)
            for (int k = 0; k < nz; ++k)
                cube({sid(i,j,k), sid(i+1,j,k), sid(i+1,j+1,k), sid(i,j+1,k),
                      sid(i,j,k+1), sid(i+1,j,k+1), sid(i+1,j+1,k+1), sid(i,j+1,k+1)},
                     k == nz - 1);
    const int n_solid = static_cast<int>(vertices.size() / 3);
    CoupledInput in;
    in.shell_young = E;
    in.shell_poisson = nu;
    in.thickness = t;
    std::vector<int> tip_nodes;
    if (model == Model::Solid) {
        auto wid = [&](int i, int j, int k) {
            return k == 0 ? sid(i, 4 + j, nz) : n_solid + (i * 2 + j) * nzw + k - 1;
        };
        for (int i = 0; i <= nx; ++i)
            for (int j = 0; j < 2; ++j)
                for (int k = 1; k <= nzw; ++k)
                    vertices.insert(vertices.end(), {L * i / nx, ys[4+j], H + Hw * k / nzw});
        for (int i = 0; i < nx; ++i)
            for (int k = 0; k < nzw; ++k)
                cube({wid(i,0,k), wid(i+1,0,k), wid(i+1,1,k), wid(i,1,k),
                      wid(i,0,k+1), wid(i+1,0,k+1), wid(i+1,1,k+1), wid(i,1,k+1)}, false);
        for (int i = 0; i <= nx; ++i)
            for (int j = 0; j < 2; ++j) tip_nodes.push_back(wid(i, j, nzw));
    } else {
        auto wid = [&](int i, int k) { return n_solid + i * (nzw + 1) + k; };
        for (int i = 0; i <= nx; ++i)
            for (int k = 0; k <= nzw; ++k)
                vertices.insert(vertices.end(), {L * i / nx, W / 2, H + Hw * k / nzw});
        for (int i = 0; i < nx; ++i)
            for (int k = 0; k < nzw; ++k) {
                const int a = wid(i,k), b = wid(i+1,k), c = wid(i+1,k+1), d = wid(i,k+1);
                in.triangles.insert(in.triangles.end(), {a, b, c, a, c, d});
            }
        // A broad search ball of two background block spacings. This holds
        // its physical size under x refinement; it is not a contact footprint.
        const double radius = 2 * std::max(L / nx, 5.0);
        for (int i = 0; i <= nx; ++i) {
            Coupling cp;
            cp.ref_node = wid(i, 0);
            if (model == Model::Mpc) cp.kind = CouplingKind::RelaxedMpc;
            std::vector<double> distances2;
            double rmax2 = 0;
            for (int n = 0; n < n_solid; ++n) {
                double d2 = 0;
                for (int c = 0; c < 3; ++c) {
                    const double d = vertices[3*n+c] - vertices[3*cp.ref_node+c];
                    d2 += d * d;
                }
                if (d2 > radius * radius) continue;
                cp.solid_nodes.push_back(n);
                distances2.push_back(d2);
                rmax2 = std::max(rmax2, d2);
            }
            if (model == Model::Distance)
                for (double d2 : distances2) cp.weights.push_back(1 / (d2 + 0.0025 * rmax2));
            in.couplings.push_back(std::move(cp));
        }
        for (int i = 0; i <= nx; ++i) tip_nodes.push_back(wid(i, nzw));
    }
    in.vertices = vertices;
    in.n_nodes = static_cast<int>(vertices.size() / 3);
    in.solid_stiffness = tet_solid_stiffness(vertices, tets, E, nu);
    for (int i = 0; i <= nx; ++i)
        for (int j = 0; j <= ny; ++j)
            for (int c = 0; c < 3; ++c) in.fixed_dofs.push_back(6 * sid(i,j,0) + c);
    // Trapezoidal line load. The solid model has two footprint-face rows;
    // splitting the load equally gives the same force and moment as the shell.
    const int rows = model == Model::Solid ? 2 : 1;
    for (size_t k = 0; k < tip_nodes.size(); ++k) {
        const int i = static_cast<int>(k) / rows;
        const double weight = (i == 0 || i == nx) ? 0.5 : 1.0;
        in.loads.emplace_back(6 * tip_nodes[k] + load_axis, P * weight / (nx * rows));
    }
    const ShellResult solution = solve_solid_shell_core(in);
    if (!solution.converged || !std::isfinite(solution.rel_residual))
        throw std::runtime_error("junction study: solver failed to converge");
    const auto vm = tet_von_mises(vertices, tets, E, nu, solution.dofs);
    Result result{0, 0};
    for (int e : top_layer) result.peak = std::max(result.peak, vm[e]);
    for (int n : tip_nodes) result.tip += solution.dofs[6*n+load_axis] / tip_nodes.size();
    if (!std::isfinite(result.peak) || result.peak <= 0 ||
        !std::isfinite(result.tip) || result.tip <= 0)
        throw std::runtime_error("junction study: non-finite or non-positive result");
    return result;
}

}  // namespace

int main() {
    try {
        std::puts("KOF-215 junction study: N/mm/MPa; block 60x40x6, wall 60x30x2, force 100 N.");
        std::puts("Refine x only (12/20/28); y,z fixed. Peak vM in the block's top tet layer.");
        std::puts("CSV,load,nx,model,peak_vm,mean_tip_u,stress_vs_solid,tip_vs_solid");
        for (int axis : {2, 0})
            for (int nx : {12, 20, 28}) {
                const Result reference = junction(nx, Model::Solid, axis);
                for (Model model : {Model::Solid, Model::Flat, Model::Mpc, Model::Distance}) {
                    const Result result = model == Model::Solid ? reference : junction(nx, model, axis);
                    std::printf("CSV,%s,%d,%s,%.9g,%.9g,%.6f,%.6f\n",
                                axis == 2 ? "tension" : "in-plane-bending", nx, model_name(model),
                                result.peak, result.tip, result.peak / reference.peak,
                                result.tip / reference.tip);
                }
            }
        std::puts("STUDY ONLY: convergence and finite results passed; junction stress accuracy is not certified.");
    } catch (const std::exception& error) {
        std::fprintf(stderr, "%s\n", error.what());
        return 1;
    }
    return 0;
}
