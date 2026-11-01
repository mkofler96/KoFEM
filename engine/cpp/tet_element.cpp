// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Linear (4-node) tetrahedron: stiffness and stress recovery. See tet_element.h.

#include "tet_element.h"

#include <array>
#include <cmath>
#include <cstddef>
#include <stdexcept>
#include <string>

#include "small_linalg.h"

namespace kofem::shell {

std::array<std::array<double, 12>, 12> tet_element_stiffness(
    const std::vector<double>& vertices, int n0, int n1, int n2, int n3, double young,
    double poisson) {
    const double lam = young * poisson / ((1.0 + poisson) * (1.0 - 2.0 * poisson));
    const double mu = young / (2.0 * (1.0 + poisson));
    std::array<std::array<double, 6>, 6> D{};
    for (int i = 0; i < 3; ++i) {
        for (int j = 0; j < 3; ++j) D[i][j] = lam;
        D[i][i] = lam + 2.0 * mu;
        D[3 + i][3 + i] = mu;
    }
    const Vec3 p0 = vertex(vertices, n0), p1 = vertex(vertices, n1),
               p2 = vertex(vertices, n2), p3 = vertex(vertices, n3);
    const std::array<std::array<double, 3>, 3> J = {{
        {p1[0] - p0[0], p2[0] - p0[0], p3[0] - p0[0]},
        {p1[1] - p0[1], p2[1] - p0[1], p3[1] - p0[1]},
        {p1[2] - p0[2], p2[2] - p0[2], p3[2] - p0[2]},
    }};
    const double det = J[0][0] * (J[1][1] * J[2][2] - J[1][2] * J[2][1]) -
                       J[0][1] * (J[1][0] * J[2][2] - J[1][2] * J[2][0]) +
                       J[0][2] * (J[1][0] * J[2][1] - J[1][1] * J[2][0]);
    const double vol = std::fabs(det) / 6.0;
    if (vol == 0.0) throw std::runtime_error("coupled: degenerate (zero-volume) tet");
    const auto Jinv = mat3_inv(J);
    static constexpr std::array<std::array<double, 4>, 3> dNl = {{
        {-1.0, 1.0, 0.0, 0.0}, {-1.0, 0.0, 1.0, 0.0}, {-1.0, 0.0, 0.0, 1.0}}};
    std::array<std::array<double, 3>, 4> g{};
    for (int i = 0; i < 4; ++i)
        for (int k = 0; k < 3; ++k) {
            double s = 0.0;
            for (int m = 0; m < 3; ++m) s += Jinv[m][k] * dNl[m][i];
            g[i][k] = s;
        }
    std::array<std::array<double, 12>, 6> B{};
    for (int i = 0; i < 4; ++i) {
        const size_t i3 = 3 * static_cast<size_t>(i);
        const double gx = g[i][0], gy = g[i][1], gz = g[i][2];
        B[0][i3] = gx;
        B[1][i3 + 1] = gy;
        B[2][i3 + 2] = gz;
        B[3][i3] = gy; B[3][i3 + 1] = gx;
        B[4][i3 + 1] = gz; B[4][i3 + 2] = gy;
        B[5][i3] = gz; B[5][i3 + 2] = gx;
    }
    std::array<std::array<double, 12>, 6> DB{};
    for (int i = 0; i < 6; ++i)
        for (int j = 0; j < 12; ++j) {
            double s = 0.0;
            for (int k = 0; k < 6; ++k) s += D[i][k] * B[k][j];
            DB[i][j] = s;
        }
    std::array<std::array<double, 12>, 12> Ke{};
    for (int a = 0; a < 12; ++a)
        for (int b = 0; b < 12; ++b) {
            double s = 0.0;
            for (int k = 0; k < 6; ++k) s += B[k][a] * DB[k][b];
            Ke[a][b] = vol * s;
        }
    return Ke;
}

std::vector<SolidTriplet> tet_solid_stiffness(const std::vector<double>& vertices,
                                              const std::vector<int>& tets,
                                              double young, double poisson) {
    std::vector<SolidTriplet> out;
    const int nTets = static_cast<int>(tets.size() / 4);
    out.reserve(static_cast<size_t>(nTets) * 144);
    for (int e = 0; e < nTets; ++e) {
        const size_t e4 = 4 * static_cast<size_t>(e);
        const std::array<int, 4> nd = {tets[e4], tets[e4 + 1], tets[e4 + 2], tets[e4 + 3]};
        const auto Ke =
            tet_element_stiffness(vertices, nd[0], nd[1], nd[2], nd[3], young, poisson);
        for (int a = 0; a < 12; ++a)
            for (int b = 0; b < 12; ++b) {
                if (Ke[a][b] == 0.0) continue;
                out.push_back({3 * nd[a / 3] + a % 3, 3 * nd[b / 3] + b % 3, Ke[a][b]});
            }
    }
    return out;
}

std::vector<double> tet_von_mises(const std::vector<double>& vertices,
                                  const std::vector<int>& tets,
                                  const std::vector<double>& youngs,
                                  const std::vector<double>& poissons,
                                  const std::vector<int>& attributes,
                                  const std::vector<double>& dofs) {
    const size_t nMat = youngs.size();
    if (nMat == 0 || poissons.size() != nMat)
        throw std::runtime_error("tet_von_mises: need at least one material, with one "
                                 "Poisson ratio per Young's modulus");
    std::vector<double> lam(nMat), mu(nMat);
    for (size_t m = 0; m < nMat; ++m) {
        lam[m] = youngs[m] * poissons[m] / ((1.0 + poissons[m]) * (1.0 - 2.0 * poissons[m]));
        mu[m] = youngs[m] / (2.0 * (1.0 + poissons[m]));
    }
    const int nTets = static_cast<int>(tets.size() / 4);
    if (!attributes.empty() && attributes.size() != static_cast<size_t>(nTets))
        throw std::runtime_error("tet_von_mises: " + std::to_string(attributes.size()) +
                                 " attributes for " + std::to_string(nTets) + " tets");
    std::vector<double> out(nTets);
    for (int e = 0; e < nTets; ++e) {
        const int attr = attributes.empty() ? 1 : attributes[e];
        if (attr < 1 || static_cast<size_t>(attr) > nMat)
            throw std::runtime_error("tet_von_mises: tet " + std::to_string(e) +
                                     " selects material " + std::to_string(attr) +
                                     ", outside 1.." + std::to_string(nMat));
        const size_t m = static_cast<size_t>(attr) - 1;
        const size_t e4 = 4 * static_cast<size_t>(e);
        const std::array<int, 4> nd = {tets[e4], tets[e4 + 1], tets[e4 + 2],
                                       tets[e4 + 3]};
        const Vec3 p0 = vertex(vertices, nd[0]), p1 = vertex(vertices, nd[1]),
                   p2 = vertex(vertices, nd[2]), p3 = vertex(vertices, nd[3]);
        const std::array<std::array<double, 3>, 3> J = {{
            {p1[0] - p0[0], p2[0] - p0[0], p3[0] - p0[0]},
            {p1[1] - p0[1], p2[1] - p0[1], p3[1] - p0[1]},
            {p1[2] - p0[2], p2[2] - p0[2], p3[2] - p0[2]},
        }};
        const auto Jinv = mat3_inv(J);
        static constexpr std::array<std::array<double, 4>, 3> dNl = {{
            {-1.0, 1.0, 0.0, 0.0}, {-1.0, 0.0, 1.0, 0.0}, {-1.0, 0.0, 0.0, 1.0}}};
        // constant displacement gradient: grad_u[a][k] = Σ_i u_i[a]·(∂N_i/∂x_k)
        std::array<std::array<double, 3>, 3> grad{};
        for (int i = 0; i < 4; ++i) {
            std::array<double, 3> gN{};
            for (int k = 0; k < 3; ++k)
                for (int m = 0; m < 3; ++m) gN[k] += Jinv[m][k] * dNl[m][i];
            const size_t n6 = 6 * static_cast<size_t>(nd[i]);
            for (int a = 0; a < 3; ++a)
                for (int k = 0; k < 3; ++k) grad[a][k] += dofs[n6 + a] * gN[k];
        }
        std::array<std::array<double, 3>, 3> eps{};
        for (int a = 0; a < 3; ++a)
            for (int k = 0; k < 3; ++k) eps[a][k] = 0.5 * (grad[a][k] + grad[k][a]);
        const double tr = eps[0][0] + eps[1][1] + eps[2][2];
        std::array<std::array<double, 3>, 3> sig{};
        for (int a = 0; a < 3; ++a)
            for (int k = 0; k < 3; ++k)
                sig[a][k] = (a == k ? lam[m] * tr : 0.0) + 2.0 * mu[m] * eps[a][k];
        const double trs = sig[0][0] + sig[1][1] + sig[2][2];
        double vm2 = 0.0;
        for (int a = 0; a < 3; ++a)
            for (int k = 0; k < 3; ++k) {
                const double dev = sig[a][k] - (a == k ? trs / 3.0 : 0.0);
                vm2 += dev * dev;
            }
        out[e] = std::sqrt(1.5 * vm2);
    }
    return out;
}

std::vector<double> tet_von_mises(const std::vector<double>& vertices,
                                  const std::vector<int>& tets, double young,
                                  double poisson, const std::vector<double>& dofs) {
    return tet_von_mises(vertices, tets, {young}, {poisson}, {}, dofs);
}

}  // namespace kofem::shell
