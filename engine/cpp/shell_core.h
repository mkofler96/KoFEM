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

// ── Coupled solid + shell (distributing coupling) ─────────────────────────────
//
// One assembly over a node pool that carries both solid tets and shell facets,
// each node with six DOFs (u,v,w,θx,θy,θz). Solid tets add stiffness to the
// three translations; DKT+CST shell facets add to all six. Nodes touched only by
// solids have no rotational stiffness and their rotation DOFs are auto-fixed.
//
// Shell↔solid load transfer uses a DISTRIBUTING (RBE3-style) coupling rather than
// shared nodes, so it transmits force AND moment and tolerates a non-conforming,
// offset interface (the shell mid-surface is offset from the solid face). Each
// coupling ties one shell reference node's six DOFs to the translations of a set
// of solid nodes: the reference motion is the weighted average of the solid
// translations plus a rotation from their relative motion (weighted least
// squares), and — by transpose — the shell's force/moment distributes back onto
// the solid nodes with the correct resultant and no artificial stiffening.
struct Coupling {
    int ref_node = -1;                   // shell node whose 6 DOFs are dependent
    std::vector<int> solid_nodes;        // solid nodes it distributes to
    std::vector<double> weights;         // per solid node (empty ⇒ equal weights)
};

// The solid stiffness enters as assembled triplets over a 3-DOF/node numbering
// (index 3·node+component). This lets MFEM assemble the solid (Option A) and
// hand the matrix in; the native tests provide the same triplets from a plain
// linear-tet routine. Symmetric — provide the full matrix (both i,j and j,i) or
// only the upper/lower part consistently; entries accumulate.
struct SolidTriplet {
    int i = 0;
    int j = 0;
    double v = 0.0;
};

struct CoupledInput {
    int n_nodes = 0;                     // shared node pool size
    std::vector<double> vertices;        // 3·n_nodes, xyz interleaved
    std::vector<SolidTriplet> solid_stiffness;  // over 3·node+comp
    std::vector<int> triangles;          // 3·nTris, 0-based node indices (shell)
    double shell_young = 0.0;
    double shell_poisson = 0.0;
    double thickness = 0.0;              // shell thickness
    std::vector<Coupling> couplings;
    std::vector<int> fixed_dofs;         // global DOF (6·node+comp) fixed to zero
    std::vector<std::pair<int, double>> loads;  // global DOF → force/moment
};

ShellResult solve_solid_shell_core(const CoupledInput& in);

// Helper for tests / non-MFEM callers: assemble linear-elastic tet stiffness as
// solid triplets (3·node+comp numbering). Production uses MFEM instead.
std::vector<SolidTriplet> tet_solid_stiffness(const std::vector<double>& vertices,
                                              const std::vector<int>& tets,
                                              double young, double poisson);

}  // namespace kofem::shell

#endif  // KOFEM_SHELL_CORE_H
