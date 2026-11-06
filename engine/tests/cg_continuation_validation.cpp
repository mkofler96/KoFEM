// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

#include "cg_continuation.h"
#include "shell_core.h"
#ifdef KOFEM_TEST_MFEM
#include "cg_mfem.h"
#endif
#include <algorithm>
#include <cmath>
#include <cstdio>
#include <stdexcept>
#include <string>

namespace {
void check(int& failures, const char* name, bool pass) {
    printf("[%s] %s\n", pass ? "PASS" : "FAIL", name);
    if (!pass) ++failures;
}

void policy(int& failures) {
    int prompts = 0;
    kofem::CgControl control;
    control.on_limit = [&](const kofem::CgProgress&) { ++prompts; return 10; };
    for (double ratio : {1.0, 1.01, 0.999999999}) {
        kofem::CgContinuation stalled(control, 20);
        for (int i = 0; i <= 20; ++i) stalled.observe(std::pow(ratio, i));
        check(failures, "flat/rising/noisy residual does not prompt",
              !stalled.extend(20, std::pow(ratio, 20), 1e-6));
    }
    kofem::CgContinuation plateau(control, 20);
    for (int i = 0; i < 20; ++i) plateau.observe(i < 5 ? 1.0 : 0.1);
    check(failures, "early progress followed by plateau does not prompt", !plateau.extend(20, 0.1, 1e-6));
    check(failures, "no stalled callbacks", prompts == 0);
    kofem::CgContinuation falling(control, 20);
    for (int i = 0; i <= 20; ++i) falling.observe(std::pow(0.9, i));
    check(failures, "falling residual can extend", falling.extend(20, std::pow(0.9, 20), 1e-6));
    check(failures, "budget extends by the selected amount", falling.limit() == 30 && prompts == 1);
    kofem::CgContinuation slow(control, 20);
    for (int i = 0; i <= 20; ++i) slow.observe(std::pow(0.9999, i));
    check(failures, "slow but steady progress can extend", slow.extend(20, std::pow(0.9999, 20), 1e-6));
    control.on_limit = [](const kofem::CgProgress&) { return 0; };
    kofem::CgContinuation stop(control, 2);
    stop.observe(1.0); stop.observe(0.5);
    bool rejected = false;
    try { stop.extend(2, 0.5, 1e-6); }
    catch (const std::runtime_error& error) {
        rejected = std::string(error.what()).find("discarded") != std::string::npos;
    }
    check(failures, "Stop produces an explicit discard error", rejected);
}

kofem::shell::ShellInput shell_model() {
    kofem::shell::ShellInput input;
    input.thickness = 0.02; input.young = 2.1e11; input.poisson = 0.3;
    constexpr int nx = 16, ny = 4;
    for (int i = 0; i <= nx; ++i)
        for (int j = 0; j <= ny; ++j)
            input.vertices.insert(input.vertices.end(), {2.0 * i / nx, 0.3 * j / ny, 0.0});
    for (int i = 0; i < nx; ++i)
        for (int j = 0; j < ny; ++j) {
            const int a = i * (ny + 1) + j, b = a + ny + 1;
            input.triangles.insert(input.triangles.end(), {a, b, b + 1, a, b + 1, a + 1});
        }
    for (int j = 0; j <= ny; ++j) {
        for (int component = 0; component < 6; ++component)
            input.fixed_dofs.push_back(6 * j + component);
        input.loads.emplace_back(6 * (nx * (ny + 1) + j) + 2, 20.0);
    }
    return input;
}

kofem::shell::CoupledInput coupled_model() {
    const auto shell = shell_model();
    kofem::shell::CoupledInput input;
    input.vertices = shell.vertices; input.triangles = shell.triangles;
    input.thickness = shell.thickness; input.shell_young = shell.young;
    input.shell_poisson = shell.poisson; input.loads = shell.loads;
    const int anchor = static_cast<int>(input.vertices.size() / 3);
    input.vertices.insert(input.vertices.end(), {-0.1, 0.0, 0.0, -0.1, 0.3, 0.0, -0.1, 0.15, 0.1});
    input.n_nodes = anchor + 3;
    for (int j = 0; j <= 4; ++j) {
        kofem::shell::Coupling coupling;
        coupling.ref_node = j;
        coupling.solid_nodes = {anchor, anchor + 1, anchor + 2};
        input.couplings.push_back(coupling);
    }
    for (int node = anchor; node < anchor + 3; ++node)
        for (int component = 0; component < 3; ++component)
            input.fixed_dofs.push_back(6 * node + component);
    return input;
}

template <typename Input, typename Solve>
void resume_path(int& failures, const char* name, Input input, Solve solve) {
    const auto baseline = solve(input);
    check(failures, name, baseline.converged && baseline.iterations > 4);
    // Put the cap late enough to be in the asymptotic descending part of CG,
    // but before convergence. Extending must reproduce the uninterrupted run
    // EXACTLY: even a warm restart changes search directions/iteration count.
    const int cap = std::max(4, baseline.iterations - 5);
    input.cg_control.initial_iterations = cap;
    int prompts = 0;
    input.cg_control.on_limit = [&](const kofem::CgProgress& progress) {
        ++prompts;
        check(failures, "prompt reports original target and total iterations",
              progress.target == input.cg_rel_tol && progress.iterations == cap);
        return 1000;
    };
    const auto resumed = solve(input);
    check(failures, "cap prompts and continuation converges", prompts == 1 && resumed.converged);
    check(failures, "resume preserves all CG state", resumed.iterations == baseline.iterations &&
          resumed.dofs == baseline.dofs && resumed.rel_residual == baseline.rel_residual);
    input.cg_control.on_limit = {};
    const auto capped = solve(input);
    check(failures, "no callback keeps non-convergence at the cap", !capped.converged && capped.iterations == cap);
    input.cg_control.on_limit = [](const kofem::CgProgress&) { return 0; };
    bool stopped = false;
    try { solve(input); }
    catch (const std::runtime_error& error) {
        stopped = std::string(error.what()).find("stopped by user") != std::string::npos;
    }
    check(failures, "stop rejects the partial solve", stopped);
}

#ifdef KOFEM_TEST_MFEM
void solid(int& failures) {
    constexpr int size = 160;
    mfem::SparseMatrix matrix(size);
    mfem::Vector rhs(size), reference(size), resumed(size);
    reference = 0.0;
    resumed = 0.0;
    for (int i = 0; i < size; ++i) {
        matrix.Add(i, i, 2.0);
        if (i > 0) matrix.Add(i, i - 1, -1.0);
        if (i + 1 < size) matrix.Add(i, i + 1, -1.0);
        rhs[i] = 1.0 + 0.1 * std::sin(i);
    }
    matrix.Finalize();
    const int baseline = kofem::solve_mfem_cg(matrix, rhs, reference);
    kofem::CgControl control;
    control.initial_iterations = baseline - 5;
    int prompts = 0;
    control.on_limit = [&](const kofem::CgProgress& progress) {
        ++prompts;
        check(failures, "solid prompt retains original tolerance", progress.target == 1e-6);
        return 1000;
    };
    const int total = kofem::solve_mfem_cg(matrix, rhs, resumed, control);
    bool identical = total == baseline;
    for (int i = 0; i < size; ++i) identical = identical && reference[i] == resumed[i];
    check(failures, "solid resumes exact CG state to convergence", prompts == 1 && identical);
    control.on_limit = [](const kofem::CgProgress&) { return 0; };
    bool stopped = false;
    resumed = 0.0;
    try { kofem::solve_mfem_cg(matrix, rhs, resumed, control); }
    catch (const std::runtime_error& error) {
        stopped = std::string(error.what()).find("discarded") != std::string::npos;
    }
    check(failures, "solid Stop discards", stopped);
    control.on_limit = {};
    bool failed = false;
    resumed = 0.0;
    try { kofem::solve_mfem_cg(matrix, rhs, resumed, control); }
    catch (const std::runtime_error& error) {
        failed = std::string(error.what()).find("CG solver did not converge") != std::string::npos;
    }
    check(failures, "solid cap without a callback keeps existing error", failed);
}
#endif
}  // namespace

int main() {
    int failures = 0;
    policy(failures);
    resume_path(failures, "shell baseline", shell_model(), kofem::shell::solve_shell_core);
    resume_path(failures, "coupled baseline", coupled_model(), kofem::shell::solve_solid_shell_core);
#ifdef KOFEM_TEST_MFEM
    solid(failures);
#endif
    return failures == 0 ? 0 : 1;
}
