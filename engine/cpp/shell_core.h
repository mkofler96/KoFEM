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
    double thickness = 0.0;         // uniform thickness (fallback when per-facet empty)
    std::vector<double> thicknesses;  // optional per-triangle thickness (length nTris)
    double young = 0.0;             // Young's modulus E
    double poisson = 0.0;           // Poisson ratio ν
    std::vector<int> fixed_dofs;    // global DOF indices constrained to zero
    // Global DOF index → prescribed value: an INHOMOGENEOUS essential BC (u = g),
    // eliminated alongside fixed_dofs rather than instead of it. A DOF listed in
    // both takes the prescribed value; two conflicting values for one DOF throw.
    std::vector<std::pair<int, double>> prescribed_dofs;
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
// Which side of a coupling is eliminated, and how the dependent motion is built.
//
//   Distributing  — RBE3. ref_node's 6 DOFs are DEPENDENT: the weighted-average
//                   translation of solid_nodes plus their least-squares rotation.
//                   Adds no stiffness to the coupled set, so it idealises a
//                   surface to a point without making the surface rigid — but
//                   the point cannot be fixed or driven, only loaded.
//   RelaxedMpc    — the shell-to-solid seam variant of Distributing (see `kind`).
//   Kinematic     — RBE2. The other way round: solid_nodes are DEPENDENT and
//                   follow ref_node as a rigid body, u_i = u_R + θ_R × r_i. The
//                   point is INDEPENDENT, so it can be fixed, loaded, or tied to
//                   another point — the bolt/screw idealisation. It does make the
//                   coupled surface rigid, which is the accepted trade.
enum class CouplingKind { Distributing = 0, RelaxedMpc = 1, Kinematic = 2 };

// Bit c of a Kinematic coupling's dof_mask selects DOF c (0..2 translations,
// 3..5 rotations) of every coupled node. All six by default.
inline constexpr int kAllDofs = 0x3F;

struct Coupling {
    int ref_node = -1;                   // shell node whose 6 DOFs are dependent
    std::vector<int> solid_nodes;        // solid nodes it distributes to
    std::vector<double> weights;         // per solid node (empty ⇒ equal weights)
    // Which formulation ties this coupling — the single source of truth for it.
    //
    // RelaxedMpc is the relaxed shell-to-solid MPC of Lu, Zhang & Yang ("A Relaxed
    // MPC Method for Non-rigid Shell to Solid Coupling", J. Phys.: Conf. Ser. 2528
    // 012064, 2023): the reference (shell) node's translations are tied to the
    // DISTANCE-WEIGHTED CENTROID of its solid patch, and its rotations follow the
    // relaxation-scaled least-squares rotation of that patch. The 1/(d²+ε²) weight
    // keeps the tie local, so it enforces displacement CONTINUITY at the junction —
    // unlike the distributing RBE3 average, which spreads over the whole search
    // ball, matches only the resultant, and lets the shell separate.
    //
    // The paper ties to a solid node COINCIDENT with the shell node. An
    // auto-detected seam has none: the mid-surface sits t/2 from the footprint node
    // on either wall face, equidistant to the last bit, so tying to "the nearest"
    // picks a side by floating-point accident and welds the mid-surface to one face
    // of the wall it idealises. That ±t/2 eccentricity carries a moment the
    // structure does not, and it flips sign wherever the pick flips (KOF-212). The
    // weighted centroid of the equidistant pair IS the mid-surface, so the
    // eccentricity cancels; a genuinely coincident node still dominates the kernel
    // and recovers the paper's tie.
    //
    // Appropriate for a continuous-material seam (a thin wall idealised as shell,
    // tied back to the retained solid); Distributing stays for genuinely gapped,
    // non-conforming interfaces (a pin in a hole).
    CouplingKind kind = CouplingKind::Distributing;
    double relaxation = 1.0;  // RelaxedMpc only: ψ scaling the rotation transfer; paper uses [0.5, 1]

    // Kinematic only. A rotation bit ties θ_i = θ_R, which only exists where the
    // coupled node carries rotational stiffness — on a solid-only node there is
    // no rotation DOF to tie and the bit has no effect. Selecting the
    // translations alone is therefore NOT how a hinge is made on a solid mesh:
    // put the mask on a point-to-point coupling (one coupled node), where
    // leaving the rotations free is exactly a spherical joint.
    int dof_mask = kAllDofs;
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
    double thickness = 0.0;              // uniform thickness (fallback)
    std::vector<double> thicknesses;     // optional per-triangle thickness
    std::vector<Coupling> couplings;
    std::vector<int> fixed_dofs;         // global DOF (6·node+comp) fixed to zero
    // Global DOF → prescribed value (inhomogeneous essential BC), as ShellInput.
    // A prescribed DOF must be INDEPENDENT: like a fixed one, it cannot sit on a
    // coupling-dependent node, whose motion the reduction already governs.
    std::vector<std::pair<int, double>> prescribed_dofs;
    std::vector<std::pair<int, double>> loads;  // global DOF → force/moment
};

ShellResult solve_solid_shell_core(const CoupledInput& in);

// Helper for tests / non-MFEM callers: assemble linear-elastic tet stiffness as
// solid triplets (3·node+comp numbering). Production uses MFEM instead.
std::vector<SolidTriplet> tet_solid_stiffness(const std::vector<double>& vertices,
                                              const std::vector<int>& tets,
                                              double young, double poisson);

// ── Stress recovery ───────────────────────────────────────────────────────────
//
// Von Mises stress from a coupled solution vector (6 DOFs per node, the
// ShellResult::dofs layout).

// One value per tet: constant-strain element stress from the displacement
// gradient (translational DOFs only).
//
// `attributes[e]` is the 1-based material index of tet e into `youngs` /
// `poissons`; an empty `attributes` puts every tet on material 1. Recovering
// stress with one modulus for an assembly of several materials reports the wrong
// stress everywhere the modulus is not that one, so the selection has to reach
// this far, not just the stiffness assembly.
std::vector<double> tet_von_mises(const std::vector<double>& vertices,
                                  const std::vector<int>& tets,
                                  const std::vector<double>& youngs,
                                  const std::vector<double>& poissons,
                                  const std::vector<int>& attributes,
                                  const std::vector<double>& dofs);

// Single-material convenience overload.
std::vector<double> tet_von_mises(const std::vector<double>& vertices,
                                  const std::vector<int>& tets, double young,
                                  double poisson, const std::vector<double>& dofs);

// One value per shell triangle: plane-stress von Mises at the worse of the two
// surfaces z = ±t/2, combining the CST membrane strain with the DKT bending
// curvature at the facet centroid (σ(z) = D·(ε_m + z·κ)).
std::vector<double> shell_von_mises(const std::vector<double>& vertices,
                                    const std::vector<int>& triangles,
                                    double thickness,
                                    const std::vector<double>& thicknesses,
                                    double young, double poisson,
                                    const std::vector<double>& dofs);

}  // namespace kofem::shell

#endif  // KOFEM_SHELL_CORE_H
