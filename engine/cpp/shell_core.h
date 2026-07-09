// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Kirchhoff (shear-free) flat-facet shell — pure C++ core, no MFEM/Emscripten
// dependency so it can be unit-tested natively (see scripts/test-shell.sh).
//
// Element: constant-strain-triangle (CST) membrane + Discrete Kirchhoff
// Triangle (DKT) bending, assembled per flat triangular facet with 6 DOF/node
// (three translations u,v,w and three rotations θx,θy,θz). The DKT enforces the
// Kirchhoff (zero transverse-shear) constraint discretely, so this is a
// Kirchhoff–Love-family element that needs only C⁰ triangle meshes — the meshes
// KoFEM's OCCT/Netgen surface stage already produces — rather than the C¹
// discretisation a classical smooth KL element would require.
//
// References:
//   Batoz, Bathe & Ho (1980), "A study of three-node triangular plate bending
//   elements", IJNME 15, 1771–1812 — the DKT bending stiffness.
//   Membrane is the standard CST plane-stress triangle.

#ifndef KOFEM_SHELL_CORE_H
#define KOFEM_SHELL_CORE_H

#include <cstddef>
#include <utility>
#include <vector>

namespace kofem::shell {

// Flat triangle surface mesh + material + boundary conditions. All node
// references are 0-based indices into the vertex array. DOF indices are
// 6·node + component, component 0..5 = (u, v, w, θx, θy, θz).
struct ShellInput {
    std::vector<double> vertices;   // 3·nNodes, xyz interleaved
    std::vector<int> triangles;     // 3·nTris, three 0-based vertex indices/tri
    double thickness = 0.0;         // shell thickness t (uniform)
    double young = 0.0;             // Young's modulus E
    double poisson = 0.0;           // Poisson ratio ν
    std::vector<int> fixed_dofs;    // global DOF indices constrained to zero
    std::vector<std::pair<int, double>> loads;  // global DOF index → force/moment
};

struct ShellResult {
    // 6 values per node: (u, v, w, θx, θy, θz), in vertex order.
    std::vector<double> dofs;
    bool converged = false;
    int iterations = 0;
    double rel_residual = 0.0;
};

// Assemble and solve the linear shell system. Throws std::runtime_error on
// malformed input (bad array lengths, degenerate triangle, empty system).
ShellResult solve_shell_core(const ShellInput& in);

}  // namespace kofem::shell

#endif  // KOFEM_SHELL_CORE_H
