// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// SIMP topology-optimization Embind entry — see topology_simp.h (KOF-231,
// Phase A of the KOF-226 epic; ADR-0002).
//
// This is the JS↔WASM boundary: it parses the same mesh/material/BC payload the
// static solve takes plus a TO-settings block, builds the FE space, essential
// DOFs, right-hand side and the once-per-run element-stiffness cache using the
// SHARED assembly helpers (fem_bc_io / fem_mesh_io / topology_simp_core), then
// hands them to the in-engine optimization loop (topology_optimize.h). The loop,
// not this file, crosses the boundary only twice per optimization (ADR-0002
// decision 1): all ~50–200 iterations run in C++ and stream progress out over
// the same printf→worker log channel the solver uses.
//
// v1 exposes the minimum-compliance objective (KOF-230). The general
// minimum-volume formulation (KOF-235) and the stress constraint (KOF-236) reuse
// the same wire contract — this entry routes to them once they land and, until
// then, rejects their settings with a clear message rather than silently
// mis-solving.

#include "topology_simp.h"

#include "fem_bc_io.h"
#include "fem_mesh_io.h"
#include "json_util.h"
#include "topology_optimize.h"
#include "topology_simp_core.h"
#include "wasm_util.h"

#include <mfem.hpp>

#include <cstdio>
#include <string>
#include <vector>

using emscripten::val;

namespace {

constexpr int dim = 3;

// Explicit error object, matching solve_linear_elastic's {"error": ...} contract
// (issue #344): the worker checks for the key and surfaces the message without
// tripping the C++-exception decode path. Reserved for INPUT validation; a
// solver-time failure inside optimize_compliance throws, and the worker decodes
// that exception — the same split solve_linear_elastic uses.
val error_result(const std::string& message) {
    val err = val::object();
    err.set("error", message);
    return err;
}

// Read a JS array of element indices ({ solid?: number[]; void?: number[] })
// into `out`. Absent/null leaves `out` empty. Out-of-range indices are rejected
// downstream by optimize_compliance, which owns the design-domain rules.
void read_index_array(const val& parent, const char* key, std::vector<int>& out) {
    if (parent.isUndefined() || parent.isNull())
        return;
    val arr = parent[key];
    if (arr.isUndefined() || arr.isNull())
        return;
    unsigned n = arr["length"].as<unsigned>();
    out.reserve(n);
    for (unsigned i = 0; i < n; ++i)
        out.push_back(arr[i].as<int>());
}

}  // namespace

val optimize_topology(val mesh_js, const std::string& mat_json,
                      const std::string& bcs_json, const std::string& topopt_json) {
    using namespace mfem;

    log_mem("topopt: start");
    printf("[topopt] optimize_topology: parsing inputs\n");
    fflush(stdout);
    val mat_js    = parse_json(mat_json);
    val bcs_js    = parse_json(bcs_json);
    val topopt_js = parse_json(topopt_json);

    kofem::fem::MeshArrays mesh_arrays = kofem::fem::parse_mesh(mesh_js);

    // Design material: v1 treats the whole solid mesh as ONE design domain at a
    // single (E₀, ν). Read the first material entry (mirrors solve's
    // array-or-object materials contract). The minimum-compliance topology is
    // invariant to a uniform modulus scale, so the first material sets the design
    // stiffness; per-material design domains are a later extension.
    const bool is_mat_array = val::global("Array").call<bool>("isArray", mat_js);
    const unsigned n_mats   = is_mat_array ? mat_js["length"].as<unsigned>() : 1U;
    if (n_mats == 0)
        return error_result("materials array is empty — at least one material is required");
    val mat0   = is_mat_array ? mat_js[0] : mat_js;
    val E_val  = mat0["young_modulus"];
    val nu_val = mat0["poisson_ratio"];
    if (E_val.isNull() || E_val.isUndefined())
        return error_result("material 1 is missing young_modulus");
    if (nu_val.isNull() || nu_val.isUndefined())
        return error_result("material 1 is missing poisson_ratio");
    const double E0 = E_val.as<double>();
    const double nu = nu_val.as<double>();

    Mesh mfem_mesh = kofem::fem::build_mfem_mesh(mesh_arrays);
    const int ne   = mfem_mesh.GetNE();
    if (ne <= 0)
        return error_result(
            "topology optimization needs a solid volume mesh, but this mesh has no "
            "elements — an all-shell model is solid-only for now (KOF-237)");

    // TO uses linear elements — one design density per solid element (ADR-0002).
    printf("[topopt] setting up H1 FE space (order=1, dim=%d)…\n", dim);
    fflush(stdout);
    H1_FECollection fec(1, dim);
    FiniteElementSpace fespace(&mfem_mesh, &fec, dim);

    // Essential DOFs and the load, built once and reused every iteration
    // (ADR-0002 decision 1). The minimum-compliance objective assumes HOMOGENEOUS
    // supports (topology_simp_core.h): a non-zero prescribed displacement breaks
    // the self-adjoint sensitivity, so refuse it rather than steer the optimizer
    // wrongly.
    kofem::fem::EssentialBcs ess =
        kofem::fem::collect_essential_dofs(bcs_js, mfem_mesh, fespace, /*order=*/1);
    if (!ess.prescribed_vals.empty())
        return error_result(
            "topology optimization does not support prescribed (non-zero) "
            "displacements — the minimum-compliance objective assumes homogeneous "
            "supports (u = 0). Use fixed supports plus applied loads instead.");
    if (ess.ess_tdof.Size() == 0)
        return error_result(
            "topology optimization needs at least one fixed support — the model has "
            "no essential boundary conditions, so it is not fully constrained");

    LinearForm load(&fespace);
    kofem::fem::SurfaceLoadStorage surf_storage;
    kofem::fem::apply_surface_loads(bcs_js["surface_loads"], mfem_mesh, load, surf_storage);
    load.Assemble();
    kofem::fem::apply_point_loads(bcs_js["point_loads"], fespace, load);
    if (load.Normlinf() == 0.0)
        return error_result(
            "topology optimization needs an applied load — the assembled load vector "
            "is zero, so the compliance objective is trivial");

    // Per-element base stiffness k0ₑ at the design material, assembled once and
    // scaled per iteration (ADR-0002 decision 3).
    kofem::topopt::ElementStiffnessCache cache =
        kofem::topopt::build_element_stiffness_cache(fespace, E0, nu);

    // ── TO settings ────────────────────────────────────────────────────────────
    const std::string objective = jstring(topopt_js, "objective", "min_compliance");
    val constraints             = topopt_js["constraints"];

    // The stress constraint (KOF-236) shares this contract but has no
    // implementation yet — reject it explicitly instead of ignoring it.
    if (!constraints.isUndefined() && !constraints.isNull()) {
        val ms = constraints["maxStress"];
        if (!ms.isUndefined() && !ms.isNull())
            return error_result(
                "the maximum-stress constraint (constraints.maxStress) is not "
                "implemented yet (KOF-236)");
    }

    if (objective == "min_volume")
        return error_result(
            "the min_volume objective (minimize volume subject to a compliance limit) "
            "is not implemented yet (KOF-235) — use objective \"min_compliance\"");
    if (objective != "min_compliance")
        return error_result(
            "unknown topology-optimization objective \"" + objective +
            "\" — expected \"min_compliance\" or \"min_volume\"");

    // min_compliance requires a volume fraction (the constraint it optimizes
    // under). The remaining knobs fall back to the ADR-0002 defaults.
    val vf = (constraints.isUndefined() || constraints.isNull())
                 ? val::undefined()
                 : constraints["volumeFraction"];
    if (vf.isUndefined() || vf.isNull())
        return error_result(
            "the min_compliance objective requires constraints.volumeFraction "
            "(the target material fraction, in (0, 1])");

    kofem::topopt::ComplianceOptConfig config;
    config.volume_fraction = vf.as<double>();
    config.penalty         = jdouble(topopt_js, "penalty", 3.0);
    config.filter_radius   = jdouble(topopt_js, "filterRadius", 0.0);
    config.move_limit      = jdouble(topopt_js, "moveLimit", 0.2);
    config.max_iterations  = jint(topopt_js, "maxIterations", 100);
    config.tolerance       = jdouble(topopt_js, "tolerance", 0.01);
    read_index_array(topopt_js["passive"], "solid", config.passive_solid);
    read_index_array(topopt_js["passive"], "void", config.passive_void);

    // Iteration-count sanity: a non-positive budget would run zero iterations and
    // return the uniform start, which is never what the caller wants.
    if (config.max_iterations <= 0)
        return error_result("maxIterations must be a positive integer");

    printf("[topopt] min_compliance: %d elements, %d dofs, volfrac=%.3f, p=%.2f, "
           "r_min=%.4g, move=%.3f, maxit=%d, tol=%.4g\n",
           ne, fespace.GetTrueVSize(), config.volume_fraction, config.penalty,
           config.filter_radius, config.move_limit, config.max_iterations,
           config.tolerance);
    fflush(stdout);
    log_mem("topopt: before optimization loop");

    // The loop streams "[topopt] it N: …" per iteration and throws
    // std::runtime_error on an ill-posed problem (infeasible volume fraction,
    // contradictory passive pins, a solve that fails to converge). Those throws
    // propagate as a C++ exception the worker decodes — the same contract
    // solve_linear_elastic uses for a solve-time failure.
    kofem::topopt::ComplianceOptResult result = kofem::topopt::optimize_compliance(
        fespace, cache, ess.ess_tdof, load, config);

    printf("[topopt] complete: %d iteration(s), %s; returning %d densities\n",
           result.iterations, result.converged ? "converged" : "hit max_iterations",
           static_cast<int>(result.density.size()));
    fflush(stdout);
    log_mem("topopt: complete");

    // Binary density (one Float64 per element, solve order — issue #166) plus the
    // iteration history as a small JSON-shaped array. `objective` carries the
    // minimized value (compliance here), matching the TopOptHistoryEntry wire
    // type in kofem_wasm.d.ts.
    val out = val::object();
    out.set("density", float64_array(result.density));
    val history = val::array();
    for (std::size_t i = 0; i < result.history.size(); ++i) {
        const kofem::topopt::TopOptHistoryEntry& h = result.history[i];
        val entry = val::object();
        entry.set("it", h.it);
        entry.set("objective", h.compliance);
        entry.set("volume", h.volume);
        entry.set("max_change", h.max_change);
        history.set(static_cast<int>(i), entry);
    }
    out.set("history", history);
    return out;
}
