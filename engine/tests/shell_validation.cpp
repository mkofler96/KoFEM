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

#include <array>
#include <cmath>
#include <cstdio>
#include <vector>

using namespace kofem::shell;

namespace {

void check(int& failures, const char* name, double got, double ref, double tol_pct) {
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
    const size_t b0 = 3 * static_cast<size_t>(n0), b1 = 3 * static_cast<size_t>(n1),
                 b2 = 3 * static_cast<size_t>(n2);
    const double ux = V[b1]-V[b0], uy = V[b1+1]-V[b0+1], uz = V[b1+2]-V[b0+2];
    const double vx = V[b2]-V[b0], vy = V[b2+1]-V[b0+1], vz = V[b2+2]-V[b0+2];
    const double cx = uy*vz-uz*vy, cy = uz*vx-ux*vz, cz = ux*vy-uy*vx;
    return 0.5 * std::sqrt(cx*cx + cy*cy + cz*cz);
}

// center deflection of a square plate under uniform pressure q, clamped or SS.
// When vm_center is given, also recovers the von Mises stress of the facet
// nearest the plate center (surface stress from membrane + bending recovery).
double plate_center_w(int& failures, double a, double t, double E, double nu, double q, int n,
                      bool clamped, double* vm_center = nullptr) {
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
    if (vm_center != nullptr) {
        const std::vector<double> vm =
            shell_von_mises(V, T, t, {}, E, nu, r.dofs);
        // von Mises of the facet whose centroid is nearest the plate center
        double best = 1e30;
        for (size_t e = 0; e < T.size() / 3; ++e) {
            const size_t b0 = 3 * static_cast<size_t>(T[3*e]),
                         b1 = 3 * static_cast<size_t>(T[3*e+1]),
                         b2 = 3 * static_cast<size_t>(T[3*e+2]);
            const double cx = (V[b0] + V[b1] + V[b2]) / 3.0 - a / 2.0;
            const double cy = (V[b0+1] + V[b1+1] + V[b2+1]) / 3.0 - a / 2.0;
            const double d2 = cx * cx + cy * cy;
            if (d2 < best) { best = d2; *vm_center = vm[e]; }
        }
    }
    return r.dofs[6 * static_cast<size_t>(id(n / 2, n / 2)) + 2];
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
    double u = 0.0;
    for (int j = 0; j <= n; ++j) u += r.dofs[6 * static_cast<size_t>(id(n, j))];
    return u / (n + 1);
}

// structured tet mesh of a box (6 tets/cell) — for the coupled solid tests.
void box_tets(double L, double W, double H, int nx, int ny, int nz,
              std::vector<double>& V, std::vector<int>& T) {
    auto id = [&](int i, int j, int k) { return i * (ny + 1) * (nz + 1) + j * (nz + 1) + k; };
    for (int i = 0; i <= nx; ++i)
        for (int j = 0; j <= ny; ++j)
            for (int k = 0; k <= nz; ++k) {
                V.push_back(L * i / nx); V.push_back(W * j / ny); V.push_back(H * k / nz);
            }
    for (int i = 0; i < nx; ++i)
        for (int j = 0; j < ny; ++j)
            for (int k = 0; k < nz; ++k) {
                const int a = id(i,j,k), b = id(i+1,j,k), c = id(i+1,j+1,k), d = id(i,j+1,k),
                          e = id(i,j,k+1), f = id(i+1,j,k+1), g = id(i+1,j+1,k+1), h = id(i,j+1,k+1);
                const std::array<std::array<int, 4>, 6> q = {{
                    {a,b,c,g},{a,c,d,g},{a,d,h,g},{a,h,e,g},{a,e,f,g},{a,f,b,g}}};
                for (const auto& tt : q) for (int m = 0; m < 4; ++m) T.push_back(tt[m]);
            }
}

// Linear-tet solid in uniaxial tension — interior elongation is exact (constant
// strain), validating tet_solid_stiffness inside the coupled assembler.
double coupled_tet_tension() {
    const double L = 4, b = 1, E = 210e9, nu = 0.3, P = 1e4;
    const int nx = 16, ny = 4, nz = 4;
    std::vector<double> V; std::vector<int> T;
    box_tets(L, b, b, nx, ny, nz, V, T);
    CoupledInput in;
    in.n_nodes = (nx + 1) * (ny + 1) * (nz + 1);
    in.vertices = V;
    in.solid_stiffness = tet_solid_stiffness(V, T, E, nu);
    auto id = [&](int i, int j, int k) { return i * (ny + 1) * (nz + 1) + j * (nz + 1) + k; };
    for (int j = 0; j <= ny; ++j)
        for (int k = 0; k <= nz; ++k) in.fixed_dofs.push_back(6 * id(0, j, k) + 0);
    in.fixed_dofs.push_back(6 * id(0, 0, 0) + 1);
    in.fixed_dofs.push_back(6 * id(0, 0, 0) + 2);
    in.fixed_dofs.push_back(6 * id(0, ny, 0) + 2);
    const int nface = (ny + 1) * (nz + 1);
    for (int j = 0; j <= ny; ++j)
        for (int k = 0; k <= nz; ++k) in.loads.emplace_back(6 * id(nx, j, k) + 0, P / nface);
    ShellResult r = solve_solid_shell_core(in);
    auto planeU = [&](int i) {
        double u = 0;
        for (int j = 0; j <= ny; ++j)
            for (int k = 0; k <= nz; ++k) u += r.dofs[6 * static_cast<size_t>(id(i, j, k))];
        return u / nface;
    };
    const double du = planeU(nx * 3 / 4) - planeU(nx / 4);
    const double ref = (P / (b * b)) * (L * (nx * 3 / 4 - nx / 4) / (double)nx) / E;
    printf("  [coupled] tet interior Δu %.4e vs %.4e\n", du, ref);
    return du / ref;
}

// Distributing coupling moment transfer: a shell cantilever whose root is
// RBE3-coupled to fixed anchors behaves as a CLAMPED cantilever. A hinge coupling
// would be off by an order of magnitude, so this decisively checks moment
// transfer through the coupling.
double coupled_moment_transfer() {
    const double L = 2.0, b = 0.3, t = 0.01, E = 2.1e11, nu = 0.3, P = 100.0;
    const int nx = 20, ny = 4;
    auto id = [&](int i, int j) { return i * (ny + 1) + j; };
    std::vector<double> V; std::vector<int> Tr; std::vector<int> root, tip;
    for (int i = 0; i <= nx; ++i)
        for (int j = 0; j <= ny; ++j) { V.push_back(L * i / nx); V.push_back(b * j / ny); V.push_back(0); }
    for (int i = 0; i < nx; ++i)
        for (int j = 0; j < ny; ++j) {
            const int a = id(i,j), c = id(i+1,j), d = id(i+1,j+1), e = id(i,j+1);
            Tr.push_back(a); Tr.push_back(c); Tr.push_back(d); Tr.push_back(a); Tr.push_back(d); Tr.push_back(e);
        }
    for (int j = 0; j <= ny; ++j) { root.push_back(id(0, j)); tip.push_back(id(nx, j)); }
    const int aBase = (nx + 1) * (ny + 1);
    V.insert(V.end(), {-0.1, 0.0, 0.0,  -0.1, b, 0.0,  -0.1, b / 2, 0.1});  // 3 anchors
    CoupledInput in;
    in.n_nodes = aBase + 3; in.vertices = V; in.triangles = Tr;
    in.shell_young = E; in.shell_poisson = nu; in.thickness = t;
    for (int rn : root) { Coupling cp; cp.ref_node = rn; cp.solid_nodes = {aBase, aBase + 1, aBase + 2}; in.couplings.push_back(cp); }
    for (int aa = 0; aa < 3; ++aa) for (int c = 0; c < 3; ++c) in.fixed_dofs.push_back(6 * (aBase + aa) + c);
    for (int tn : tip) in.loads.emplace_back(6 * tn + 2, P / (double)tip.size());
    ShellResult r = solve_solid_shell_core(in);
    double w = 0;
    for (int tn : tip) w += r.dofs[6 * static_cast<size_t>(tn) + 2];
    w /= tip.size();
    const double I = b * t * t * t / 12.0, ref = P * L * L * L / (3 * E * I);
    printf("  [coupled] clamped-cantilever w %.4e vs %.4e\n", w, ref);
    return w / ref;
}

}  // namespace

int main() {
    const double a = 1.0, t = 0.01, E = 1.0e7, nu = 0.3, q = 1.0;
    const double D = E * t * t * t / (12.0 * (1.0 - nu * nu));
    int failures = 0;

    printf("Kirchhoff shell (DKT+CST) validation:\n");
    // Both plate cases converge from a discretisation error, so the finest mesh
    // must land inside a tight band; coarse meshes carry more error by design.
    check(failures, "clamped-plate", plate_center_w(failures, a, t, E, nu, q, 32, true),
          0.00126 * q * std::pow(a, 4) / D, 1.5);
    double vm_center = 0.0;
    check(failures, "simply-supported-plate",
          plate_center_w(failures, a, t, E, nu, q, 32, false, &vm_center),
          0.00406 * q * std::pow(a, 4) / D, 1.0);
    // Center bending stress of the SS plate: M = 0.0479·q·a² (ν = 0.3), and the
    // equal-biaxial state makes von Mises equal σ = 6M/t². Element-constant
    // recovery at the nearest facet centroid carries a few % discretisation.
    check(failures, "ss-plate-von-mises", vm_center, 6.0 * 0.0479 * q * a * a / (t * t), 8.0);
    check(failures, "membrane-tension", membrane_tip_u(), 1.0 * 1.0 / 1000.0, 0.5);

    printf("Coupled solid + shell (distributing coupling):\n");
    check(failures, "coupled-tet-tension", coupled_tet_tension(), 1.0, 0.2);
    check(failures, "coupled-moment-transfer", coupled_moment_transfer(), 1.0, 6.0);

    printf(failures != 0 ? "\n%d check(s) FAILED\n" : "\nall checks passed\n", failures);
    return failures != 0 ? 1 : 0;
}
