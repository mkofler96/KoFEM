// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Tie constraints as a master-slave elimination. See tie_constraints.h.

#include "tie_constraints.h"

#include <cmath>
#include <cstddef>
#include <stdexcept>
#include <string>

#include "coupling_constraints.h"

namespace kofem::fem {

namespace {

constexpr int kComponents = 3;
// Shape functions sum to one exactly; this only absorbs the round-off of
// computing them in the caller.
constexpr double kWeightSumTolerance = 1e-8;

[[noreturn]] void fail(const std::string& message) {
    throw std::runtime_error("tie constraints: " + message);
}

}  // namespace

void validate_node_ties(const NodeTies& ties, int n_nodes) {
    const size_t n_ties = ties.slave.size();
    if (ties.offsets.size() != n_ties + 1 || ties.offsets.front() != 0 ||
        ties.offsets.back() != static_cast<int>(ties.master.size()) ||
        ties.weights.size() != ties.master.size())
        fail("slave, offsets, master and weights do not describe one CSR table");

    std::vector<char> is_slave(static_cast<size_t>(n_nodes), 0);
    for (size_t k = 0; k < n_ties; ++k) {
        const int slave = ties.slave[k];
        if (slave < 0 || slave >= n_nodes)
            fail("tied node " + std::to_string(slave) + " is outside the mesh (0.." +
                 std::to_string(n_nodes - 1) + ")");
        if (is_slave[slave] != 0)
            fail("node " + std::to_string(slave) +
                 " is tied twice — a node can follow only one surface");
        is_slave[slave] = 1;

        const int begin = ties.offsets[k];
        const int end = ties.offsets[k + 1];
        if (begin < 0 || end > static_cast<int>(ties.master.size()))
            fail("offsets of node " + std::to_string(slave) + " leave the CSR table");
        if (end <= begin)
            fail("node " + std::to_string(slave) + " is tied to no node at all");
        double sum = 0.0;
        for (int i = begin; i < end; ++i) {
            const int master = ties.master[i];
            const double weight = ties.weights[i];
            if (master < 0 || master >= n_nodes)
                fail("node " + std::to_string(slave) + " is tied to node " +
                     std::to_string(master) + ", which is outside the mesh");
            if (master == slave)
                fail("node " + std::to_string(slave) + " is tied to itself");
            if (!std::isfinite(weight))
                fail("node " + std::to_string(slave) + " has a non-finite tie weight");
            sum += weight;
        }
        if (std::abs(sum - 1.0) > kWeightSumTolerance)
            fail("the tie weights of node " + std::to_string(slave) + " sum to " +
                 std::to_string(sum) + ", not 1 — the tie would not follow a rigid motion");
    }
}

namespace {

// Ties that depend on each other have no elimination order. Checked on nodes,
// where the message can name them; the DOF-level substitution below then never
// meets a cycle (dropping a prescribed DOF only removes dependencies).
void reject_cycles(const NodeTies& ties, int n_nodes) {
    std::vector<int> tie_of(static_cast<size_t>(n_nodes), -1);
    for (size_t k = 0; k < ties.slave.size(); ++k) tie_of[ties.slave[k]] = static_cast<int>(k);

    enum : char { Unvisited = 0, InProgress = 1, Done = 2 };
    std::vector<char> state(ties.slave.size(), Unvisited);
    // Explicit stack: WASM stacks are small and a chain can be long.
    std::vector<std::pair<int, int>> stack;  // (tie, next master position)
    for (size_t start = 0; start < ties.slave.size(); ++start) {
        if (state[start] != Unvisited) continue;
        state[start] = InProgress;
        stack.emplace_back(static_cast<int>(start), ties.offsets[start]);
        while (!stack.empty()) {
            const int tie = stack.back().first;
            const int position = stack.back().second;
            if (position == ties.offsets[tie + 1]) {
                state[tie] = Done;
                stack.pop_back();
                continue;
            }
            ++stack.back().second;
            const int next = tie_of[ties.master[position]];
            if (next < 0 || state[next] == Done) continue;
            if (state[next] == InProgress)
                fail("nodes " + std::to_string(ties.slave[tie]) + " and " +
                     std::to_string(ties.slave[next]) +
                     " are tied to each other in a cycle — one of the two surfaces must lead");
            state[next] = InProgress;
            stack.emplace_back(next, ties.offsets[next]);
        }
    }
}

}  // namespace

TieReduction build_tie_reduction(const NodeTies& ties, int n_nodes,
                                 const std::vector<int>& node_dof,
                                 const std::vector<char>& essential) {
    const int n_dofs = static_cast<int>(essential.size());
    if (n_nodes < 0 || node_dof.size() != static_cast<size_t>(kComponents) * n_nodes)
        fail("node_dof must hold three DOFs per node");
    for (int dof : node_dof)
        if (dof < 0 || dof >= n_dofs)
            fail("node_dof references DOF " + std::to_string(dof) + " outside the system");

    TieReduction out;
    out.n_dofs = n_dofs;
    out.reduced_of.assign(n_dofs, -1);
    out.rows.resize(n_dofs);

    kofem::shell::CouplingConstraints constraints;
    constraints.dep.assign(n_dofs, 0);
    constraints.Cmap.resize(n_dofs);
    if (!ties.empty()) {
        validate_node_ties(ties, n_nodes);
        reject_cycles(ties, n_nodes);
        for (size_t k = 0; k < ties.slave.size(); ++k)
            for (int c = 0; c < kComponents; ++c) {
                const int dof = node_dof[kComponents * ties.slave[k] + c];
                if (essential[dof] != 0) {
                    ++out.n_prescribed;
                    continue;
                }
                constraints.dep[dof] = 1;
                for (int i = ties.offsets[k]; i < ties.offsets[k + 1]; ++i)
                    if (ties.weights[i] != 0.0)
                        constraints.Cmap[dof].emplace_back(
                            node_dof[kComponents * ties.master[i] + c], ties.weights[i]);
                ++out.n_eliminated;
            }
        kofem::shell::resolve_constraint_chains(constraints, n_dofs);
    }

    for (int dof = 0; dof < n_dofs; ++dof)
        if (constraints.dep[dof] == 0) out.reduced_of[dof] = out.n_reduced++;
    for (int dof = 0; dof < n_dofs; ++dof) {
        if (constraints.dep[dof] == 0) continue;
        out.rows[dof].reserve(constraints.Cmap[dof].size());
        for (const auto& [master, weight] : constraints.Cmap[dof])
            out.rows[dof].emplace_back(out.reduced_of[master], weight);
    }
    return out;
}

std::vector<double> expand_tied_solution(const TieReduction& reduction,
                                         const std::vector<double>& reduced) {
    if (reduced.size() != static_cast<size_t>(reduction.n_reduced))
        fail("reduced solution has " + std::to_string(reduced.size()) + " entries for " +
             std::to_string(reduction.n_reduced) + " retained DOFs");
    std::vector<double> full(static_cast<size_t>(reduction.n_dofs), 0.0);
    for (int dof = 0; dof < reduction.n_dofs; ++dof) {
        if (reduction.reduced_of[dof] >= 0) {
            full[dof] = reduced[reduction.reduced_of[dof]];
            continue;
        }
        for (const auto& [index, weight] : reduction.rows[dof]) full[dof] += weight * reduced[index];
    }
    return full;
}

}  // namespace kofem::fem
