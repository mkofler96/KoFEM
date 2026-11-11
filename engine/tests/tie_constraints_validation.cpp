// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Native validation of the tie-constraint elimination (engine/cpp/tie_constraints.h,
// issue #357) that solve_mfem.cpp applies to the all-solid solve. The unit has no
// MFEM/Emscripten dependency, so it compiles with a plain host compiler; see
// scripts/test-tie-constraints.sh. Exits non-zero if any case behaves wrong.

#include "tie_constraints.h"

#include <cmath>
#include <cstdio>
#include <stdexcept>
#include <string>
#include <vector>

using kofem::fem::NodeTies;
using kofem::fem::TieReduction;
using kofem::fem::build_tie_reduction;
using kofem::fem::expand_tied_solution;

namespace {

int failures = 0;

void check(const char* name, bool ok) {
    if (!ok) ++failures;
    printf("  [%s] %s\n", ok ? "PASS" : "FAIL", name);
}

template <typename F>
void expect_throws(const char* name, F fn, const std::string& must_contain) {
    std::string what;
    bool threw = false;
    try {
        fn();
    } catch (const std::runtime_error& e) {
        threw = true;
        what = e.what();
    }
    const bool ok = threw && what.find(must_contain) != std::string::npos;
    if (!ok) ++failures;
    printf("  [%s] %-44s %s\n", ok ? "PASS" : "FAIL", name,
           threw ? what.c_str() : "did NOT throw");
}

// The plain node-major numbering: DOF 3·node + c.
std::vector<int> identity_dofs(int n_nodes) {
    std::vector<int> dofs(3 * static_cast<size_t>(n_nodes));
    for (size_t i = 0; i < dofs.size(); ++i) dofs[i] = static_cast<int>(i);
    return dofs;
}

bool near(double a, double b) { return std::abs(a - b) < 1e-12; }

}  // namespace

int main() {
    printf("Tie-constraint elimination (issue #357):\n");

    // ── No ties: the identity ────────────────────────────────────────────────
    {
        const TieReduction r =
            build_tie_reduction({}, 2, identity_dofs(2), std::vector<char>(6, 0));
        bool identity = r.n_reduced == 6 && r.n_eliminated == 0;
        for (int d = 0; d < 6; ++d) identity = identity && r.reduced_of[d] == d;
        check("no ties leave every DOF retained", identity);
    }

    // ── Node 3 follows a point of face (0, 1, 2) ─────────────────────────────
    NodeTies face;
    face.slave = {3};
    face.offsets = {0, 3};
    face.master = {0, 1, 2};
    face.weights = {0.5, 0.25, 0.25};
    {
        const TieReduction r =
            build_tie_reduction(face, 4, identity_dofs(4), std::vector<char>(12, 0));
        check("three slave DOFs are eliminated", r.n_eliminated == 3 && r.n_reduced == 9);
        // q = the nine master DOFs; a rigid translation must carry the slave along
        // (weights sum to one), and a general q must interpolate.
        std::vector<double> q(9);
        for (int i = 0; i < 9; ++i) q[i] = 1.0 + i;  // node n, comp c → 1 + 3n + c
        const std::vector<double> u = expand_tied_solution(r, q);
        bool interpolates = true;
        for (int c = 0; c < 3; ++c)
            interpolates = interpolates &&
                           near(u[9 + c], 0.5 * q[c] + 0.25 * q[3 + c] + 0.25 * q[6 + c]);
        check("slave interpolates its master face", interpolates);
        const std::vector<double> rigid = expand_tied_solution(r, std::vector<double>(9, 2.5));
        check("rigid translation is reproduced",
              near(rigid[9], 2.5) && near(rigid[10], 2.5) && near(rigid[11], 2.5));
    }

    // ── A prescribed slave DOF keeps its boundary condition ──────────────────
    {
        std::vector<char> essential(12, 0);
        essential[9 + 1] = 1;  // slave node 3, component y
        const TieReduction r = build_tie_reduction(face, 4, identity_dofs(4), essential);
        check("a prescribed slave DOF is not eliminated",
              r.n_eliminated == 2 && r.n_prescribed == 1 && r.reduced_of[10] >= 0 &&
                  r.reduced_of[9] < 0 && r.reduced_of[11] < 0);
    }

    // ── Chains are substituted out: 2 → 1 → 0 ────────────────────────────────
    {
        NodeTies chain;
        chain.slave = {2, 1};
        chain.offsets = {0, 1, 2};
        chain.master = {1, 0};
        chain.weights = {1.0, 1.0};
        const TieReduction r =
            build_tie_reduction(chain, 3, identity_dofs(3), std::vector<char>(9, 0));
        const std::vector<double> u = expand_tied_solution(r, {7.0, 8.0, 9.0});
        check("a chained slave follows the end of the chain",
              r.n_reduced == 3 && near(u[6], 7.0) && near(u[7], 8.0) && near(u[8], 9.0));
    }

    // ── A non-trivial DOF numbering (component-major, as MFEM orders vdofs) ───
    {
        std::vector<int> by_component(12);
        for (int n = 0; n < 4; ++n)
            for (int c = 0; c < 3; ++c) by_component[3 * n + c] = 4 * c + n;
        const TieReduction r =
            build_tie_reduction(face, 4, by_component, std::vector<char>(12, 0));
        check("eliminated DOFs follow node_dof",
              r.reduced_of[3] < 0 && r.reduced_of[7] < 0 && r.reduced_of[11] < 0 &&
                  r.reduced_of[0] >= 0 && r.n_reduced == 9);
    }

    // ── Invalid input is refused, naming the node ────────────────────────────
    const auto build = [](const NodeTies& ties, int n_nodes) {
        build_tie_reduction(ties, n_nodes, identity_dofs(n_nodes),
                            std::vector<char>(3 * static_cast<size_t>(n_nodes), 0));
    };
    {
        NodeTies bad = face;
        bad.weights = {0.5, 0.25, 0.5};
        expect_throws("weights that do not sum to one", [&] { build(bad, 4); }, "sum to");
        bad = face;
        bad.master = {0, 1, 3};
        expect_throws("a node tied to itself", [&] { build(bad, 4); }, "tied to itself");
        bad = face;
        bad.master = {0, 1, 9};
        expect_throws("a master outside the mesh", [&] { build(bad, 4); }, "node 9");
        bad = face;
        bad.slave = {4};
        expect_throws("a slave outside the mesh", [&] { build(bad, 4); }, "tied node 4");
        bad = face;
        bad.offsets = {0, 2};
        expect_throws("inconsistent CSR arrays", [&] { build(bad, 4); }, "CSR");
        bad.slave = {3, 3};
        bad.offsets = {0, 1, 2};
        bad.master = {0, 1};
        bad.weights = {1.0, 1.0};
        expect_throws("a node tied twice", [&] { build(bad, 4); }, "tied twice");
        bad.slave = {0, 1};
        bad.master = {1, 0};
        expect_throws("a cycle of ties", [&] { build(bad, 4); }, "cycle");
    }

    printf("%s\n", failures == 0 ? "ALL PASSED" : "FAILURES");
    return failures == 0 ? 0 : 1;
}
