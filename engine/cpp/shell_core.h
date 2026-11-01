// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Kirchhoff (shear-free) flat-facet shell and coupled solid+shell solve drivers —
// pure C++ core, no MFEM/Emscripten dependency so it can be unit-tested natively
// (see scripts/test-shell.sh).
//
// Element: constant-strain-triangle (CST) membrane + Discrete Kirchhoff
// Triangle (DKT) bending, assembled per flat triangular facet with 6 DOF/node
// (three translations u,v,w and three rotations θx,θy,θz). The DKT enforces the
// Kirchhoff (zero transverse-shear) constraint discretely, so this is a
// Kirchhoff–Love-family element that needs only C⁰ triangle meshes — the meshes
// KoFEM's OCCT/Netgen surface stage already produces — rather than the C¹
// discretisation a classical smooth KL element would require.
//
// This file holds the two solve drivers. Their parts live in focused units:
//   shell_element.h         CST+DKT facet stiffness and shell stress recovery
//   tet_element.h           linear tet stiffness and stress recovery
//   coupling_constraints.h  RBE3 / relaxed MPC / RBE2 constraint equations
//   sparse_cg.h             sparse SPD assembly, essential BCs, preconditioned CG

#ifndef KOFEM_SHELL_CORE_H
#define KOFEM_SHELL_CORE_H

#include <utility>
#include <vector>

#include "coupling_constraints.h"
#include "tet_element.h"

namespace kofem::shell {

// Flat triangle surface mesh + material + boundary conditions. All node
// references are 0-based indices into the vertex array. DOF indices are
// 6·node + component, component 0..5 = (u, v, w, θx, θy, θz).
struct ShellInput {
    std::vector<double> vertices;   // 3·nNodes, xyz interleaved
    std::vector<int> triangles;     // 3·nTris, three 0-based vertex indices/tri
    double thickness = 0.0;         // uniform thickness (fallback when per-facet empty)
    std::vector<double> thicknesses;  // optional per-triangle thickness (length nTris)
    double young = 0.0;             // Young's modulus E
    double poisson = 0.0;           // Poisson ratio ν
    // Optional per-facet stiffness multiplier (length nTris). Empty ⇒ every facet
    // at full modulus. The facet stiffness is linear in E, so a SIMP density ρ_e
    // enters as element_scale[e] = E(ρ_e)/E₀ and scales the whole 18×18 element
    // matrix — the hook the topology optimizer (topology_shell.h) drives.
    std::vector<double> element_scale;
    std::vector<int> fixed_dofs;    // global DOF indices constrained to zero
    // Global DOF index → prescribed value: an INHOMOGENEOUS essential BC (u = g),
    // eliminated alongside fixed_dofs rather than instead of it. A DOF listed in
    // both takes the prescribed value; two conflicting values for one DOF throw.
    std::vector<std::pair<int, double>> prescribed_dofs;
    std::vector<std::pair<int, double>> loads;  // global DOF index → force/moment
    // CG relative-residual target for the iterative solve. A single accuracy-driven
    // static solve wants this tight (the default); a topology-optimization inner
    // solve loosens it (topology_shell.h) — see CoupledInput::cg_rel_tol.
    double cg_rel_tol = 1e-10;
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
// the solid nodes with the correct resultant and no artificial stiffening. The
// coupling kinds and their constraint equations are in coupling_constraints.h.
//
// The solid stiffness enters as assembled triplets (SolidTriplet, tet_element.h)
// over a 3-DOF/node numbering (index 3·node+component). This lets MFEM assemble
// the solid (Option A) and hand the matrix in; the native tests provide the same
// triplets from tet_solid_stiffness.

struct CoupledInput {
    int n_nodes = 0;                     // shared node pool size
    std::vector<double> vertices;        // 3·n_nodes, xyz interleaved
    std::vector<SolidTriplet> solid_stiffness;  // over 3·node+comp
    std::vector<int> triangles;          // 3·nTris, 0-based node indices (shell)
    double shell_young = 0.0;
    double shell_poisson = 0.0;
    double thickness = 0.0;              // uniform thickness (fallback)
    std::vector<double> thicknesses;     // optional per-triangle thickness
    // Optional per-facet stiffness multiplier (length nTris), as ShellInput. The
    // solid tets are scaled independently by pre-scaling `solid_stiffness` (each
    // tet's stiffness is linear in E), so a single SIMP density field can span
    // both the shell facets and the solid tets of a coupled design domain.
    std::vector<double> shell_scale;
    std::vector<Coupling> couplings;
    std::vector<int> fixed_dofs;         // global DOF (6·node+comp) fixed to zero
    // Global DOF → prescribed value (inhomogeneous essential BC), as ShellInput.
    // A prescribed DOF must be INDEPENDENT: like a fixed one, it cannot sit on a
    // coupling-dependent node, whose motion the reduction already governs.
    std::vector<std::pair<int, double>> prescribed_dofs;
    std::vector<std::pair<int, double>> loads;  // global DOF → force/moment
    // CG relative-residual target. Tight by default, for an accuracy-driven static
    // solve. The topology optimizer runs one solve per iteration on a SIMP system
    // whose conditioning worsens as void regions form (the E_min stiffness floor
    // drives κ up), so the achievable residual floor RISES over the run; a 1e-10
    // target then falls below what CG can reach and the solve burns the whole
    // iteration cap without ever "converging". The TO inner solve therefore sets a
    // looser, reliably-reachable target here (topology_shell.h, KOF-245), matching
    // the solid path's caller-set cg_rtol (topology_simp_core.cpp).
    double cg_rel_tol = 1e-10;
};

ShellResult solve_solid_shell_core(const CoupledInput& in);

}  // namespace kofem::shell

#endif  // KOFEM_SHELL_CORE_H
