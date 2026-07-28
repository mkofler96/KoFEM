// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Kirchhoff flat-facet shell core (CST membrane + DKT bending). See shell_core.h.

#include "shell_core.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdio>
#include <limits>
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

// ── Sparse SPD system: sorted-vector rows for assembly; cg_solve flattens these
//    to CSR before iterating. Rows were std::map originally, but at ~40–50 bytes
//    per node-based entry the big coupled systems (~10⁷ entries, two matrices
//    alive at once) exhausted the 2 GB WASM heap — a sorted vector is 16 B/entry
//    and cache-friendly for both the O(row-width) insert and the CSR flatten. ──
struct Sparse {
    using Row = std::vector<std::pair<int, double>>;
    std::vector<Row> rows;
    explicit Sparse(int n) : rows(n) {}
    void add(int i, int j, double v) {
        Row& row = rows[i];
        auto it = std::lower_bound(
            row.begin(), row.end(), j,
            [](const std::pair<int, double>& e, int c) { return e.first < c; });
        if (it != row.end() && it->first == j)
            it->second += v;
        else
            row.insert(it, {j, v});
    }
    // Release all row storage (the CSR copy or the reduced system owns the data
    // from here on) — keeps peak memory to one matrix at a time.
    void free_rows() {
        std::vector<Row>().swap(rows);
    }
};

// CG preconditioned by symmetric Gauss-Seidel (SSOR, ω=1) — the same smoother
// class the MFEM solid path uses (GSSmoother): plain Jacobi needs several-fold
// more iterations on these shell/coupled elasticity systems and stalls the
// large fine-mesh models. The system is SPD after essential BCs.
//
// Consumes K: each assembly row is released as soon as it is copied into the
// CSR arrays, so the assembly storage and the CSR copy never coexist in full —
// this matters on the ~10⁷-entry coupled systems inside the WASM heap cap.
ShellResult cg_solve(Sparse& K, const std::vector<double>& F) {
    const int n = static_cast<int>(F.size());
    // Flatten the sorted assembly rows into CSR once: the CG matvec then scans
    // contiguous arrays. Rows are column-sorted, so diagPos splits each CSR row
    // into strict lower / diagonal / strict upper for the GS sweeps.
    std::vector<int> rowptr(n + 1, 0);
    for (int i = 0; i < n; ++i) rowptr[i + 1] = rowptr[i] + static_cast<int>(K.rows[i].size());
    const int nnz = rowptr[n];
    std::vector<int> col(nnz);
    std::vector<double> val(nnz);
    // Split each CSR row into strict lower [rowptr[i], loEnd[i]) and strict upper
    // [hiBegin[i], rowptr[i+1]). The split is by COLUMN INDEX, not by "where the
    // diagonal entry is", so a row whose diagonal is absent or exactly zero still
    // splits correctly and the sweeps below stay each other's transpose. Keying
    // the split off a stored diagonal instead made such a row consume its whole
    // span in BOTH sweeps — the upper part with a stale z — so M was no longer
    // symmetric and PCG lost the guarantee it is built on.
    std::vector<int> loEnd(n, 0), hiBegin(n, 0);
    std::vector<double> dval(n, 0.0), dinv(n, 1.0);
    for (int i = 0, p = 0; i < n; ++i) {
        loEnd[i] = p;
        bool passed_diag = false;
        for (const auto& [j, v] : K.rows[i]) {
            col[p] = j;
            val[p] = v;
            if (j < i) loEnd[i] = p + 1;
            if (j == i) {
                dval[i] = v;
                if (v != 0.0) dinv[i] = 1.0 / v;
                hiBegin[i] = p + 1;
                passed_diag = true;
            } else if (j > i && !passed_diag) {
                hiBegin[i] = p;
                passed_diag = true;
            }
            ++p;
        }
        if (!passed_diag) hiBegin[i] = p;  // row is entirely strict-lower
        Sparse::Row().swap(K.rows[i]);     // release this row's assembly storage
    }
    K.free_rows();
    auto matvec = [&](const std::vector<double>& xv, std::vector<double>& yv) {
        for (int i = 0; i < n; ++i) {
            double s = 0.0;
            for (int k = rowptr[i]; k < rowptr[i + 1]; ++k) s += val[k] * xv[col[k]];
            yv[i] = s;
        }
    };
    // ── Preconditioner ────────────────────────────────────────────────────────
    //
    // Incomplete Cholesky with zero fill, K ≈ L·Lᵀ with L constrained to the lower
    // triangle's own sparsity, falling back to SSOR (ω=1) when the factorisation
    // breaks down. IC(0) roughly halves the iteration count of SSOR on these
    // systems for one extra O(nnz)-sized array and a one-off factorisation, which
    // matters because both are O(h⁻¹) methods: the coupled crane hook needs 5.5k
    // SSOR iterations at 6 mm elements and 15.9k at 2 mm, and the growth does not
    // stop. Neither preconditioner fixes the RATE — that needs a multilevel method
    // (KOF-173, no AMG in the WASM build) — but the constant is worth having.
    //
    // Elasticity stiffness matrices are SPD without being M-matrices, so plain
    // IC(0) frequently meets a non-positive pivot. The standard remedy is used
    // here: factor K + α·diag(K) instead (Manteuffel 1980), raising α until the
    // factorisation completes.
    std::vector<double> lval(nnz, 0.0);  // strict-lower entries of L, K's sparsity
    std::vector<double> ldiag(n, 0.0);
    bool have_ic = false;
    // Shifts tried, in order: 0, then 1e-3·4ᵏ up to 0.256. The loop counts attempts
    // with an integer and derives α from it, so the escalation cannot drift.
    for (int attempt = 0; !have_ic && attempt <= 5; ++attempt) {
        const double alpha = attempt == 0 ? 0.0 : 1e-3 * std::pow(4.0, attempt - 1);
        have_ic = true;
        for (int i = 0; i < n && have_ic; ++i) {
            // Row i of L, left to right: L(i,j) = (K(i,j) − Σ_{m<j} L(i,m)L(j,m)) / L(j,j),
            // the sum taken over the columns rows i and j share (both are sorted).
            double diag_sum = 0.0;
            for (int k = rowptr[i]; k < loEnd[i]; ++k) {
                const int j = col[k];
                double s = val[k];
                int a = rowptr[i], b = rowptr[j];
                while (a < k && b < loEnd[j]) {
                    if (col[a] < col[b])
                        ++a;
                    else if (col[a] > col[b])
                        ++b;
                    else
                        s -= lval[a++] * lval[b++];
                }
                lval[k] = s / ldiag[j];
                diag_sum += lval[k] * lval[k];
            }
            const double d = dval[i] * (1.0 + alpha) - diag_sum;
            if (!(d > 0.0)) {
                have_ic = false;  // non-positive pivot — retry with a larger shift
                break;
            }
            ldiag[i] = std::sqrt(d);
        }
    }
    if (have_ic) {
        printf("[shell] preconditioner: incomplete Cholesky IC(0)\n");
    } else {
        printf("[shell] preconditioner: SSOR (IC(0) factorisation broke down)\n");
        std::vector<double>().swap(lval);
        std::vector<double>().swap(ldiag);
    }
    fflush(stdout);

    // z = M⁻¹ r. IC(0): forward solve L·y = r, backward solve Lᵀ·z = y. SSOR:
    // M = (D+L)·D⁻¹·(D+U) — forward substitution, diagonal scale, backward
    // substitution. A row with no (or a zero) diagonal takes D = 1 there, which
    // keeps M symmetric: the two sweeps use the strict lower and strict upper
    // halves, which are each other's transpose for symmetric K.
    auto apply_prec = [&](const std::vector<double>& r, std::vector<double>& z) {
        if (have_ic) {
            for (int i = 0; i < n; ++i) {
                double s = r[i];
                for (int k = rowptr[i]; k < loEnd[i]; ++k) s -= lval[k] * z[col[k]];
                z[i] = s / ldiag[i];
            }
            for (int i = n - 1; i >= 0; --i) {
                z[i] /= ldiag[i];
                // Scatter this solved component out of the rows above it: column i
                // of Lᵀ is row i of L, which CSR stores by row, so the update is
                // pushed rather than gathered.
                for (int k = rowptr[i]; k < loEnd[i]; ++k) z[col[k]] -= lval[k] * z[i];
            }
            return;
        }
        for (int i = 0; i < n; ++i) {  // (D+L)·u = r
            double s = r[i];
            for (int k = rowptr[i]; k < loEnd[i]; ++k) s -= val[k] * z[col[k]];
            z[i] = s * dinv[i];
        }
        for (int i = 0; i < n; ++i) z[i] *= (dval[i] != 0.0 ? dval[i] : 1.0);  // w = D·u
        for (int i = n - 1; i >= 0; --i) {  // (D+U)·z = w
            double s = z[i];
            for (int k = hiBegin[i]; k < rowptr[i + 1]; ++k) s -= val[k] * z[col[k]];
            z[i] = s * dinv[i];
        }
    };

    std::vector<double> x(n, 0.0), r = F, z(n), p(n), Ap(n);
    double bnorm = 0.0;
    for (double f : F) bnorm += f * f;
    bnorm = std::sqrt(bnorm);
    if (bnorm == 0.0) return {std::vector<double>(n, 0.0), true, 0, 0.0};

    apply_prec(r, z);
    p = z;
    double rz = 0.0;
    for (int i = 0; i < n; ++i) rz += r[i] * z[i];

    // An SSOR-preconditioned CG on 3D elasticity needs O(h⁻¹) ∝ O(∛n) iterations
    // — κ(M⁻¹K) grows as h⁻², and CG converges in O(√κ). A fixed cap therefore
    // stops being a safety net and becomes the thing that fails the solve as the
    // mesh is refined: the coupled crane hook needs 5.5k iterations at 6 mm
    // elements (25k unknowns) and 15.1k at 2 mm (295k unknowns), both of which
    // converge, so 1 mm runs past a flat 20000 while still descending. The
    // constant below is ~1.8× the measured need on that model, and the floor
    // leaves small systems exactly as generous as they were. A genuinely stalled
    // solve still terminates — just not before a healthy one has had its chance.
    // (The real answer is a stronger preconditioner: no AMG in the WASM build,
    // tracked as KOF-173.)
    const int maxit =
        std::max(20000, static_cast<int>(400.0 * std::cbrt(static_cast<double>(n))));
    const double tol = 1e-10;
    ShellResult res;
    for (int it = 0; it < maxit; ++it) {
        matvec(p, Ap);
        double pAp = 0.0;
        for (int i = 0; i < n; ++i) pAp += p[i] * Ap[i];
        // pᵀAp ≤ 0 on a nonzero p means the system is not positive definite along
        // that direction — CG is then solving the wrong problem and every later
        // iterate is meaningless, which shows up downstream as a residual that
        // floors and climbs. The assembled system is SPD by construction (Kᵣ =
        // TᵀKT of an SPD K, essential BCs applied), so this is a formulation or
        // conditioning failure worth naming at the point it happens rather than
        // 20000 silent iterations later.
        if (!(pAp > 0.0))
            throw std::runtime_error(
                "shell CG breakdown: pᵀAp = " + std::to_string(pAp) + " at iteration " +
                std::to_string(it) + " (relative residual " +
                std::to_string(res.rel_residual) +
                ") — the reduced system is not positive definite. Check the "
                "coupling constraints: a coupling whose reference node carries "
                "structural stiffness, or whose target patch is degenerate, "
                "destroys definiteness of Kᵣ = TᵀKT.");
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
        // Progress feed for the browser log panel — same role as the solid
        // path's CGLogMonitor, so a long coupled solve is visibly alive.
        if (it % 100 == 0) {
            printf("[shell] CG iteration %5d: relative residual %.3e\n", it, res.rel_residual);
            fflush(stdout);
        }
        if (res.rel_residual < tol) { res.converged = true; break; }
        apply_prec(r, z);
        double rz_new = 0.0;
        for (int i = 0; i < n; ++i) rz_new += r[i] * z[i];
        const double beta = rz_new / rz;
        for (int i = 0; i < n; ++i) p[i] = z[i] + beta * p[i];
        rz = rz_new;
    }
    res.dofs = std::move(x);
    return res;
}

// Assemble one DKT+CST shell facet into the global 6-DOF/node system.
void assemble_shell_element(Sparse& K, const std::vector<double>& V, int n0, int n1,
                            int n2, double t, double E, double nu) {
    auto vtx = [&](int n) -> Vec3 {
        const size_t b3 = 3 * static_cast<size_t>(n);
        return {V[b3], V[b3 + 1], V[b3 + 2]};
    };
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
    const std::array<int, 3> nodes = {n0, n1, n2};
    for (int a = 0; a < 18; ++a)
        for (int b = 0; b < 18; ++b) {
            double s = 0.0;
            for (int k = 0; k < 18; ++k) s += T[k][a] * KlT[k][b];
            if (s == 0.0) continue;
            K.add(6 * nodes[a / 6] + a % 6, 6 * nodes[b / 6] + b % 6, s);
        }
}

// 3×3 inverse (for tet shape-function gradients and the RBE3 inertia solve).
std::array<std::array<double, 3>, 3> mat3_inv(const std::array<std::array<double, 3>, 3>& m) {
    const double det =
        m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
        m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
        m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
    if (det == 0.0) throw std::runtime_error("shell: singular 3×3 matrix");
    const double id = 1.0 / det;
    std::array<std::array<double, 3>, 3> r{};
    r[0][0] = (m[1][1] * m[2][2] - m[1][2] * m[2][1]) * id;
    r[0][1] = (m[0][2] * m[2][1] - m[0][1] * m[2][2]) * id;
    r[0][2] = (m[0][1] * m[1][2] - m[0][2] * m[1][1]) * id;
    r[1][0] = (m[1][2] * m[2][0] - m[1][0] * m[2][2]) * id;
    r[1][1] = (m[0][0] * m[2][2] - m[0][2] * m[2][0]) * id;
    r[1][2] = (m[0][2] * m[1][0] - m[0][0] * m[1][2]) * id;
    r[2][0] = (m[1][0] * m[2][1] - m[1][1] * m[2][0]) * id;
    r[2][1] = (m[0][1] * m[2][0] - m[0][0] * m[2][1]) * id;
    r[2][2] = (m[0][0] * m[1][1] - m[0][1] * m[1][0]) * id;
    return r;
}

// Skew-symmetric cross-product matrix [a]× (so [a]×·b = a×b).
std::array<std::array<double, 3>, 3> skew(const Vec3& a) {
    return {{{0.0, -a[2], a[1]}, {a[2], 0.0, -a[0]}, {-a[1], a[0], 0.0}}};
}

void apply_homogeneous_bc(Sparse& K, std::vector<double>& F, const std::vector<char>& fixed) {
    const int n = static_cast<int>(F.size());
    for (int i = 0; i < n; ++i) {
        if (fixed[i] != 0) {
            K.rows[i].assign(1, {i, 1.0});
            F[i] = 0.0;
        } else {
            auto& row = K.rows[i];
            row.erase(std::remove_if(row.begin(), row.end(),
                                     [&](const std::pair<int, double>& e) {
                                         return fixed[e.first] != 0;
                                     }),
                      row.end());
        }
    }
}

}  // namespace

ShellResult solve_shell_core(const ShellInput& in) {
    if (in.vertices.size() % 3 != 0)
        throw std::runtime_error("shell: vertices length not divisible by 3");
    if (in.triangles.size() % 3 != 0)
        throw std::runtime_error("shell: triangles length not divisible by 3");
    const int nNodes = static_cast<int>(in.vertices.size() / 3);
    const int nTris = static_cast<int>(in.triangles.size() / 3);
    if (nNodes == 0 || nTris == 0)
        throw std::runtime_error("shell: mesh has no nodes or no triangles");
    const int nDof = 6 * nNodes;

    // Thickness is either a valid per-facet field or a positive uniform scalar.
    const bool per_facet = static_cast<int>(in.thicknesses.size()) == nTris;
    if (!per_facet && in.thickness <= 0.0)
        throw std::runtime_error("shell: thickness must be positive");
    if (per_facet)
        for (double tk : in.thicknesses)
            if (tk <= 0.0) throw std::runtime_error("shell: per-facet thickness must be positive");
    Sparse K(nDof);
    for (int e = 0; e < nTris; ++e) {
        const size_t e3 = 3 * static_cast<size_t>(e);
        assemble_shell_element(K, in.vertices, in.triangles[e3], in.triangles[e3 + 1],
                               in.triangles[e3 + 2], per_facet ? in.thicknesses[e] : in.thickness,
                               in.young, in.poisson);
    }

    std::vector<double> F(nDof, 0.0);
    for (const auto& [dof, val] : in.loads) {
        if (dof < 0 || dof >= nDof) throw std::runtime_error("shell: load DOF out of range");
        F[dof] += val;
    }

    std::vector<char> fixed(nDof, 0);
    for (int d : in.fixed_dofs) {
        if (d < 0 || d >= nDof) throw std::runtime_error("shell: fixed DOF out of range");
        fixed[d] = 1;
    }
    apply_homogeneous_bc(K, F, fixed);

    ShellResult res = cg_solve(K, F);
    if (res.dofs.empty()) res.dofs.assign(nDof, 0.0);
    return res;
}

// ── Coupled solid + shell ─────────────────────────────────────────────────────

std::vector<SolidTriplet> tet_solid_stiffness(const std::vector<double>& vertices,
                                              const std::vector<int>& tets,
                                              double young, double poisson) {
    const double lam = young * poisson / ((1.0 + poisson) * (1.0 - 2.0 * poisson));
    const double mu = young / (2.0 * (1.0 + poisson));
    // Isotropic 3D elasticity (Voigt: xx,yy,zz,xy,yz,zx).
    std::array<std::array<double, 6>, 6> D{};
    for (int i = 0; i < 3; ++i) {
        for (int j = 0; j < 3; ++j) D[i][j] = lam;
        D[i][i] = lam + 2.0 * mu;
        D[3 + i][3 + i] = mu;
    }
    auto vtx = [&](int n) -> Vec3 {
        const size_t b3 = 3 * static_cast<size_t>(n);
        return {vertices[b3], vertices[b3 + 1], vertices[b3 + 2]};
    };

    std::vector<SolidTriplet> out;
    const int nTets = static_cast<int>(tets.size() / 4);
    out.reserve((size_t)nTets * 144);
    for (int e = 0; e < nTets; ++e) {
        const size_t e4 = 4 * static_cast<size_t>(e);
        const std::array<int, 4> nd = {tets[e4], tets[e4 + 1], tets[e4 + 2], tets[e4 + 3]};
        const Vec3 p0 = vtx(nd[0]), p1 = vtx(nd[1]), p2 = vtx(nd[2]), p3 = vtx(nd[3]);
        // Jacobian columns = edge vectors; V = det(J)/6.
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
        // Local shape-function derivatives (columns = nodes 0..3).
        static constexpr std::array<std::array<double, 4>, 3> dNl = {{
            {-1.0, 1.0, 0.0, 0.0}, {-1.0, 0.0, 1.0, 0.0}, {-1.0, 0.0, 0.0, 1.0}}};
        // grad N_i in global coords: gradN[i][k] = Σ_m Jinv[m][k]·dNl[m][i].
        std::array<std::array<double, 3>, 4> g{};
        for (int i = 0; i < 4; ++i)
            for (int k = 0; k < 3; ++k) {
                double s = 0.0;
                for (int m = 0; m < 3; ++m) s += Jinv[m][k] * dNl[m][i];
                g[i][k] = s;
            }
        // B (6×12).
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
        // Ke = vol·Bᵀ·D·B (12×12).
        std::array<std::array<double, 12>, 6> DB{};
        for (int i = 0; i < 6; ++i)
            for (int j = 0; j < 12; ++j) {
                double s = 0.0;
                for (int k = 0; k < 6; ++k) s += D[i][k] * B[k][j];
                DB[i][j] = s;
            }
        for (int a = 0; a < 12; ++a)
            for (int b = 0; b < 12; ++b) {
                double s = 0.0;
                for (int k = 0; k < 6; ++k) s += B[k][a] * DB[k][b];
                if (s == 0.0) continue;
                out.push_back({3 * nd[a / 3] + a % 3, 3 * nd[b / 3] + b % 3, vol * s});
            }
    }
    return out;
}

namespace {

// 3×3 product.
std::array<std::array<double, 3>, 3> mat3_mul(const std::array<std::array<double, 3>, 3>& a,
                                             const std::array<std::array<double, 3>, 3>& b) {
    std::array<std::array<double, 3>, 3> r{};
    for (int i = 0; i < 3; ++i)
        for (int j = 0; j < 3; ++j)
            for (int k = 0; k < 3; ++k) r[i][j] += a[i][k] * b[k][j];
    return r;
}

}  // namespace

namespace {

// Master-slave constraint set from the distributing couplings: dep marks the
// dependent (eliminated) DOFs; Cmap[d] lists the independent-DOF combination
// each dependent DOF equals.
struct Rbe3Constraints {
    std::vector<char> dep;
    std::vector<std::vector<std::pair<int, double>>> Cmap;
};

// Distributing (RBE3) coupling: express each reference node's 6 DOFs as a
// linear combination of its solid nodes' translations — the weighted-average
// translation plus the weighted-least-squares rotation of their relative motion.
Rbe3Constraints build_rbe3_constraints(const CoupledInput& in, int nDof) {
    auto vtx = [&](int n) -> Vec3 {
        const size_t b3 = 3 * static_cast<size_t>(n);
        return {in.vertices[b3], in.vertices[b3 + 1], in.vertices[b3 + 2]};
    };
    Rbe3Constraints out;
    out.dep.assign(nDof, 0);
    out.Cmap.resize(nDof);
    for (const auto& cp : in.couplings) {
        const int R = cp.ref_node;
        if (R < 0 || 6 * R >= nDof)
            throw std::runtime_error("coupled: coupling ref_node out of range");
        const int N = static_cast<int>(cp.solid_nodes.size());
        if (N < 3) throw std::runtime_error("coupled: a coupling needs ≥3 solid nodes");
        const Vec3 pR = vtx(R);
        std::vector<double> w(N, 1.0);
        if (!cp.weights.empty()) {
            if ((int)cp.weights.size() != N) throw std::runtime_error("coupled: weights size mismatch");
            w = cp.weights;
        }
        const size_t R6 = 6 * static_cast<size_t>(R);
        for (size_t k = 0; k < 6; ++k) out.dep[R6 + k] = 1;

        if (cp.mpc) {
            // Relaxed shell-to-solid MPC (Lu, Zhang & Yang 2023): rigid translation
            // tie to the nearest solid node S — enforcing displacement CONTINUITY at
            // the coincident junction — plus a ψ-scaled least-squares rotation of the
            // coupled solid nodes about S (the unstructured generalisation of the
            // paper's finite-difference rotation stencil). See Coupling::mpc.
            const double psi = cp.relaxation;
            int S = cp.solid_nodes[0];
            double best = std::numeric_limits<double>::max();
            for (int sn : cp.solid_nodes) {
                const Vec3 d = sub(vtx(sn), pR);
                const double dd = dot(d, d);
                if (dd < best) { best = dd; S = sn; }
            }
            const Vec3 pS = vtx(S);
            std::vector<Vec3> r(N);
            Vec3 Sp = {0.0, 0.0, 0.0};  // Σ w_i r_i, r_i measured from S
            std::array<std::array<double, 3>, 3> H{};
            for (int i = 0; i < N; ++i) {
                const Vec3 pi = vtx(cp.solid_nodes[i]);
                r[i] = {pi[0] - pS[0], pi[1] - pS[1], pi[2] - pS[2]};
                for (int k = 0; k < 3; ++k) Sp[k] += w[i] * r[i][k];
                const double rr = dot(r[i], r[i]);
                for (int a = 0; a < 3; ++a)
                    for (int b = 0; b < 3; ++b)
                        H[a][b] += w[i] * ((a == b ? rr : 0.0) - r[i][a] * r[i][b]);
            }
            const auto Hinv = mat3_inv(H);
            // U_R = u_S  (translations follow the coincident solid node exactly).
            for (int c = 0; c < 3; ++c) out.Cmap[R6 + c].emplace_back(6 * S + c, 1.0);
            // Θ_R = ψ · Hinv · Σ w_i [r_i]× (u_i − u_S). Split u_i and u_S parts:
            // the [S']× u_S term collects the −u_S contribution (skew is linear).
            for (int i = 0; i < N; ++i) {
                const int sn = cp.solid_nodes[i];
                const auto M = mat3_mul(Hinv, skew(r[i]));
                for (int a = 0; a < 3; ++a)
                    for (int c = 0; c < 3; ++c)
                        out.Cmap[R6 + 3 + a].emplace_back(6 * sn + c, psi * w[i] * M[a][c]);
            }
            const auto Ms = mat3_mul(Hinv, skew(Sp));
            for (int a = 0; a < 3; ++a)
                for (int c = 0; c < 3; ++c)
                    out.Cmap[R6 + 3 + a].emplace_back(6 * S + c, -psi * Ms[a][c]);
            continue;
        }

        // Distributing (RBE3) coupling: weighted-average translation + weighted
        // least-squares rotation about the reference node.
        double W = 0.0;
        for (double wi : w) W += wi;
        Vec3 S = {0.0, 0.0, 0.0};
        std::array<std::array<double, 3>, 3> H{};
        std::vector<Vec3> r(N);
        for (int i = 0; i < N; ++i) {
            const Vec3 pi = vtx(cp.solid_nodes[i]);
            r[i] = {pi[0] - pR[0], pi[1] - pR[1], pi[2] - pR[2]};
            for (int k = 0; k < 3; ++k) S[k] += w[i] * r[i][k];
            const double rr = dot(r[i], r[i]);
            for (int a = 0; a < 3; ++a)
                for (int b = 0; b < 3; ++b)
                    H[a][b] += w[i] * ((a == b ? rr : 0.0) - r[i][a] * r[i][b]);
        }
        const auto Hinv = mat3_inv(H);
        const auto skewS = skew(S);
        for (int i = 0; i < N; ++i) {
            const int sn = cp.solid_nodes[i];
            // U_R = Σ (w_i/W) u_i  (component-diagonal).
            for (int c = 0; c < 3; ++c) out.Cmap[R6 + c].emplace_back(6 * sn + c, w[i] / W);
            // Θ_R = Hinv·Σ (w_i[r_i]× − (w_i/W)[S]×) u_i.
            const auto sr = skew(r[i]);
            std::array<std::array<double, 3>, 3> inner{};
            for (int a = 0; a < 3; ++a)
                for (int b = 0; b < 3; ++b)
                    inner[a][b] = w[i] * sr[a][b] - (w[i] / W) * skewS[a][b];
            const auto M = mat3_mul(Hinv, inner);
            for (int a = 0; a < 3; ++a)
                for (int c = 0; c < 3; ++c)
                    out.Cmap[R6 + 3 + a].emplace_back(6 * sn + c, M[a][c]);
        }
    }
    return out;
}

// Master-slave reduction K_red = Tᵀ K T (T carries Cmap on dependent rows),
// homogeneous BCs, CG solve over the independent DOFs, and recovery of the
// dependent DOFs. Consumes K row-by-row so the full and reduced systems never
// coexist in full (WASM heap headroom).
ShellResult solve_reduced_system(Sparse& K, const std::vector<double>& F,
                                 const std::vector<char>& fixed,
                                 const Rbe3Constraints& C, int nDof) {
    std::vector<int> red(nDof, -1);
    int nIndep = 0;
    for (int i = 0; i < nDof; ++i)
        if (C.dep[i] == 0) red[i] = nIndep++;

    // The expansion below is single-level by construction: a coupling's target
    // nodes must themselves be independent, so no chain has to be resolved. Check
    // it once up front — a chained target has no reduced index (red = −1) and
    // would otherwise index the reduced matrix out of bounds.
    for (int i = 0; i < nDof; ++i)
        if (C.dep[i] != 0)
            for (const auto& [q, c] : C.Cmap[i]) {
                (void)c;
                if (C.dep[q] != 0)
                    throw std::runtime_error(
                        "solve_reduced_system: the coupling on node " + std::to_string(i / 6) +
                        " targets node " + std::to_string(q / 6) +
                        ", which is itself a coupling reference node. Chained "
                        "couplings cannot be eliminated in one pass — a coupling's "
                        "target nodes must be independent.");
            }

    auto expand = [&](int dof) -> std::vector<std::pair<int, double>> {
        if (C.dep[dof] == 0) return {{dof, 1.0}};
        return C.Cmap[dof];  // entries reference independent (solid) DOFs
    };

    Sparse Kr(nIndep);
    for (int i = 0; i < nDof; ++i) {
        if (K.rows[i].empty()) continue;
        const auto ei = expand(i);
        for (const auto& [j, v] : K.rows[i]) {
            const auto ej = expand(j);
            for (const auto& [pi, ci] : ei)
                for (const auto& [pj, cj] : ej) Kr.add(red[pi], red[pj], ci * cj * v);
        }
        Sparse::Row().swap(K.rows[i]);  // row fully transformed — release it
    }
    K.free_rows();
    std::vector<double> Fr(nIndep, 0.0);
    for (int i = 0; i < nDof; ++i)
        if (F[i] != 0.0)
            for (const auto& [pi, ci] : expand(i)) Fr[red[pi]] += ci * F[i];

    std::vector<char> fr(nIndep, 0);
    for (int i = 0; i < nDof; ++i) {
        if (fixed[i] == 0) continue;
        // A fixed DOF on a dependent (RBE3 distributing-coupling reference) node
        // has no reduced-system column of its own — its motion is a weighted
        // average of the coupled solid nodes — so it cannot be constrained here.
        // Silently skipping it (the old `&& C.dep[i] == 0` guard) dropped the
        // user's constraint and still let CG converge on an under-restrained
        // model (issue #377). Refuse loudly instead.
        if (C.dep[i] != 0)
            throw std::runtime_error(
                "solve_reduced_system: fixed DOF " + std::to_string(i) + " (node " +
                std::to_string(i / 6) + ", component " + std::to_string(i % 6) +
                ") lies on a coupling-dependent node — its motion is governed by "
                "the RBE3 distributing coupling to the solid, so a direct "
                "constraint on it cannot be honoured and would otherwise be "
                "silently dropped. Constrain the coupled solid node(s) instead of "
                "the shell coupling reference node.");
        fr[red[i]] = 1;
    }
    apply_homogeneous_bc(Kr, Fr, fr);

    ShellResult rr = cg_solve(Kr, Fr);
    if (rr.dofs.empty()) rr.dofs.assign(nIndep, 0.0);

    ShellResult full;
    full.converged = rr.converged;
    full.iterations = rr.iterations;
    full.rel_residual = rr.rel_residual;
    full.dofs.assign(nDof, 0.0);
    for (int i = 0; i < nDof; ++i) {
        if (C.dep[i] == 0) {
            full.dofs[i] = rr.dofs[red[i]];
        } else {
            double s = 0.0;
            for (const auto& [q, c] : C.Cmap[i]) s += c * rr.dofs[red[q]];
            full.dofs[i] = s;
        }
    }
    return full;
}

}  // namespace

ShellResult solve_solid_shell_core(const CoupledInput& in) {
    const int nNodes = in.n_nodes;
    if (nNodes <= 0) throw std::runtime_error("coupled: n_nodes must be positive");
    if ((int)in.vertices.size() != 3 * nNodes)
        throw std::runtime_error("coupled: vertices length does not match n_nodes");
    const int nDof = 6 * nNodes;

    Sparse K(nDof);
    // Solid stiffness (triplets over 3·node+comp) → translational DOFs.
    for (const auto& tr : in.solid_stiffness) {
        const int gi = 6 * (tr.i / 3) + tr.i % 3;
        const int gj = 6 * (tr.j / 3) + tr.j % 3;
        K.add(gi, gj, tr.v);
    }
    // Shell facets → all 6 DOFs; record which nodes carry rotational stiffness.
    std::vector<char> is_shell(nNodes, 0);
    const int nTris = static_cast<int>(in.triangles.size() / 3);
    const bool per_facet = static_cast<int>(in.thicknesses.size()) == nTris;
    for (int e = 0; e < nTris; ++e) {
        const size_t e3 = 3 * static_cast<size_t>(e);
        const int a = in.triangles[e3], b = in.triangles[e3 + 1], c = in.triangles[e3 + 2];
        assemble_shell_element(K, in.vertices, a, b, c, per_facet ? in.thicknesses[e] : in.thickness,
                               in.shell_young, in.shell_poisson);
        is_shell[a] = is_shell[b] = is_shell[c] = 1;
    }

    std::vector<double> F(nDof, 0.0);
    for (const auto& [dof, val] : in.loads) {
        if (dof < 0 || dof >= nDof) throw std::runtime_error("coupled: load DOF out of range");
        F[dof] += val;
    }

    std::vector<char> fixed(nDof, 0);
    for (int d : in.fixed_dofs) {
        if (d < 0 || d >= nDof) throw std::runtime_error("coupled: fixed DOF out of range");
        fixed[d] = 1;
    }
    // A distributing-coupling reference node has all six DOFs eliminated (they
    // become the RBE3 average of its target nodes), so its rotations must NOT be
    // auto-fixed — a fixed dependent DOF is a conflict the reduction rejects
    // (#377). This lets a SOLID node be a coupling reference, which is how a
    // gapped solid↔solid interface (a pin in a hole: the two surfaces do not share
    // nodes) is tied: the pin surface nodes distribute onto the hole surface,
    // transmitting force and moment across the clearance without merging nodes.
    std::vector<char> is_coupling_ref(nNodes, 0);
    for (const auto& cp : in.couplings)
        if (cp.ref_node >= 0 && cp.ref_node < nNodes) is_coupling_ref[cp.ref_node] = 1;
    // Solid-only nodes have no rotational stiffness → auto-fix their rotations
    // (unless they are a coupling reference, whose rotations are eliminated).
    for (int n = 0; n < nNodes; ++n)
        if (is_shell[n] == 0 && is_coupling_ref[n] == 0) {
            const size_t n6 = 6 * static_cast<size_t>(n);
            for (size_t c = 3; c < 6; ++c) fixed[n6 + c] = 1;
        }

    const Rbe3Constraints constraints = build_rbe3_constraints(in, nDof);
    return solve_reduced_system(K, F, fixed, constraints, nDof);
}

// ── Stress recovery ───────────────────────────────────────────────────────────

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
    auto vtx = [&](int n) -> Vec3 {
        const size_t b3 = 3 * static_cast<size_t>(n);
        return {vertices[b3], vertices[b3 + 1], vertices[b3 + 2]};
    };
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
        const Vec3 p0 = vtx(nd[0]), p1 = vtx(nd[1]), p2 = vtx(nd[2]), p3 = vtx(nd[3]);
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

std::vector<double> shell_von_mises(const std::vector<double>& vertices,
                                    const std::vector<int>& triangles,
                                    double thickness,
                                    const std::vector<double>& thicknesses,
                                    double young, double poisson,
                                    const std::vector<double>& dofs) {
    auto vtx = [&](int n) -> Vec3 {
        const size_t b3 = 3 * static_cast<size_t>(n);
        return {vertices[b3], vertices[b3 + 1], vertices[b3 + 2]};
    };
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
        const Vec3 P0 = vtx(nd[0]), P1 = vtx(nd[1]), P2 = vtx(nd[2]);
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
