// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// SIMP topology-optimization Embind entry — see topology_simp.h (KOF-231,
// Phase A of the KOF-226 epic; ADR-0002).
//
// This is the JS↔WASM boundary: it parses the same mesh/material/BC payload the
// static solve takes plus a TO-settings block, builds the FE space, essential
// DOFs, right-hand side and the once-per-run element-stiffness cache using the
// SHARED assembly helpers (fem_bc_io / fem_mesh_io / topology_simp_core), then
// hands them to the in-engine optimization loop (topology_optimize.h). All
// ~50–200 iterations run in C++ (ADR-0002 decision 1) and stream progress out
// over the same printf→worker log channel the solver uses; the optional
// `on_density` callback additionally receives the design ρ per iteration
// (KOF-240, revising that decision) so the viewport can draw it live.
//
// Routes both compliance/volume formulations — min_compliance (KOF-230) and
// min_volume (KOF-235) — each optionally bounded by a maximum von Mises stress
// (constraints.maxStress, KOF-236). With `method: "level_set"` it runs the
// reaction–diffusion level-set optimizer (topology_levelset.h) instead, which
// additionally returns the nodal level set φ so the viewport can draw a smooth
// φ = 0 boundary; that method is minimum-compliance only, without a stress limit.

#include "topology_simp.h"

#include "fem_bc_io.h"
#include "fem_mesh_io.h"
#include "json_util.h"
#include "topology_levelset.h"
#include "topology_optimize.h"
#include "topology_simp_core.h"
#include "topology_stream_js.h"
#include "topology_stress.h"
#include "wasm_util.h"

#include <mfem.hpp>

#include <cmath>
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

// The { density, history } object both methods return; `objective` carries the
// minimized value and `compliance` is always c(ρ); a stress-constrained run adds
// the aggregated `stress` and the true `max_stress` (TopOptHistoryEntry).
val pack_history(const std::vector<kofem::topopt::TopOptHistoryEntry>& hist,
                 kofem::topopt::TopOptObjective objective) {
    val history = val::array();
    for (std::size_t i = 0; i < hist.size(); ++i) {
        const kofem::topopt::TopOptHistoryEntry& h = hist[i];
        val entry = val::object();
        entry.set("it", h.it);
        entry.set("objective", kofem::topopt::objective_value(objective, h.compliance,
                                                              h.volume));
        entry.set("compliance", h.compliance);
        entry.set("volume", h.volume);
        entry.set("max_change", h.max_change);
        // Stress fields only on a stress-constrained SIMP run (KOF-236); they stay
        // NaN otherwise and are left out, per the optional wire fields.
        if (!std::isnan(h.stress)) entry.set("stress", h.stress);
        if (!std::isnan(h.max_stress)) entry.set("max_stress", h.max_stress);
        history.set(static_cast<int>(i), entry);
    }
    return history;
}

// Level-set branch of optimize_topology: same prebuilt FE problem, a different
// loop (topology_levelset.h). Returns the element densities like SIMP does, plus
// the nodal level set φ (one Float64 per mesh vertex, in solve vertex order) the
// viewport contours at φ = 0.
val run_level_set(mfem::FiniteElementSpace& fespace,
                  const kofem::topopt::ElementStiffnessCache& cache,
                  const mfem::Array<int>& ess_tdof, const mfem::LinearForm& load,
                  double volume_fraction, const val& topopt_js, const val& on_density) {
    kofem::topopt::LevelSetOptConfig config;
    config.volume_fraction = volume_fraction;
    config.regularization_length = jdouble(topopt_js, "filterRadius", 0.0);
    config.max_iterations = jint(topopt_js, "maxIterations", 100);
    config.tolerance = jdouble(topopt_js, "tolerance", 0.01);
    read_index_array(topopt_js["passive"], "solid", config.passive_solid);
    read_index_array(topopt_js["passive"], "void", config.passive_void);
    if (config.max_iterations <= 0)
        return error_result("maxIterations must be a positive integer");
    config.stream.stream_every = jint(topopt_js, "streamEvery", 1);
    if (config.stream.stream_every <= 0)
        return error_result("streamEvery must be a positive integer");
    config.stream.on_density = kofem::topopt::js_density_callback(on_density);

    printf("[topopt] level_set min_compliance volfrac=%.3f: %d elements, %d dofs, "
           "l=%.4g, maxit=%d, tol=%.4g\n",
           config.volume_fraction, fespace.GetNE(), fespace.GetTrueVSize(),
           config.regularization_length, config.max_iterations, config.tolerance);
    fflush(stdout);
    log_mem("topopt: before level-set loop");

    const kofem::topopt::LevelSetOptResult result =
        kofem::topopt::optimize_level_set(fespace, cache, ess_tdof, load, config);

    printf("[topopt] complete: %d iteration(s), %s; returning %d densities and %d "
           "level-set values\n",
           result.iterations, result.converged ? "converged" : "hit max_iterations",
           static_cast<int>(result.density.size()),
           static_cast<int>(result.level_set.size()));
    fflush(stdout);
    log_mem("topopt: complete");

    val out = val::object();
    out.set("density", float64_array(result.density));
    out.set("levelSet", float64_array(result.level_set));
    out.set("history",
            pack_history(result.history, kofem::topopt::TopOptObjective::MinCompliance));
    return out;
}

}  // namespace

val optimize_topology(val mesh_js, const std::string& mat_json,
                      const std::string& bcs_json, const std::string& topopt_json,
                      val on_density) {
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

    if (objective != "min_compliance" && objective != "min_volume")
        return error_result(
            "unknown topology-optimization objective \"" + objective +
            "\" — expected \"min_compliance\" or \"min_volume\"");

    auto constraint = [&](const char* key) {
        return (constraints.isUndefined() || constraints.isNull()) ? val::undefined()
                                                                   : constraints[key];
    };
    auto present = [](const val& v) { return !v.isUndefined() && !v.isNull(); };

    // Each objective requires the bound of its own constraint: a volume fraction
    // for min_compliance, a compliance ceiling for min_volume (KOF-235) — unless a
    // stress limit bounds the min_volume run instead (KOF-236). The remaining
    // knobs fall back to the ADR-0002 defaults.
    const bool min_volume = objective == "min_volume";
    const val max_stress = constraint("maxStress");
    const val bound = constraint(min_volume ? "complianceLimit" : "volumeFraction");
    if (!present(bound) && !(min_volume && present(max_stress)))
        return error_result(
            min_volume ? "the min_volume objective requires constraints.complianceLimit "
                         "(the compliance ceiling c_allow, > 0), constraints.maxStress "
                         "(the von Mises limit sigma_allow, > 0), or both"
                       : "the min_compliance objective requires constraints.volumeFraction "
                         "(the target material fraction, in (0, 1])");

    // Optimization method: SIMP (element densities, the default) or the
    // reaction–diffusion level set (nodal φ, smooth boundary). The level set is
    // minimum-compliance only for now.
    const std::string method = jstring(topopt_js, "method", "simp");
    if (method != "simp" && method != "level_set")
        return error_result("unknown topology-optimization method \"" + method +
                            "\" — expected \"simp\" or \"level_set\"");
    if (method == "level_set") {
        if (present(max_stress) || present(topopt_js["stress"]))
            return error_result(
                "the level-set method does not support the maximum-stress constraint "
                "(constraints.maxStress) — remove the stress limit, or use SIMP for a "
                "stress-constrained run");
        if (min_volume)
            return error_result(
                "the level-set method supports the min_compliance objective only — "
                "switch the objective to minimum compliance, or use SIMP for "
                "min_volume");
        return run_level_set(fespace, cache, ess.ess_tdof, load, bound.as<double>(),
                             topopt_js, on_density);
    }

    kofem::topopt::ComplianceOptConfig config;
    if (min_volume) {
        config.objective = kofem::topopt::TopOptObjective::MinVolume;
        if (present(bound)) {
            config.compliance_limit = bound.as<double>();
            if (!(config.compliance_limit > 0.0))
                return error_result("constraints.complianceLimit must be > 0");
        }
    } else {
        config.objective = kofem::topopt::TopOptObjective::MinCompliance;
        config.volume_fraction = bound.as<double>();
    }

    config.penalty         = jdouble(topopt_js, "penalty", 3.0);

    // Maximum von Mises stress (KOF-236), in the material's stress units. The
    // optional `stress` block tunes the aggregation; see StressConstraintConfig.
    if (present(max_stress)) {
        kofem::topopt::StressConstraintConfig& st = config.stress;
        st.enabled = true;
        st.limit = max_stress.as<double>();
        if (!std::isfinite(st.limit) || st.limit <= 0.0)
            return error_result("constraints.maxStress must be a finite stress > 0");
        val stress_js = topopt_js["stress"];
        const std::string aggregation =
            present(stress_js) ? jstring(stress_js, "aggregation", "pnorm") : "pnorm";
        if (aggregation != "pnorm" && aggregation != "ks")
            return error_result("unknown stress.aggregation \"" + aggregation +
                                "\" — expected \"pnorm\" or \"ks\"");
        st.aggregation = aggregation == "ks" ? kofem::topopt::StressAggregation::KS
                                             : kofem::topopt::StressAggregation::PNorm;
        // Default P per method: the P-norm is already tight at 8; KS works on
        // σ/σ_allow ≈ 1, where it needs a larger parameter for the same tightness.
        const double default_p = aggregation == "ks" ? 40.0 : 8.0;
        // q defaults to p − ½, keeping the relaxed stress at the ρ^½ interpolation
        // of Le et al. (2010) whatever penalty is chosen (q = 2.5 at p = 3).
        const double default_q = config.penalty - 0.5;
        st.aggregation_p = present(stress_js) ? jdouble(stress_js, "p", default_p) : default_p;
        st.relaxation_q  = present(stress_js) ? jdouble(stress_js, "q", default_q) : default_q;
        // The qp-relaxed stress ρ^(p−q)·σ has an unbounded ρ-derivative at ρ = 0,
        // so keep a small positive design floor (1e-3, as in Le et al. 2010).
        config.rho_min = 1e-3;
    } else if (present(topopt_js["stress"])) {
        return error_result("the stress block (aggregation settings) needs "
                            "constraints.maxStress — there is no stress limit to tune");
    }

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
    config.stream.stream_every = jint(topopt_js, "streamEvery", 1);
    if (config.stream.stream_every <= 0)
        return error_result("streamEvery must be a positive integer");
    config.stream.on_density = kofem::topopt::js_density_callback(on_density);

    printf("[topopt] %s%s: %d elements, %d dofs, p=%.2f, r_min=%.4g, move=%.3f, maxit=%d, "
           "tol=%.4g\n",
           kofem::topopt::describe_formulation(config.objective, config.volume_fraction,
                                               config.compliance_limit)
               .c_str(),
           kofem::topopt::describe_stress_constraint(config.stress).c_str(),
           ne, fespace.GetTrueVSize(), config.penalty, config.filter_radius,
           config.move_limit, config.max_iterations, config.tolerance);
    fflush(stdout);
    log_mem("topopt: before optimization loop");

    // The loop streams "[topopt] it N: …" per iteration and throws
    // std::runtime_error on an ill-posed problem (infeasible volume fraction,
    // contradictory passive pins, a solve that fails to converge). Those throws
    // propagate as a C++ exception the worker decodes — the same contract
    // solve_linear_elastic uses for a solve-time failure.
    // The full-material stress operators D₀·B_e, only when a stress limit is set.
    kofem::topopt::ElementStressCache stress_cache;
    if (config.stress.enabled)
        stress_cache = kofem::topopt::build_element_stress_cache(fespace, E0, nu);

    kofem::topopt::ComplianceOptResult result = kofem::topopt::optimize_compliance(
        fespace, cache, ess.ess_tdof, load, config,
        config.stress.enabled ? &stress_cache : nullptr);

    printf("[topopt] complete: %d iteration(s), %s; returning %d densities\n",
           result.iterations, result.converged ? "converged" : "hit max_iterations",
           static_cast<int>(result.density.size()));
    fflush(stdout);
    log_mem("topopt: complete");

    // Binary density (one Float64 per element, solve order — issue #166) plus the
    // iteration history as a small JSON-shaped array. `objective` carries the
    // minimized value (compliance or volume fraction) and `compliance` is always
    // c(ρ); a stress-constrained run adds the aggregated `stress` and the true
    // `max_stress`. Matches the TopOptHistoryEntry wire type in kofem_wasm.d.ts.
    val out = val::object();
    out.set("density", float64_array(result.density));
    out.set("history", pack_history(result.history, config.objective));
    return out;
}
