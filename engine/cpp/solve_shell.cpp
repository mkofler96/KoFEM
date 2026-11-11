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

#include "bc_validation.h"
#include "cg_browser.h"
#include "json_util.h"
#include "shell_core.h"
#include "shell_element.h"
#include "shell_material_js.h"
#include "wasm_util.h"

#include <array>
#include <cstdio>
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
// An out-of-range vertex or component is a loud error, not a silent skip:
// dropping the constraint would let the shell CG still "converge" on a model
// missing a BC the user configured (issue #379).
void add_fixed_dofs(const val& fdofs_js, int n_nodes, std::vector<int>& fixed) {
    if (fdofs_js.isUndefined() || fdofs_js.isNull())
        return;
    unsigned n = fdofs_js["length"].as<unsigned>();
    for (unsigned i = 0; i < n; ++i) {
        val entry = fdofs_js[i];
        int v = entry["vertex"].as<int>();
        val comps = entry["dofs"];
        unsigned nc = comps["length"].as<unsigned>();
        kofem::bc::require_valid_vertex(v, n_nodes, "add_fixed_dofs");
        for (unsigned c = 0; c < nc; ++c) {
            int d = comps[c].as<int>();
            kofem::bc::require_valid_shell_component(d, v, "add_fixed_dofs");
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
        kofem::bc::require_valid_vertex(v, n_nodes, "add_fixed_vertices");
        for (int d = 0; d < 6; ++d)
            fixed.push_back(6 * v + d);
    }
}

// prescribed_dofs pins one component of a vertex to a NON-ZERO value — an
// inhomogeneous Dirichlet condition (a prescribed-displacement drive, or a
// prescribed rotation on a shell node, which carries all six DOFs). Mirrors
// solve_linear_elastic's `prescribed_dofs` contract, extended from components
// 0..2 to 0..5 because a shell node has rotational DOFs to prescribe.
void add_prescribed_dofs(const val& pdofs_js, int n_nodes,
                         std::vector<std::pair<int, double>>& prescribed) {
    if (pdofs_js.isUndefined() || pdofs_js.isNull())
        return;
    unsigned n = pdofs_js["length"].as<unsigned>();
    for (unsigned i = 0; i < n; ++i) {
        val entry = pdofs_js[i];
        int v = entry["vertex"].as<int>();
        int d = entry["dof"].as<int>();
        kofem::bc::require_valid_vertex(v, n_nodes, "add_prescribed_dofs");
        kofem::bc::require_valid_shell_component(d, v, "add_prescribed_dofs");
        prescribed.emplace_back(6 * v + d, entry["value"].as<double>());
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
        kofem::bc::require_valid_vertex(v, n_nodes, "add_point_loads");
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

val solve_shell(const val& mesh, const std::string& mat_json, const std::string& bcs_json) {
    kofem::shell::ShellInput in;
    in.vertices = f64_vector(mesh["vertices"], "mesh.vertices");
    in.triangles = i32_vector(mesh["triangles"], "mesh.triangles");
    // Optional per-triangle thickness (thin walls of differing gauge become one
    // shell mesh with a thickness field). Without it, mat_json must carry a
    // uniform thickness; with it, the field is the only thickness source.
    val thick_js = mesh["thicknesses"];
    if (!thick_js.isUndefined() && !thick_js.isNull())
        in.thicknesses = f64_vector(thick_js, "mesh.thicknesses");

    if (in.vertices.size() % 3 != 0)
        return error_result("mesh.vertices length " + std::to_string(in.vertices.size()) +
                            " is not divisible by 3 — expected flat xyz coordinates");
    if (in.triangles.size() % 3 != 0)
        return error_result("mesh.triangles length " + std::to_string(in.triangles.size()) +
                            " is not divisible by 3 — expected three vertex indices per triangle");
    const int n_nodes = static_cast<int>(in.vertices.size() / 3);
    if (n_nodes == 0 || in.triangles.empty())
        return error_result("shell mesh has no nodes or no triangles");

    const int n_tris = static_cast<int>(in.triangles.size() / 3);
    // One material object, or an array selected per triangle by mesh.attributes
    // (shell bodies of different materials in one mesh, issue #389).
    val mat = parse_json(mat_json);
    const kofem::shell::ShellMaterialPayload materials =
        kofem::shell::read_shell_materials(mat, mesh["attributes"], "mesh.attributes", n_tris);
    if (!materials.error.empty())
        return error_result(materials.error);
    in.young = materials.young;
    in.poisson = materials.poisson;
    in.youngs = materials.youngs;
    in.poissons = materials.poissons;
    // A uniform thickness rides on the single material object only.
    val th = val::global("Array").call<bool>("isArray", mat) ? val::undefined() : mat["thickness"];
    if (!in.thicknesses.empty()) {
        // The per-triangle field is the thickness source: it must cover every
        // triangle, and a uniform thickness alongside it would be ambiguous.
        if (static_cast<int>(in.thicknesses.size()) != n_tris)
            return error_result("mesh.thicknesses has " + std::to_string(in.thicknesses.size()) +
                                " entries for " + std::to_string(n_tris) + " triangles");
        if (!th.isNull() && !th.isUndefined())
            return error_result("give either mesh.thicknesses or material thickness, not both");
    } else {
        if (th.isNull() || th.isUndefined())
            return error_result("material is missing thickness (required for shell elements)");
        in.thickness = th.as<double>();
        if (in.thickness <= 0.0)
            return error_result("shell thickness must be positive");
    }

    val bcs = parse_json(bcs_json);
    add_fixed_vertices(bcs["fixed_vertices"], n_nodes, in.fixed_dofs);
    add_fixed_dofs(bcs["fixed_dofs"], n_nodes, in.fixed_dofs);
    add_prescribed_dofs(bcs["prescribed_dofs"], n_nodes, in.prescribed_dofs);
    add_point_loads(bcs["point_loads"], n_nodes, in.loads);

    // Name the uniform value only when it is the one in use: with a per-facet
    // field the scalar is unused and printing it would mislead.
    std::array<char, 96> thickness_desc{};
    if (in.thicknesses.empty())
        snprintf(thickness_desc.data(), thickness_desc.size(), "t=%g", in.thickness);
    else
        snprintf(thickness_desc.data(), thickness_desc.size(), "per-facet thickness");
    std::array<char, 96> material_desc{};
    if (in.youngs.empty())
        snprintf(material_desc.data(), material_desc.size(), "E=%g, nu=%g", in.young,
                 in.poisson);
    else
        snprintf(material_desc.data(), material_desc.size(), "%u materials (per facet)",
                 materials.n_materials);
    printf("[shell] solve: %d nodes, %d triangles, %s, %s; "
           "%zu fixed DOFs, %zu prescribed DOFs, %zu loads\n",
           n_nodes, n_tris, thickness_desc.data(), material_desc.data(),
           in.fixed_dofs.size(), in.prescribed_dofs.size(), in.loads.size());
    fflush(stdout);

    kofem::shell::ShellResult r;
    try {
        in.cg_control = browser_cg_control();
        r = kofem::shell::solve_shell_core(in);
    } catch (const std::exception& e) {
        printf("[shell] solve failed: %s\n", e.what());
        fflush(stdout);
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

    // Von Mises per facet: surface stress at the worse of the two shell surfaces
    // z = ±t/2, combining CST membrane strain with DKT bending curvature (see
    // shell_von_mises). Named "von_mises" to match solve_linear_elastic's
    // per-element contract, so the same result pipeline consumes both.
    const std::vector<double> von_mises = kofem::shell::shell_von_mises(
        in.vertices, in.triangles, in.thickness, in.thicknesses, in.young,
        in.poisson, in.youngs, in.poissons, r.dofs);

    val result = val::object();
    result.set("displacements", float64_array(displacements));
    result.set("von_mises", float64_array(von_mises));
    result.set("iterations", r.iterations);
    return result;
}
