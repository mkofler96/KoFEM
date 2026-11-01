// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Coupling constraints as master-slave DOF equations over a 6-DOF/node numbering
// (index 6·node+component, component 0..5 = u,v,w,θx,θy,θz).
//
// Each coupling ties a reference node to a set of other nodes. Building the
// constraints turns every coupling into equations "dependent DOF = linear
// combination of other DOFs"; resolving chains then rewrites them so each
// dependent DOF references independent DOFs only, which is what a one-pass
// reduction K_r = TᵀKT needs. Independent of the shell solve, and free of
// MFEM/Emscripten so it is natively testable.

#ifndef KOFEM_COUPLING_CONSTRAINTS_H
#define KOFEM_COUPLING_CONSTRAINTS_H

#include <utility>
#include <vector>

namespace kofem::shell {

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
enum class CouplingKind { Distributing = 0, RelaxedMpc = 1, Kinematic = 2, ShellFootprint = 3 };

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

// Master-slave constraint set: dep marks the dependent (eliminated) DOFs; Cmap[d]
// lists the (DOF, coefficient) combination each dependent DOF equals. Both are
// sized to the full DOF count.
struct CouplingConstraints {
    std::vector<char> dep;
    std::vector<std::vector<std::pair<int, double>>> Cmap;
};

// Express every coupling as master-slave equations over nDof = 6·nNodes DOFs.
// `vertices` holds 3·nNodes coordinates. `has_rotation[n]` marks the nodes whose
// rotation DOFs actually exist in the system — shell nodes and coupling reference
// points; a rotation cannot be tied on a node that has none (a solid-only node's
// rotations are auto-fixed).
//
// Distributing and RelaxedMpc couplings make the reference node's 6 DOFs a linear
// combination of its solid nodes' translations; Kinematic couplings make the
// coupled nodes follow the reference node rigidly. Throws std::runtime_error on
// out-of-range nodes, too few coupled nodes, mismatched weights, a degenerate
// patch, or a DOF claimed by two constraints.
CouplingConstraints build_coupling_constraints(const std::vector<double>& vertices,
                                               const std::vector<Coupling>& couplings,
                                               int nDof,
                                               const std::vector<char>& has_rotation);

// Substitute dependent DOFs out of each other's constraint rows until every row
// references independent DOFs only.
//
// Constraints compose: a reference point can idealise a surface (its coupled
// nodes depend on the point) and at the same time be tied to a second point (the
// point depends on that one). The reduction eliminates dependent DOFs in ONE
// pass, so it needs each row already expressed in independent DOFs — which is
// exactly this substitution, run to a fixpoint. Without it that perfectly
// ordinary screw connection is rejected as a "chained coupling". Throws
// std::runtime_error when constraints form a cycle.
void resolve_constraint_chains(CouplingConstraints& C, int nDof);

}  // namespace kofem::shell

#endif  // KOFEM_COUPLING_CONSTRAINTS_H
