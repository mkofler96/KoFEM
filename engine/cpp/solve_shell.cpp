// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Kirchhoff flat-facet shell solve — Embind wrapper. See solve_shell.h.
//
// This mirrors solve_linear_elastic's JS contract (typed-array mesh in, binary
// displacement array out) but operates on a triangle SURFACE mesh with a
// thickness rather than a tetrahedral volume mesh: the shell carries bending
// with 6 DOF/node, so it needs no through-thickness elements. The heavy lifting
// (element stiffness, assembly, CG) lives in the MFEM-free shell_core so it can
// be unit-tested natively.

#include "solve_shell.h"

#include "json_util.h"
#include "shell_core.h"
#include "wasm_util.h"

#include <string>
#include <vector>

using emscripten::val;

namespace {

val error_result(const std::string& message) {
    val err = val::object();
    err.set("error", message);
    return err;
}

// Append every DOF listed for a vertex (component 0..5) to the fixed set.
void add_fixed_dofs(const val& fdofs_js, int n_nodes, std::vector<int>& fixed) {
    if (fdofs_js.isUndefined() || fdofs_js.isNull())
        return;
    unsigned n = fdofs_js["length"].as<unsigned>();
    for (unsigned i = 0; i < n; ++i) {
        val entry = fdofs_js[i];
        int v = entry["vertex"].as<int>();
        val comps = entry["dofs"];
        unsigned nc = comps["length"].as<unsigned>();
        for (unsigned c = 0; c < nc; ++c) {
            int d = comps[c].as<int>();
            if (v >= 0 && v < n_nodes && d >= 0 && d < 6)
                fixed.push_back(6 * v + d);
        }
    }
}

// fixed_vertices clamps all six DOFs of each listed vertex.
void add_fixed_vertices(const val& fv_js, int n_nodes, std::vector<int>& fixed) {
    if (fv_js.isUndefined() || fv_js.isNull())
        return;
    unsigned n = fv_js["length"].as<unsigned>();
    for (unsigned i = 0; i < n; ++i) {
        int v = fv_js[i].as<int>();
        if (v >= 0 && v < n_nodes)
            for (int d = 0; d < 6; ++d)
                fixed.push_back(6 * v + d);
    }
}

// point_loads: force [fx,fy,fz] → DOFs 0..2, optional moment [mx,my,mz] → 3..5.
void add_point_loads(const val& loads_js, int n_nodes,
                     std::vector<std::pair<int, double>>& loads) {
    if (loads_js.isUndefined() || loads_js.isNull())
        return;
    unsigned n = loads_js["length"].as<unsigned>();
    for (unsigned i = 0; i < n; ++i) {
        val entry = loads_js[i];
        int v = entry["vertex"].as<int>();
        if (v < 0 || v >= n_nodes)
            continue;
        val force = entry["force"];
        if (!force.isUndefined() && !force.isNull())
            for (int d = 0; d < 3; ++d)
                loads.emplace_back(6 * v + d, force[d].as<double>());
        val moment = entry["moment"];
        if (!moment.isUndefined() && !moment.isNull())
            for (int d = 0; d < 3; ++d)
                loads.emplace_back(6 * v + 3 + d, moment[d].as<double>());
    }
}

}  // namespace

val solve_shell(val mesh, const std::string& mat_json, const std::string& bcs_json) {
    kofem::shell::ShellInput in;
    in.vertices = f64_vector(mesh["vertices"], "mesh.vertices");
    in.triangles = i32_vector(mesh["triangles"], "mesh.triangles");

    if (in.vertices.size() % 3 != 0)
        return error_result("mesh.vertices length " + std::to_string(in.vertices.size()) +
                            " is not divisible by 3 — expected flat xyz coordinates");
    if (in.triangles.size() % 3 != 0)
        return error_result("mesh.triangles length " + std::to_string(in.triangles.size()) +
                            " is not divisible by 3 — expected three vertex indices per triangle");
    const int n_nodes = static_cast<int>(in.vertices.size() / 3);
    if (n_nodes == 0 || in.triangles.empty())
        return error_result("shell mesh has no nodes or no triangles");

    val mat = parse_json(mat_json);
    val E = mat["young_modulus"];
    val nu = mat["poisson_ratio"];
    val th = mat["thickness"];
    if (E.isNull() || E.isUndefined())
        return error_result("material is missing young_modulus");
    if (nu.isNull() || nu.isUndefined())
        return error_result("material is missing poisson_ratio");
    if (th.isNull() || th.isUndefined())
        return error_result("material is missing thickness (required for shell elements)");
    in.young = E.as<double>();
    in.poisson = nu.as<double>();
    in.thickness = th.as<double>();
    if (in.thickness <= 0.0)
        return error_result("shell thickness must be positive");

    val bcs = parse_json(bcs_json);
    add_fixed_vertices(bcs["fixed_vertices"], n_nodes, in.fixed_dofs);
    add_fixed_dofs(bcs["fixed_dofs"], n_nodes, in.fixed_dofs);
    add_point_loads(bcs["point_loads"], n_nodes, in.loads);

    printf("[shell] solve: %d nodes, %d triangles, t=%g, E=%g, nu=%g; "
           "%zu fixed DOFs, %zu loads\n",
           n_nodes, (int)(in.triangles.size() / 3), in.thickness, in.young,
           in.poisson, in.fixed_dofs.size(), in.loads.size());
    fflush(stdout);

    kofem::shell::ShellResult r;
    try {
        r = kofem::shell::solve_shell_core(in);
    } catch (const std::exception& e) {
        return error_result(std::string("shell solve failed: ") + e.what());
    }

    if (!r.converged)
        return error_result(
            "shell CG solver did not converge: relative residual " +
            std::to_string(r.rel_residual) + " after " + std::to_string(r.iterations) +
            " iterations — check that the model is fully constrained");

    printf("[shell] converged: %d iterations, relative residual %.3e\n",
           r.iterations, r.rel_residual);
    fflush(stdout);

    // Return three translations per node (u,v,w) — matches the solid solver's
    // displacement contract so the existing result pipeline can consume it.
    std::vector<double> displacements(3 * (size_t)n_nodes, 0.0);
    for (int v = 0; v < n_nodes; ++v)
        for (int c = 0; c < 3; ++c)
            displacements[3 * v + c] = r.dofs[6 * v + c];

    val result = val::object();
    result.set("displacements", float64_array(displacements));
    return result;
}
