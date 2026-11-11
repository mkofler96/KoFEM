// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Tie constraints of the all-solid solve (issue #357): a tied (slave) node
// follows the surface it is tied to,
//
//     u_slave = Σ wᵢ · u_masterᵢ ,   Σ wᵢ = 1 .
//
// On linear elements the weights are dual mortar weights, integrated over the
// interface by the frontend (web/src/lib/tieMortar.ts); on quadratic elements
// they are the master face's shape functions at the slave node's projection
// (solve_mfem.cpp, fe_node_ties). Either way some wᵢ can be negative, and one
// master with w = 1 is a node-to-node tie. No node moves — unlike the
// node-merge tie, the two surfaces keep their geometry and only their
// displacements are coupled.
//
// The equations are applied by master-slave elimination, u = T·q: the slave
// DOFs leave the system and the reduced one, TᵀKT·q = Tᵀf, stays symmetric
// positive definite, so the same CG solve carries it. This unit turns the node
// ties into that elimination over an arbitrary DOF numbering. Free of
// MFEM/Emscripten, so it is natively testable.

#ifndef KOFEM_TIE_CONSTRAINTS_H
#define KOFEM_TIE_CONSTRAINTS_H

#include <utility>
#include <vector>

namespace kofem::fem {

// Node ties in CSR form: slave[k] follows the masters master[offsets[k] ..
// offsets[k+1]) with the matching weights.
struct NodeTies {
    std::vector<int> slave;
    std::vector<int> offsets;
    std::vector<int> master;
    std::vector<double> weights;
    bool empty() const { return slave.empty(); }
};

// The elimination u = T·q over n_dofs system DOFs and n_reduced retained ones.
struct TieReduction {
    int n_dofs = 0;
    int n_reduced = 0;
    // Per system DOF: its index in q, or −1 when it is eliminated.
    std::vector<int> reduced_of;
    // Per system DOF: for an eliminated DOF, the (index in q, coefficient)
    // combination it equals; empty for a retained DOF.
    std::vector<std::vector<std::pair<int, double>>> rows;
    // Slave DOFs eliminated, and slave DOFs left alone because an essential BC
    // already prescribes them (the BC wins: a DOF cannot be both prescribed and
    // dependent).
    int n_eliminated = 0;
    int n_prescribed = 0;
};

// Check `ties` against a mesh of n_nodes nodes — the same checks
// build_tie_reduction makes, for a caller that reads the table before handing
// it over. Throws std::runtime_error as described there.
void validate_node_ties(const NodeTies& ties, int n_nodes);

// Build the elimination for `ties` on n_nodes nodes.
//
// A node is whatever carries three translations: a mesh vertex, or any nodal
// point of a higher-order space. `node_dof[3·node + c]` is the system DOF of
// translation c of a node, and `essential[dof]` marks the DOFs an essential BC
// prescribes (n_dofs entries). A master may itself be a slave of another tie;
// such chains are substituted out, so every row references retained DOFs only.
//
// Throws std::runtime_error on inconsistent CSR arrays, out-of-range nodes, a
// node tied twice, a node tied to itself, weights that are not finite or do
// not sum to one, and on ties that depend on each other in a cycle.
TieReduction build_tie_reduction(const NodeTies& ties, int n_nodes,
                                 const std::vector<int>& node_dof,
                                 const std::vector<char>& essential);

// u = T·q for a full solution vector.
std::vector<double> expand_tied_solution(const TieReduction& reduction,
                                         const std::vector<double>& reduced);

}  // namespace kofem::fem

#endif  // KOFEM_TIE_CONSTRAINTS_H
