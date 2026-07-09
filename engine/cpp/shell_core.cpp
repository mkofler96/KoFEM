// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Kirchhoff flat-facet shell core (CST membrane + DKT bending). See shell_core.h.

#include "shell_core.h"

#include <array>
#include <cmath>
#include <map>
#include <stdexcept>
#include <string>

namespace kofem::shell {

namespace {

using Vec3 = std::array<double, 3>;

Vec3 sub(const Vec3& a, const Vec3& b) { return {a[0] - b[0], a[1] - b[1], a[2] - b[2]}; }
double dot(const Vec3& a, const Vec3& b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
Vec3 cross(const Vec3& a, const Vec3& b) {
    return {a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]};
}
double norm(const Vec3& a) { return std::sqrt(dot(a, a)); }
Vec3 scale(const Vec3& a, double s) { return {a[0] * s, a[1] * s, a[2] * s}; }

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
        B[0][2 * i] = b[i];
        B[1][2 * i + 1] = c[i];
        B[2][2 * i] = c[i];
        B[2][2 * i + 1] = b[i];
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

std::array<std::array<double, 9>, 9> bending_stiffness(
    const std::array<double, 3>& x, const std::array<double, 3>& y, double area,
    double t, double E, double nu) {
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

    // Inverse-Jacobian entries (constant over the linear triangle map):
    //   x = x0 + (x1−x0)ξ + (x2−x0)η,  detJ = 2A.
    const double det = 2.0 * area;
    const double dxi_dx = (y[2] - y[0]) / det;
    const double dxi_dy = -(x[2] - x[0]) / det;
    const double deta_dx = -(y[1] - y[0]) / det;
    const double deta_dy = (x[1] - x[0]) / det;

    const double factor = E * t * t * t / (12.0 * (1.0 - nu * nu));  // flexural D
    const auto D = constitutive(factor, nu);

    // 3-point mid-edge integration rule, equal weights A/3.
    const std::array<std::array<double, 2>, 3> gp = {{{0.5, 0.0}, {0.0, 0.5}, {0.5, 0.5}}};

    std::array<std::array<double, 9>, 9> K{};
    for (const auto& p : gp) {
        std::array<double, 9> Hx_xi{}, Hx_eta{}, Hy_xi{}, Hy_eta{};
        dkt_H_derivs(g, p[0], p[1], Hx_xi, Hx_eta, Hy_xi, Hy_eta);
        // B (3×9): [Hx,x ; Hy,y ; Hx,y + Hy,x]
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

// ── Sparse SPD system (row maps for assembly, CSR-free CG) ─────────────────────
struct Sparse {
    std::vector<std::map<int, double>> rows;
    explicit Sparse(int n) : rows(n) {}
    void add(int i, int j, double v) { rows[i][j] += v; }
    void matvec(const std::vector<double>& x, std::vector<double>& y) const {
        for (size_t i = 0; i < rows.size(); ++i) {
            double s = 0.0;
            for (const auto& [j, v] : rows[i]) s += v * x[j];
            y[i] = s;
        }
    }
};

// Diagonal-preconditioned CG. The system is SPD after essential BCs.
ShellResult cg_solve(const Sparse& K, const std::vector<double>& F) {
    const int n = static_cast<int>(F.size());
    std::vector<double> x(n, 0.0), r = F, z(n), p(n), Ap(n), invM(n);
    for (int i = 0; i < n; ++i) {
        auto it = K.rows[i].find(i);
        const double diag = (it != K.rows[i].end() && it->second != 0.0) ? it->second : 1.0;
        invM[i] = 1.0 / diag;
    }
    double bnorm = 0.0;
    for (double f : F) bnorm += f * f;
    bnorm = std::sqrt(bnorm);
    if (bnorm == 0.0) return {std::vector<double>(n, 0.0), true, 0, 0.0};

    for (int i = 0; i < n; ++i) { z[i] = invM[i] * r[i]; p[i] = z[i]; }
    double rz = 0.0;
    for (int i = 0; i < n; ++i) rz += r[i] * z[i];

    const int maxit = 20000;
    const double tol = 1e-10;
    ShellResult res;
    for (int it = 0; it < maxit; ++it) {
        K.matvec(p, Ap);
        double pAp = 0.0;
        for (int i = 0; i < n; ++i) pAp += p[i] * Ap[i];
        const double alpha = rz / pAp;
        double rnorm = 0.0;
        for (int i = 0; i < n; ++i) {
            x[i] += alpha * p[i];
            r[i] -= alpha * Ap[i];
            rnorm += r[i] * r[i];
        }
        rnorm = std::sqrt(rnorm);
        res.iterations = it + 1;
        res.rel_residual = rnorm / bnorm;
        if (res.rel_residual < tol) { res.converged = true; break; }
        for (int i = 0; i < n; ++i) z[i] = invM[i] * r[i];
        double rz_new = 0.0;
        for (int i = 0; i < n; ++i) rz_new += r[i] * z[i];
        const double beta = rz_new / rz;
        for (int i = 0; i < n; ++i) p[i] = z[i] + beta * p[i];
        rz = rz_new;
    }
    res.dofs = std::move(x);
    return res;
}

}  // namespace

ShellResult solve_shell_core(const ShellInput& in) {
    if (in.vertices.size() % 3 != 0)
        throw std::runtime_error("shell: vertices length not divisible by 3");
    if (in.triangles.size() % 3 != 0)
        throw std::runtime_error("shell: triangles length not divisible by 3");
    if (in.thickness <= 0.0)
        throw std::runtime_error("shell: thickness must be positive");
    const int nNodes = static_cast<int>(in.vertices.size() / 3);
    const int nTris = static_cast<int>(in.triangles.size() / 3);
    if (nNodes == 0 || nTris == 0)
        throw std::runtime_error("shell: mesh has no nodes or no triangles");
    const int nDof = 6 * nNodes;

    Sparse K(nDof);
    auto vtx = [&](int n) -> Vec3 {
        return {in.vertices[3 * n], in.vertices[3 * n + 1], in.vertices[3 * n + 2]};
    };

    for (int e = 0; e < nTris; ++e) {
        const int n0 = in.triangles[3 * e], n1 = in.triangles[3 * e + 1],
                  n2 = in.triangles[3 * e + 2];
        const Vec3 P0 = vtx(n0), P1 = vtx(n1), P2 = vtx(n2);

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

        // Local 2D coordinates.
        const std::array<double, 3> lx = {0.0, l1, dot(v2, e1)};
        const std::array<double, 3> ly = {0.0, 0.0, dot(v2, e2)};

        const auto Km = membrane_stiffness(lx, ly, area, in.thickness, in.young, in.poisson);
        const auto Kb = bending_stiffness(lx, ly, area, in.thickness, in.young, in.poisson);

        // Local 18×18 in per-node DOF order (u,v,w,θx,θy,θz).
        std::array<std::array<double, 18>, 18> Kl{};
        // membrane → (u,v): local dof 6i+0, 6i+1; Km order (u0,v0,u1,v1,u2,v2)
        static constexpr std::array<int, 6> mdof = {0, 1, 6, 7, 12, 13};
        for (int a = 0; a < 6; ++a)
            for (int b = 0; b < 6; ++b) Kl[mdof[a]][mdof[b]] += Km[a][b];
        // bending → (w,θx,θy): local dof 6i+2,6i+3,6i+4; Kb order (w0,θx0,θy0,…)
        static constexpr std::array<int, 9> bdof = {2, 3, 4, 8, 9, 10, 14, 15, 16};
        for (int a = 0; a < 9; ++a)
            for (int b = 0; b < 9; ++b) Kl[bdof[a]][bdof[b]] += Kb[a][b];
        // drilling θz (local dof 6i+5): tiny fictitious stiffness to remove the
        // in-plane-rotation singularity of coplanar facets. Scaled off the mean
        // bending diagonal so it is negligible vs real stiffness (no load
        // excites it on a flat plate; neighbouring facets constrain it on a
        // curved shell).
        double kdiag = 0.0;
        for (int a = 0; a < 9; ++a) kdiag += Kb[a][a];
        const double kdrill = 1e-4 * kdiag / 9.0;
        for (int i = 0; i < 3; ++i) Kl[6 * i + 5][6 * i + 5] += kdrill;

        // Transform to global: local vector = Q·global, Q rows = (e1,e2,e3).
        const std::array<std::array<double, 3>, 3> Q = {{e1, e2, e3}};
        // Build the 18×18 T (block-diag of Q for translations and rotations per
        // node), then Kg = Tᵀ·Kl·T.
        std::array<std::array<double, 18>, 18> T{};
        for (int i = 0; i < 3; ++i)          // node
            for (int blk = 0; blk < 2; ++blk)  // 0 = translation, 1 = rotation
                for (int r = 0; r < 3; ++r)
                    for (int c = 0; c < 3; ++c)
                        T[6 * i + 3 * blk + r][6 * i + 3 * blk + c] = Q[r][c];

        // Kg = Tᵀ Kl T (18×18).
        std::array<std::array<double, 18>, 18> KlT{};
        for (int i = 0; i < 18; ++i)
            for (int j = 0; j < 18; ++j) {
                double s = 0.0;
                for (int k = 0; k < 18; ++k) s += Kl[i][k] * T[k][j];
                KlT[i][j] = s;
            }
        std::array<std::array<double, 18>, 18> Kg{};
        for (int i = 0; i < 18; ++i)
            for (int j = 0; j < 18; ++j) {
                double s = 0.0;
                for (int k = 0; k < 18; ++k) s += T[k][i] * KlT[k][j];
                Kg[i][j] = s;
            }

        const std::array<int, 3> nodes = {n0, n1, n2};
        for (int a = 0; a < 18; ++a)
            for (int b = 0; b < 18; ++b) {
                if (Kg[a][b] == 0.0) continue;
                const int gi = 6 * nodes[a / 6] + a % 6;
                const int gj = 6 * nodes[b / 6] + b % 6;
                K.add(gi, gj, Kg[a][b]);
            }
    }

    // Load vector.
    std::vector<double> F(nDof, 0.0);
    for (const auto& [dof, val] : in.loads) {
        if (dof < 0 || dof >= nDof) throw std::runtime_error("shell: load DOF out of range");
        F[dof] += val;
    }

    // Essential BCs (homogeneous): zero the fixed rows/cols, unit diagonal.
    std::vector<char> fixed(nDof, 0);
    for (int d : in.fixed_dofs) {
        if (d < 0 || d >= nDof) throw std::runtime_error("shell: fixed DOF out of range");
        fixed[d] = 1;
    }
    for (int i = 0; i < nDof; ++i) {
        if (fixed[i]) {
            K.rows[i].clear();
            K.rows[i][i] = 1.0;
            F[i] = 0.0;
        } else {
            for (auto it = K.rows[i].begin(); it != K.rows[i].end();) {
                if (fixed[it->first])
                    it = K.rows[i].erase(it);
                else
                    ++it;
            }
        }
    }

    ShellResult res = cg_solve(K, F);
    if (res.dofs.empty()) res.dofs.assign(nDof, 0.0);
    return res;
}

}  // namespace kofem::shell
