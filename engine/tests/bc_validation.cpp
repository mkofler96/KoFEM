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
#include "surface_load_selection.h"

#include <cstdio>
#include <cstddef>
#include <map>
#include <stdexcept>
#include <string>
#include <vector>

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

    // ── Surface-load selection checks (solid path, issue #428) ────────────────
    // A face selection that matches no boundary element, or a total-force load
    // whose matched faces integrate to zero area, used to be dropped from the
    // solve with only a stdout line — the shell path throws for the same case.
    printf("\nSurface-load selection validation (issue #428):\n");
    expect_ok(failures, "one matched element passes",
              [&] { require_matched_boundary_elements(1, 4, 0, "force"); });
    expect_throws(failures, "zero matched elements rejected",
                  [&] { require_matched_boundary_elements(0, 4, 3, "force"); },
                  "surface_load 3");
    expect_throws(failures, "zero-match error names the face count",
                  [&] { require_matched_boundary_elements(0, 7, 0, "pressure"); }, "7");
    expect_ok(failures, "positive load area passes",
              [&] { require_positive_load_area(2.5, 0, 4); });
    expect_throws(failures, "zero load area rejected",
                  [&] { require_positive_load_area(0.0, 2, 4); }, "surface_load 2");
    expect_throws(failures, "negative load area rejected",
                  [&] { require_positive_load_area(-1.0, 0, 4); }, "force");

    printf("\nSurface-load face matching (KOF-220):\n");
    const std::map<std::vector<int>, int> boundary_faces{
        {{0, 1, 2}, 5}, {{3, 4, 5, 6}, 9}};
    const auto check_selection = [&](const char* name,
                                     const std::vector<std::vector<int>>& faces,
                                     const std::vector<int>& expected,
                                     std::size_t unmatched) {
        const auto result = match_surface_load_faces(faces, boundary_faces);
        const bool pass = result.elements == expected && result.unmatched_faces == unmatched;
        if (!pass) ++failures;
        printf("  [%s] %s\n", pass ? "PASS" : "FAIL", name);
    };
    check_selection("tri/quad permutations match", {{2, 0, 1}, {6, 4, 3, 5}}, {5, 9}, 0);
    check_selection("partial miss is counted", {{0, 1, 2}, {7, 8, 9}}, {5}, 1);
    check_selection("full miss is counted", {{7, 8, 9}}, {}, 1);
    check_selection("duplicate valid faces produce no misses",
                    {{0, 1, 2}, {2, 1, 0}}, {5}, 0);
    check_selection("duplicates integrate once without false misses",
                    {{0, 1, 2}, {2, 1, 0}, {7, 8, 9}}, {5}, 1);
    check_selection("each unmatched selection is counted",
                    {{7, 8, 9}, {9, 8, 7}, {0, 1, 2}}, {5}, 2);
    check_selection("empty selection", {}, {}, 0);

    printf("\nConflicting Dirichlet values (KOF-218):\n");
    const auto fixed = DirichletSource::Fixed;
    const auto prescribed = DirichletSource::Prescribed;
    expect_ok(failures, "same fixed value twice accepted", [&] {
        require_consistent_dirichlet(3, 0, fixed, 0.0, fixed, 0.0, "add_fixed_dofs");
    });
    expect_ok(failures, "same prescribed value twice accepted", [&] {
        require_consistent_dirichlet(3, 1, prescribed, 0.5, prescribed, 0.5, "add_prescribed_dofs");
    });
    expect_ok(failures, "fixed then prescribed to 0 accepted", [&] {
        require_consistent_dirichlet(3, 2, fixed, 0.0, prescribed, 0.0, "add_prescribed_dofs");
    });
    expect_throws(failures, "fixed then prescribed non-zero rejected", [&] {
        require_consistent_dirichlet(7, 2, fixed, 0.0, prescribed, 0.1, "add_prescribed_dofs");
    }, "add_prescribed_dofs: vertex 7 component Uz (DOF 2) is fixed to 0 and also prescribed to 0.1");
    expect_throws(failures, "two prescribed values rejected", [&] {
        require_consistent_dirichlet(7, 0, prescribed, 0.1, prescribed, -0.2, "add_prescribed_dofs");
    }, "prescribed to 0.1 and also prescribed to -0.2");
    expect_throws(failures, "prescribed then fixed rejected", [&] {
        require_consistent_dirichlet(7, 4, prescribed, 0.01, fixed, 0.0, "shell");
    }, "component Ry (DOF 4) is prescribed to 0.01 and also fixed to 0");

    printf(failures != 0 ? "\n%d check(s) FAILED\n" : "\nall checks passed\n", failures);
    return failures != 0 ? 1 : 0;
}
