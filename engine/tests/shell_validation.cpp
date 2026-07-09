// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Native validation of the DKT flat-facet Kirchhoff shell (engine/cpp/shell_core)
// against closed-form references. Builds with a plain host compiler — no MFEM,
// OCCT, Netgen or Emscripten — see scripts/test-shell.sh. Exits non-zero if any
// case leaves its tolerance band, so it can gate CI.
//
// References (Timoshenko & Woinowsky-Krieger, Theory of Plates and Shells):
//   clamped square plate, uniform load:  w_center = 0.00126 q a^4 / D
//   simply supported square plate:        w_center = 0.00406 q a^4 / D
//   with D = E t^3 / (12 (1 - nu^2)).
// Membrane: uniaxial tension, tip extension delta = sigma L / E.

#include "shell_core.h"

#include <cmath>
#include <cstdio>
#include <vector>

using namespace kofem::shell;

namespace {

int failures = 0;

void check(const char* name, double got, double ref, double tol_pct) {
    const double err = std::fabs(got - ref) / std::fabs(ref) * 100.0;
    const bool ok = err <= tol_pct;
    if (!ok) ++failures;
    printf("  [%s] %-28s got=%.6e ref=%.6e err=%.2f%% (tol %.1f%%)\n",
           ok ? "PASS" : "FAIL", name, got, ref, err, tol_pct);
}

// structured triangle mesh of [0,a]x[0,a] in the z=0 plane, n x n cells.
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

double tri_area(const std::vector<double>& V, int n0, int n1, int n2) {
    const double ux = V[3*n1]-V[3*n0], uy = V[3*n1+1]-V[3*n0+1], uz = V[3*n1+2]-V[3*n0+2];
    const double vx = V[3*n2]-V[3*n0], vy = V[3*n2+1]-V[3*n0+1], vz = V[3*n2+2]-V[3*n0+2];
    const double cx = uy*vz-uz*vy, cy = uz*vx-ux*vz, cz = ux*vy-uy*vx;
    return 0.5 * std::sqrt(cx*cx + cy*cy + cz*cz);
}

// center deflection of a square plate under uniform pressure q, clamped or SS.
double plate_center_w(double a, double t, double E, double nu, double q, int n, bool clamped) {
    std::vector<double> V; std::vector<int> T;
    plate_mesh(a, n, V, T);
    const int nNodes = (n + 1) * (n + 1);
    ShellInput in;
    in.vertices = V; in.triangles = T; in.thickness = t; in.young = E; in.poisson = nu;
    auto id = [&](int i, int j) { return i * (n + 1) + j; };
    for (int i = 0; i <= n; ++i)
        for (int j = 0; j <= n; ++j) {
            const bool edge = (i == 0 || i == n || j == 0 || j == n);
            const int nd = id(i, j);
            if (clamped) {
                if (edge) for (int c = 0; c < 6; ++c) in.fixed_dofs.push_back(6 * nd + c);
            } else {
                if (edge) in.fixed_dofs.push_back(6 * nd + 2);  // w = 0
                // isolate bending: pin in-plane translations + drilling everywhere
                in.fixed_dofs.push_back(6 * nd + 0);
                in.fixed_dofs.push_back(6 * nd + 1);
                in.fixed_dofs.push_back(6 * nd + 5);
            }
        }
    std::vector<double> Fz(nNodes, 0.0);
    for (size_t e = 0; e < T.size() / 3; ++e) {
        const int n0 = T[3*e], n1 = T[3*e+1], n2 = T[3*e+2];
        const double f = q * tri_area(V, n0, n1, n2) / 3.0;
        Fz[n0] += f; Fz[n1] += f; Fz[n2] += f;
    }
    for (int nd = 0; nd < nNodes; ++nd)
        if (Fz[nd] != 0.0) in.loads.emplace_back(6 * nd + 2, Fz[nd]);
    ShellResult r = solve_shell_core(in);
    if (!r.converged) { printf("  [FAIL] CG did not converge\n"); ++failures; }
    return r.dofs[6 * id(n / 2, n / 2) + 2];
}

double membrane_tip_u() {
    const double a = 1.0, t = 0.1, E = 1000.0, nu = 0.0, sigma = 1.0;
    const int n = 8;
    std::vector<double> V; std::vector<int> T;
    plate_mesh(a, n, V, T);
    const int nNodes = (n + 1) * (n + 1);
    ShellInput in; in.vertices = V; in.triangles = T; in.thickness = t; in.young = E; in.poisson = nu;
    auto id = [&](int i, int j) { return i * (n + 1) + j; };
    for (int nd = 0; nd < nNodes; ++nd)
        for (int c : {2, 3, 4, 5}) in.fixed_dofs.push_back(6 * nd + c);  // no bending
    for (int j = 0; j <= n; ++j) {
        in.fixed_dofs.push_back(6 * id(0, j) + 0);
        in.fixed_dofs.push_back(6 * id(0, j) + 1);
    }
    const double Ftot = sigma * a * t;
    for (int j = 0; j <= n; ++j) {
        const double wgt = (j == 0 || j == n) ? 0.5 : 1.0;
        in.loads.emplace_back(6 * id(n, j) + 0, Ftot * wgt / n);
    }
    ShellResult r = solve_shell_core(in);
    double u = 0.0; for (int j = 0; j <= n; ++j) u += r.dofs[6 * id(n, j) + 0];
    return u / (n + 1);
}

}  // namespace

int main() {
    const double a = 1.0, t = 0.01, E = 1.0e7, nu = 0.3, q = 1.0;
    const double D = E * t * t * t / (12.0 * (1.0 - nu * nu));

    printf("Kirchhoff shell (DKT+CST) validation:\n");
    // Both plate cases converge from a discretisation error, so the finest mesh
    // must land inside a tight band; coarse meshes carry more error by design.
    check("clamped-plate", plate_center_w(a, t, E, nu, q, 32, true),
          0.00126 * q * std::pow(a, 4) / D, 1.5);
    check("simply-supported-plate", plate_center_w(a, t, E, nu, q, 32, false),
          0.00406 * q * std::pow(a, 4) / D, 1.0);
    check("membrane-tension", membrane_tip_u(), 1.0 * 1.0 / 1000.0, 0.5);

    printf(failures ? "\n%d check(s) FAILED\n" : "\nall checks passed\n", failures);
    return failures ? 1 : 0;
}
