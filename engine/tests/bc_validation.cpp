// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Native validation of the BC/load index checks (engine/cpp/bc_validation.h)
// that solve_mfem.cpp's (issue #362) and solve_shell.cpp's (issue #379) ingestion
// functions use to reject out-of-range vertex and DOF-component indices instead of
// silently dropping the constraint/load. The header is pure C++ — no MFEM, OCCT,
// Netgen or Emscripten — so it compiles with a plain host compiler; see
// scripts/test-bc-validation.sh. Exits non-zero if any case behaves wrong, so it
// can gate CI.

#include "bc_validation.h"

#include <cstdio>
#include <stdexcept>
#include <string>

using namespace kofem::bc;

namespace {

// Assert that `fn` throws std::runtime_error, and that the message mentions the
// offending index and the caller name — the "loud, information-rich error" the
// issue asks for, not a bare throw.
template <typename F>
void expect_throws(int& failures, const char* name, F fn, const std::string& must_contain) {
    bool threw = false;
    std::string what;
    try {
        fn();
    } catch (const std::runtime_error& e) {
        threw = true;
        what = e.what();
    }
    const bool has = threw && what.find(must_contain) != std::string::npos;
    if (!has) ++failures;
    printf("  [%s] %-40s %s\n", has ? "PASS" : "FAIL", name,
           threw ? ("threw: " + what).c_str() : "did NOT throw");
}

// Assert that `fn` does not throw — a valid index must pass straight through.
template <typename F>
void expect_ok(int& failures, const char* name, F fn) {
    bool threw = false;
    std::string what;
    try {
        fn();
    } catch (const std::exception& e) {
        threw = true;
        what = e.what();
    }
    if (threw) ++failures;
    printf("  [%s] %-40s %s\n", threw ? "FAIL" : "PASS", name,
           threw ? ("threw: " + what).c_str() : "ok");
}

}  // namespace

int main() {
    int failures = 0;
    const int nv = 100;  // pretend the mesh has 100 vertices

    printf("BC/load index validation (issue #362):\n");

    // ── Vertex-index range check ──────────────────────────────────────────────
    expect_ok(failures, "vertex 0 (first) accepted",
              [&] { require_valid_vertex(0, nv, "add_fixed_dofs"); });
    expect_ok(failures, "vertex nv-1 (last) accepted",
              [&] { require_valid_vertex(nv - 1, nv, "add_fixed_dofs"); });
    expect_throws(failures, "vertex nv (one past end) rejected",
                  [&] { require_valid_vertex(nv, nv, "add_fixed_dofs"); }, "100");
    expect_throws(failures, "negative vertex rejected",
                  [&] { require_valid_vertex(-1, nv, "add_prescribed_dofs"); }, "-1");
    expect_throws(failures, "far out-of-range vertex rejected",
                  [&] { require_valid_vertex(9999, nv, "apply_point_loads"); }, "9999");
    expect_throws(failures, "error names the calling function",
                  [&] { require_valid_vertex(nv, nv, "apply_point_loads"); },
                  "apply_point_loads");

    // ── DOF-component range check (0=Ux, 1=Uy, 2=Uz → ndof = 3) ────────────────
    expect_ok(failures, "component 0 accepted",
              [&] { require_valid_component(0, 3, 7, "add_fixed_dofs"); });
    expect_ok(failures, "component 2 (last) accepted",
              [&] { require_valid_component(2, 3, 7, "add_fixed_dofs"); });
    expect_throws(failures, "component 3 (one past end) rejected",
                  [&] { require_valid_component(3, 3, 7, "add_fixed_dofs"); }, "3");
    expect_throws(failures, "negative component rejected",
                  [&] { require_valid_component(-1, 3, 7, "add_prescribed_dofs"); }, "-1");

    // ── Minimum-DOF check for point loads ─────────────────────────────────────
    expect_ok(failures, "3 DOFs satisfies the 3-DOF requirement",
              [&] { require_min_dofs(3, 3, 5, "apply_point_loads"); });
    expect_throws(failures, "0 DOFs (empty lookup) rejected",
                  [&] { require_min_dofs(0, 3, 5, "apply_point_loads"); }, "apply_point_loads");

    // ── Shell DOF-component range check (0..5: 3 translations + 3 rotations) ───
    // solve_shell.cpp accepts six DOFs per node, so the valid band is wider than
    // the solid path's 0..2 — but still bounded (issue #379).
    printf("\nShell DOF-component validation (issue #379):\n");
    expect_ok(failures, "shell component 0 (Ux) accepted",
              [&] { require_valid_shell_component(0, 7, "add_fixed_dofs"); });
    expect_ok(failures, "shell component 5 (Rz, last) accepted",
              [&] { require_valid_shell_component(5, 7, "add_fixed_dofs"); });
    expect_throws(failures, "shell component 6 (one past end) rejected",
                  [&] { require_valid_shell_component(6, 7, "add_fixed_dofs"); }, "6");
    expect_throws(failures, "negative shell component rejected",
                  [&] { require_valid_shell_component(-1, 7, "add_fixed_dofs"); }, "-1");
    expect_throws(failures, "shell component error names the vertex",
                  [&] { require_valid_shell_component(9, 42, "add_fixed_dofs"); }, "42");

    printf(failures != 0 ? "\n%d check(s) FAILED\n" : "\nall checks passed\n", failures);
    return failures != 0 ? 1 : 0;
}
