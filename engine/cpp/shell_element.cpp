// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Flat-facet Kirchhoff shell element (CST membrane + DKT bending): stiffness and
// stress recovery. See shell_element.h.

#include "shell_element.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <stdexcept>

#include "small_linalg.h"

namespace kofem::shell {

namespace {

// 3×3 plane-stress constitutive matrix (membrane) or its bending analogue: both
// share the shape [[1,ν,0],[ν,1,0],[0,0,(1-ν)/2]] scaled by a factor.
std::array<std::array<double, 3>, 3> constitutive(double factor, double nu) {
    return {{{factor, factor * nu, 0.0},
             {factor * nu, factor, 0.0},
             {0.0, 0.0, factor * (1.0 - nu) / 2.0}}};
}

// ── CST membrane stiffness (6×6), local DOF order (u0,v0,u1,v1,u2,v2) ──────────
// Constant-strain triangle, plane stress. Local nodal coords (x_i, y_i), area A.
std::array<std::array<double, 6>, 6> membrane_stiffness(
    const std::array<double, 3>& x, const std::array<double, 3>& y, double area,
    double t, double E, double nu) {
    // Strain-displacement B (3×6): ε = B·u_e, with b_i, c_i the standard CST
    // coefficients (b_i = y_j − y_k, c_i = x_k − x_j, cyclic).
    const std::array<double, 3> b = {y[1] - y[2], y[2] - y[0], y[0] - y[1]};
    const std::array<double, 3> c = {x[2] - x[1], x[0] - x[2], x[1] - x[0]};
    std::array<std::array<double, 6>, 3> B{};
    for (int i = 0; i < 3; ++i) {
        const size_t i2 = 2 * static_cast<size_t>(i);
        B[0][i2] = b[i];
        B[1][i2 + 1] = c[i];
        B[2][i2] = c[i];
        B[2][i2 + 1] = b[i];
    }
    const double inv2A = 1.0 / (2.0 * area);
    for (auto& row : B)
        for (double& v : row) v *= inv2A;

    const auto D = constitutive(E / (1.0 - nu * nu), nu);  // plane stress
    // K = t·A·Bᵀ·D·B
    std::array<std::array<double, 6>, 6> K{};
    std::array<std::array<double, 6>, 3> DB{};  // D·B (3×6)
    for (int i = 0; i < 3; ++i)
        for (int j = 0; j < 6; ++j)
            DB[i][j] = D[i][0] * B[0][j] + D[i][1] * B[1][j] + D[i][2] * B[2][j];
    for (int a = 0; a < 6; ++a)
        for (int bcol = 0; bcol < 6; ++bcol) {
            double s = 0.0;
            for (int i = 0; i < 3; ++i) s += B[i][a] * DB[i][bcol];
            K[a][bcol] = t * area * s;
        }
    return K;
}

// ── DKT bending stiffness (9×9), local DOF order (w0,θx0,θy0,w1,θx1,θy1,…) ─────
// Batoz DKT. The rotation DOFs are (θx about local x, θy about local y); the
// element interpolates the normal rotations βx=Σ Hx_i U_i, βy=Σ Hy_i U_i with
// quadratic (6-node) shape functions and the discrete Kirchhoff constraint baked
// into the Hx/Hy coefficients below.
struct DktGeom {
    std::array<double, 3> a, b, c, d, e;  // Batoz side coefficients, index 0↔side23, 1↔31, 2↔12
    double x21, x32, x13, y21, y32, y13;
};

// Evaluate the 9-vectors Hx,Hy and their ξ/η derivatives at (xi,eta).
void dkt_H_derivs(const DktGeom& g, double xi, double eta,
                  std::array<double, 9>& Hx_xi, std::array<double, 9>& Hx_eta,
                  std::array<double, 9>& Hy_xi, std::array<double, 9>& Hy_eta) {
    // Quadratic shape functions N1..N6 (corners 1-3, mid-sides 4=23,5=31,6=12)
    // and their derivatives w.r.t. ξ (=L2) and η (=L3), L1 = 1−ξ−η.
    // dN/dξ:
    const std::array<double, 6> dNxi = {
        4.0 * xi + 4.0 * eta - 3.0,  // N1
        4.0 * xi - 1.0,              // N2
        0.0,                         // N3
        4.0 * eta,                   // N4 = 4ξη
        -4.0 * eta,                  // N5 = 4η(1−ξ−η)
        4.0 - 8.0 * xi - 4.0 * eta,  // N6 = 4ξ(1−ξ−η)
    };
    const std::array<double, 6> dNeta = {
        4.0 * xi + 4.0 * eta - 3.0,  // N1
        0.0,                         // N2
        4.0 * eta - 1.0,             // N3
        4.0 * xi,                    // N4
        4.0 - 4.0 * xi - 8.0 * eta,  // N5
        -4.0 * xi,                   // N6
    };

    const auto& a = g.a;
    const auto& b = g.b;
    const auto& c = g.c;
    const auto& d = g.d;
    const auto& e = g.e;
    // Batoz Hx (coefficients of N1..N6); index k: 0→side23(N4), 1→side31(N5),
    // 2→side12(N6). Node 1 touches sides 31,12 (N5,N6); node 2 sides 23,12
    // (N4,N6); node 3 sides 23,31 (N4,N5).
    auto build = [&](const std::array<double, 6>& dN, std::array<double, 9>& Hx,
                     std::array<double, 9>& Hy) {
        // Hx = f(N), here dN are the derivatives so Hx/Hy come out as derivatives.
        // node 1
        Hx[0] = 1.5 * (a[2] * dN[5] - a[1] * dN[4]);
        Hx[1] = b[2] * dN[5] + b[1] * dN[4];
        Hx[2] = dN[0] - c[2] * dN[5] - c[1] * dN[4];
        // node 2
        Hx[3] = 1.5 * (a[0] * dN[3] - a[2] * dN[5]);
        Hx[4] = b[0] * dN[3] + b[2] * dN[5];
        Hx[5] = dN[1] - c[0] * dN[3] - c[2] * dN[5];
        // node 3
        Hx[6] = 1.5 * (a[1] * dN[4] - a[0] * dN[3]);
        Hx[7] = b[1] * dN[4] + b[0] * dN[3];
        Hx[8] = dN[2] - c[1] * dN[4] - c[0] * dN[3];

        Hy[0] = 1.5 * (d[2] * dN[5] - d[1] * dN[4]);
        Hy[1] = -dN[0] + e[2] * dN[5] + e[1] * dN[4];
        Hy[2] = -b[2] * dN[5] - b[1] * dN[4];
        Hy[3] = 1.5 * (d[0] * dN[3] - d[2] * dN[5]);
        Hy[4] = -dN[1] + e[0] * dN[3] + e[2] * dN[5];
        Hy[5] = -b[0] * dN[3] - b[2] * dN[5];
        Hy[6] = 1.5 * (d[1] * dN[4] - d[0] * dN[3]);
        Hy[7] = -dN[2] + e[1] * dN[4] + e[0] * dN[3];
        Hy[8] = -b[1] * dN[4] - b[0] * dN[3];
    };
    build(dNxi, Hx_xi, Hy_xi);
    build(dNeta, Hx_eta, Hy_eta);
}

DktGeom make_dkt_geom(const std::array<double, 3>& x, const std::array<double, 3>& y) {
    DktGeom g{};
    // side vectors: k=0 side 2-3, k=1 side 3-1, k=2 side 1-2
    const std::array<double, 3> xij = {x[1] - x[2], x[2] - x[0], x[0] - x[1]};
    const std::array<double, 3> yij = {y[1] - y[2], y[2] - y[0], y[0] - y[1]};
    for (int k = 0; k < 3; ++k) {
        const double l2 = xij[k] * xij[k] + yij[k] * yij[k];
        g.a[k] = -xij[k] / l2;
        g.b[k] = 0.75 * xij[k] * yij[k] / l2;
        g.c[k] = (0.25 * xij[k] * xij[k] - 0.5 * yij[k] * yij[k]) / l2;
        g.d[k] = -yij[k] / l2;
        g.e[k] = (0.25 * yij[k] * yij[k] - 0.5 * xij[k] * xij[k]) / l2;
    }
    return g;
}

// DKT curvature-displacement matrix κ = B·u_b at one parametric point.
std::array<std::array<double, 9>, 3> dkt_curvature_B(
    const DktGeom& g, const std::array<double, 3>& x, const std::array<double, 3>& y,
    double area, double xi, double eta) {
    const double det = 2.0 * area;
    const double dxi_dx = (y[2] - y[0]) / det;
    const double dxi_dy = -(x[2] - x[0]) / det;
    const double deta_dx = -(y[1] - y[0]) / det;
    const double deta_dy = (x[1] - x[0]) / det;
    std::array<double, 9> Hx_xi{}, Hx_eta{}, Hy_xi{}, Hy_eta{};
    dkt_H_derivs(g, xi, eta, Hx_xi, Hx_eta, Hy_xi, Hy_eta);
    std::array<std::array<double, 9>, 3> B{};
    for (int i = 0; i < 9; ++i) {
        const double Hx_x = Hx_xi[i] * dxi_dx + Hx_eta[i] * deta_dx;
        const double Hx_y = Hx_xi[i] * dxi_dy + Hx_eta[i] * deta_dy;
        const double Hy_x = Hy_xi[i] * dxi_dx + Hy_eta[i] * deta_dx;
        const double Hy_y = Hy_xi[i] * dxi_dy + Hy_eta[i] * deta_dy;
        B[0][i] = Hx_x;
        B[1][i] = Hy_y;
        B[2][i] = Hx_y + Hy_x;
    }
    return B;
}

std::array<std::array<double, 9>, 9> bending_stiffness(
    const std::array<double, 3>& x, const std::array<double, 3>& y, double area,
    double t, double E, double nu) {
    const DktGeom g = make_dkt_geom(x, y);

    const double factor = E * t * t * t / (12.0 * (1.0 - nu * nu));  // flexural D
    const auto D = constitutive(factor, nu);

    // 3-point mid-edge integration rule, equal weights A/3.
    const std::array<std::array<double, 2>, 3> gp = {{{0.5, 0.0}, {0.0, 0.5}, {0.5, 0.5}}};

    std::array<std::array<double, 9>, 9> K{};
    for (const auto& p : gp) {
        const auto B = dkt_curvature_B(g, x, y, area, p[0], p[1]);
        std::array<std::array<double, 9>, 3> DB{};
        for (int i = 0; i < 3; ++i)
            for (int j = 0; j < 9; ++j)
                DB[i][j] = D[i][0] * B[0][j] + D[i][1] * B[1][j] + D[i][2] * B[2][j];
        const double w = area / 3.0;
        for (int a = 0; a < 9; ++a)
            for (int bcol = 0; bcol < 9; ++bcol) {
                double s = 0.0;
                for (int i = 0; i < 3; ++i) s += B[i][a] * DB[i][bcol];
                K[a][bcol] += w * s;
            }
    }
    return K;
}

}  // namespace

std::array<std::array<double, 18>, 18> facet_global_stiffness(
    const std::vector<double>& V, int n0, int n1, int n2, double t, double E, double nu) {
    const Vec3 P0 = vertex(V, n0), P1 = vertex(V, n1), P2 = vertex(V, n2);

    // Local orthonormal frame: e1 along P0→P1, e3 = normal, e2 = e3×e1.
    const Vec3 v1 = sub(P1, P0), v2 = sub(P2, P0);
    const double l1 = norm(v1);
    if (l1 == 0.0) throw std::runtime_error("shell: degenerate triangle (coincident nodes)");
    const Vec3 e1 = scale(v1, 1.0 / l1);
    Vec3 e3 = cross(v1, v2);
    const double twoA = norm(e3);
    if (twoA == 0.0) throw std::runtime_error("shell: degenerate triangle (zero area)");
    e3 = scale(e3, 1.0 / twoA);
    const Vec3 e2 = cross(e3, e1);
    const double area = 0.5 * twoA;

    const std::array<double, 3> lx = {0.0, l1, dot(v2, e1)};
    const std::array<double, 3> ly = {0.0, 0.0, dot(v2, e2)};

    const auto Km = membrane_stiffness(lx, ly, area, t, E, nu);
    const auto Kb = bending_stiffness(lx, ly, area, t, E, nu);

    std::array<std::array<double, 18>, 18> Kl{};
    static constexpr std::array<int, 6> mdof = {0, 1, 6, 7, 12, 13};
    for (int a = 0; a < 6; ++a)
        for (int b = 0; b < 6; ++b) Kl[mdof[a]][mdof[b]] += Km[a][b];
    static constexpr std::array<int, 9> bdof = {2, 3, 4, 8, 9, 10, 14, 15, 16};
    for (int a = 0; a < 9; ++a)
        for (int b = 0; b < 9; ++b) Kl[bdof[a]][bdof[b]] += Kb[a][b];
    // drilling θz: tiny fictitious stiffness (removes the coplanar in-plane
    // rotation singularity; no load excites it on a flat facet).
    double kdiag = 0.0;
    for (int a = 0; a < 9; ++a) kdiag += Kb[a][a];
    const double kdrill = 1e-4 * kdiag / 9.0;
    for (int i = 0; i < 3; ++i) Kl[6 * i + 5][6 * i + 5] += kdrill;

    // Transform to global: local vector = Q·global, Q rows = (e1,e2,e3).
    const std::array<std::array<double, 3>, 3> Q = {{e1, e2, e3}};
    std::array<std::array<double, 18>, 18> T{};
    for (int i = 0; i < 3; ++i)
        for (int blk = 0; blk < 2; ++blk)
            for (int r = 0; r < 3; ++r)
                for (int c = 0; c < 3; ++c)
                    T[6 * i + 3 * blk + r][6 * i + 3 * blk + c] = Q[r][c];

    std::array<std::array<double, 18>, 18> KlT{};
    for (int i = 0; i < 18; ++i)
        for (int j = 0; j < 18; ++j) {
            double s = 0.0;
            for (int k = 0; k < 18; ++k) s += Kl[i][k] * T[k][j];
            KlT[i][j] = s;
        }
    std::array<std::array<double, 18>, 18> KG{};
    for (int a = 0; a < 18; ++a)
        for (int b = 0; b < 18; ++b) {
            double s = 0.0;
            for (int k = 0; k < 18; ++k) s += T[k][a] * KlT[k][b];
            KG[a][b] = s;
        }
    return KG;
}

std::vector<double> shell_von_mises(const std::vector<double>& vertices,
                                    const std::vector<int>& triangles,
                                    double thickness,
                                    const std::vector<double>& thicknesses,
                                    double young, double poisson,
                                    const std::vector<double>& dofs) {
    const int nTris = static_cast<int>(triangles.size() / 3);
    const bool per_facet = static_cast<int>(thicknesses.size()) == nTris;
    // plane-stress von Mises of (σx, σy, τ)
    auto vm = [](double sx, double sy, double txy) {
        return std::sqrt(sx * sx - sx * sy + sy * sy + 3.0 * txy * txy);
    };
    const auto Dpl = constitutive(young / (1.0 - poisson * poisson), poisson);
    auto stress = [&](const std::array<double, 3>& strain) -> std::array<double, 3> {
        std::array<double, 3> s{};
        for (int a = 0; a < 3; ++a)
            for (int b = 0; b < 3; ++b) s[a] += Dpl[a][b] * strain[b];
        return s;
    };

    std::vector<double> out(nTris);
    for (int e = 0; e < nTris; ++e) {
        const size_t e3idx = 3 * static_cast<size_t>(e);
        const std::array<int, 3> nd = {triangles[e3idx], triangles[e3idx + 1],
                                       triangles[e3idx + 2]};
        const Vec3 P0 = vertex(vertices, nd[0]), P1 = vertex(vertices, nd[1]),
                   P2 = vertex(vertices, nd[2]);
        const Vec3 v1 = sub(P1, P0), v2 = sub(P2, P0);
        const double l1 = norm(v1);
        const Vec3 e1 = scale(v1, 1.0 / l1);
        Vec3 e3 = cross(v1, v2);
        const double twoA = norm(e3);
        e3 = scale(e3, 1.0 / twoA);
        const Vec3 e2 = cross(e3, e1);
        const double area = 0.5 * twoA;
        const std::array<double, 3> lx = {0.0, l1, dot(v2, e1)};
        const std::array<double, 3> ly = {0.0, 0.0, dot(v2, e2)};

        // local nodal DOFs: translations and rotations rotated into (e1,e2,e3)
        std::array<double, 6> um{};   // (u0,v0,u1,v1,u2,v2)
        std::array<double, 9> ub{};   // (w0,θx0,θy0, …)
        for (int i = 0; i < 3; ++i) {
            const size_t n6 = 6 * static_cast<size_t>(nd[i]);
            const size_t i2 = 2 * static_cast<size_t>(i);
            const size_t i3 = 3 * static_cast<size_t>(i);
            const Vec3 tg = {dofs[n6], dofs[n6 + 1], dofs[n6 + 2]};
            const Vec3 rg = {dofs[n6 + 3], dofs[n6 + 4], dofs[n6 + 5]};
            um[i2] = dot(e1, tg);
            um[i2 + 1] = dot(e2, tg);
            ub[i3] = dot(e3, tg);
            ub[i3 + 1] = dot(e1, rg);
            ub[i3 + 2] = dot(e2, rg);
        }

        // membrane strain (constant): ε = B_m·u_m with the CST coefficients
        const std::array<double, 3> b = {ly[1] - ly[2], ly[2] - ly[0], ly[0] - ly[1]};
        const std::array<double, 3> c = {lx[2] - lx[1], lx[0] - lx[2], lx[1] - lx[0]};
        const double inv2A = 1.0 / (2.0 * area);
        std::array<double, 3> em{};
        for (int i = 0; i < 3; ++i) {
            const size_t i2 = 2 * static_cast<size_t>(i);
            em[0] += inv2A * b[i] * um[i2];
            em[1] += inv2A * c[i] * um[i2 + 1];
            em[2] += inv2A * (c[i] * um[i2] + b[i] * um[i2 + 1]);
        }

        // bending curvature at the centroid: κ = B_b(⅓,⅓)·u_b
        const DktGeom g = make_dkt_geom(lx, ly);
        const auto Bb = dkt_curvature_B(g, lx, ly, area, 1.0 / 3.0, 1.0 / 3.0);
        std::array<double, 3> kap{};
        for (int a = 0; a < 3; ++a)
            for (int i = 0; i < 9; ++i) kap[a] += Bb[a][i] * ub[i];

        // σ(z) = D_pl·(ε_m + z·κ) at z = ±t/2 — report the worse surface. Taking
        // the max over both surfaces makes the result independent of the DKT
        // curvature sign convention.
        const double t = per_facet ? thicknesses[e] : thickness;
        double worst = 0.0;
        for (const double z : {+0.5 * t, -0.5 * t}) {
            const std::array<double, 3> strain = {em[0] + z * kap[0], em[1] + z * kap[1],
                                                  em[2] + z * kap[2]};
            const auto s = stress(strain);
            worst = std::max(worst, vm(s[0], s[1], s[2]));
        }
        out[e] = worst;
    }
    return out;
}

}  // namespace kofem::shell
