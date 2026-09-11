// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// SIMP topology-optimization Embind entries for shell + coupled models — see
// topology_shell_entry.h (KOF-237).

#include "topology_shell_entry.h"

#include "json_util.h"
#include "topology_shell.h"
#include "wasm_util.h"

#include <cstdio>
#include <string>
#include <utility>
#include <vector>

using emscripten::val;

namespace {

// Explicit {"error": ...} object, matching solve_*'s contract: the worker checks
// for the key and surfaces the message without tripping the C++-exception decode
// path. Reserved for INPUT validation; a solve-time failure inside
// optimize_shell_compliance throws, and the worker decodes that exception.
val error_result(const std::string& message) {
    val err = val::object();
    err.set("error", message);
    return err;
}

void read_index_array(const val& parent, const char* key, std::vector<int>& out) {
    if (parent.isUndefined() || parent.isNull()) return;
    val arr = parent[key];
    if (arr.isUndefined() || arr.isNull()) return;
    const unsigned n = arr["length"].as<unsigned>();
    out.reserve(n);
    for (unsigned i = 0; i < n; ++i) out.push_back(arr[i].as<int>());
}

// Parse the shared TopOptSettings block into a ShellTopOptConfig. Returns an
// error string (empty on success); the settings contract and defaults match the
// solid entry (topology_simp.cpp), so the two paths validate identically.
std::string parse_topopt_settings(const val& topopt_js, kofem::topopt::ShellTopOptConfig& cfg) {
    const std::string objective = jstring(topopt_js, "objective", "min_compliance");
    val constraints = topopt_js["constraints"];

    if (!constraints.isUndefined() && !constraints.isNull()) {
        val ms = constraints["maxStress"];
        if (!ms.isUndefined() && !ms.isNull())
            return "the maximum-stress constraint (constraints.maxStress) is not "
                   "implemented yet (KOF-236)";
    }
    if (objective == "min_volume")
        return "the min_volume objective (minimize volume subject to a compliance "
               "limit) is not implemented yet (KOF-235) — use objective \"min_compliance\"";
    if (objective != "min_compliance")
        return "unknown topology-optimization objective \"" + objective +
               "\" — expected \"min_compliance\" or \"min_volume\"";

    val vf = (constraints.isUndefined() || constraints.isNull())
                 ? val::undefined()
                 : constraints["volumeFraction"];
    if (vf.isUndefined() || vf.isNull())
        return "the min_compliance objective requires constraints.volumeFraction "
               "(the target material fraction, in (0, 1])";

    cfg.volume_fraction = vf.as<double>();
    cfg.penalty = jdouble(topopt_js, "penalty", 3.0);
    cfg.filter_radius = jdouble(topopt_js, "filterRadius", 0.0);
    cfg.move_limit = jdouble(topopt_js, "moveLimit", 0.2);
    cfg.max_iterations = jint(topopt_js, "maxIterations", 100);
    cfg.tolerance = jdouble(topopt_js, "tolerance", 0.01);
    read_index_array(topopt_js["passive"], "solid", cfg.passive_solid);
    read_index_array(topopt_js["passive"], "void", cfg.passive_void);
    if (cfg.max_iterations <= 0) return "maxIterations must be a positive integer";
    return "";
}

// Pack the optimizer result into the { density, history } object the worker
// expects — identical shape to optimize_topology (topology_simp.cpp).
val pack_result(const kofem::topopt::ShellTopOptResult& result) {
    val out = val::object();
    out.set("density", float64_array(result.density));
    val history = val::array();
    for (std::size_t i = 0; i < result.history.size(); ++i) {
        const auto& h = result.history[i];
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

}  // namespace

val optimize_topology_shell(val mesh, const std::string& mat_json, const std::string& bcs_json,
                            const std::string& topopt_json) {
    log_mem("topopt-shell: start");
    printf("[topopt] optimize_topology_shell: parsing inputs\n");
    fflush(stdout);

    kofem::topopt::ShellTopOptInput in;
    in.vertices = f64_vector(mesh["vertices"], "mesh.vertices");
    in.triangles = i32_vector(mesh["triangles"], "mesh.triangles");
    val thick_js = mesh["thicknesses"];
    if (!thick_js.isUndefined() && !thick_js.isNull())
        in.thicknesses = f64_vector(thick_js, "mesh.thicknesses");
    if (in.vertices.size() % 3 != 0)
        return error_result("mesh.vertices length is not divisible by 3");
    if (in.triangles.size() % 3 != 0)
        return error_result("mesh.triangles length is not divisible by 3");
    in.n_nodes = static_cast<int>(in.vertices.size() / 3);
    const int n_tris = static_cast<int>(in.triangles.size() / 3);
    if (in.n_nodes == 0 || n_tris == 0)
        return error_result("shell topology optimization needs a triangle surface mesh, "
                            "but this mesh has no nodes or no facets");

    val mat = parse_json(mat_json);
    val E = mat["young_modulus"], nu = mat["poisson_ratio"], th = mat["thickness"];
    if (E.isNull() || E.isUndefined()) return error_result("material is missing young_modulus");
    if (nu.isNull() || nu.isUndefined()) return error_result("material is missing poisson_ratio");
    in.shell_young = E.as<double>();
    in.shell_poisson = nu.as<double>();
    const bool has_per_facet = static_cast<int>(in.thicknesses.size()) == n_tris;
    if (!has_per_facet) {
        if (th.isNull() || th.isUndefined())
            return error_result("material is missing thickness (required for shell elements)");
        in.thickness = th.as<double>();
        if (in.thickness <= 0.0) return error_result("shell thickness must be positive");
    }

    val bcs = parse_json(bcs_json);
    // fixed_vertices clamps all six DOFs; fixed_dofs clamps listed components.
    val fv = bcs["fixed_vertices"];
    if (!fv.isUndefined() && !fv.isNull()) {
        const unsigned nfv = fv["length"].as<unsigned>();
        for (unsigned i = 0; i < nfv; ++i) {
            const int v = fv[i].as<int>();
            for (int c = 0; c < 6; ++c) in.fixed_dofs.push_back(6 * v + c);
        }
    }
    val fd = bcs["fixed_dofs"];
    if (!fd.isUndefined() && !fd.isNull()) {
        const unsigned nfd = fd["length"].as<unsigned>();
        for (unsigned i = 0; i < nfd; ++i) {
            val entry = fd[i];
            const int v = entry["vertex"].as<int>();
            val comps = entry["dofs"];
            const unsigned nc = comps["length"].as<unsigned>();
            for (unsigned c = 0; c < nc; ++c) in.fixed_dofs.push_back(6 * v + comps[c].as<int>());
        }
    }
    // A non-zero prescribed displacement breaks the self-adjoint sensitivity —
    // refuse it here with the same message the solid path uses.
    val pd = bcs["prescribed_dofs"];
    if (!pd.isUndefined() && !pd.isNull() && pd["length"].as<unsigned>() > 0)
        return error_result(
            "topology optimization does not support prescribed (non-zero) displacements — "
            "the minimum-compliance objective assumes homogeneous supports (u = 0)");
    val pl = bcs["point_loads"];
    if (!pl.isUndefined() && !pl.isNull()) {
        const unsigned npl = pl["length"].as<unsigned>();
        for (unsigned i = 0; i < npl; ++i) {
            val entry = pl[i];
            const int v = entry["vertex"].as<int>();
            val force = entry["force"];
            if (!force.isUndefined() && !force.isNull())
                for (int c = 0; c < 3; ++c) in.loads.emplace_back(6 * v + c, force[c].as<double>());
            val moment = entry["moment"];
            if (!moment.isUndefined() && !moment.isNull())
                for (int c = 0; c < 3; ++c)
                    in.loads.emplace_back(6 * v + 3 + c, moment[c].as<double>());
        }
    }
    if (in.fixed_dofs.empty())
        return error_result("topology optimization needs at least one fixed support");
    if (in.loads.empty())
        return error_result("topology optimization needs an applied load — the compliance "
                            "objective is trivial without one");

    kofem::topopt::ShellTopOptConfig cfg;
    const std::string err = parse_topopt_settings(parse_json(topopt_json), cfg);
    if (!err.empty()) return error_result(err);

    printf("[topopt] shell min_compliance: %d facets, %d nodes, volfrac=%.3f, p=%.2f, "
           "r_min=%.4g, move=%.3f, maxit=%d\n",
           n_tris, in.n_nodes, cfg.volume_fraction, cfg.penalty, cfg.filter_radius,
           cfg.move_limit, cfg.max_iterations);
    fflush(stdout);
    log_mem("topopt-shell: before loop");

    kofem::topopt::ShellTopOptResult result = kofem::topopt::optimize_shell_compliance(in, cfg);

    printf("[topopt] shell complete: %d iteration(s), %s; returning %d densities\n",
           result.iterations, result.converged ? "converged" : "hit max_iterations",
           static_cast<int>(result.density.size()));
    fflush(stdout);
    log_mem("topopt-shell: complete");
    return pack_result(result);
}

val optimize_topology_coupled(val mesh, val coupling, val bcs, const std::string& mat_json,
                              const std::string& topopt_json) {
    log_mem("topopt-coupled: start");
    printf("[topopt] optimize_topology_coupled: parsing inputs\n");
    fflush(stdout);

    kofem::topopt::ShellTopOptInput in;
    in.vertices = f64_vector(mesh["vertices"], "mesh.vertices");
    in.tets = i32_vector(mesh["tets"], "mesh.tets");
    in.triangles = i32_vector(mesh["triangles"], "mesh.triangles");
    val thick_js = mesh["thicknesses"];
    if (!thick_js.isUndefined() && !thick_js.isNull())
        in.thicknesses = f64_vector(thick_js, "mesh.thicknesses");
    if (in.vertices.size() % 3 != 0 || in.tets.size() % 4 != 0 || in.triangles.size() % 3 != 0)
        return error_result("coupled topology optimization: bad mesh array lengths");
    in.n_nodes = static_cast<int>(in.vertices.size() / 3);
    if (in.tets.empty() && in.triangles.empty())
        return error_result("coupled topology optimization: the design domain has no elements");

    // Materials: one design stiffness per sub-domain. mat.solid is a single object
    // or an array (the first entry sets the solid design stiffness, as the solid
    // path does — TO optimizes one design material per domain in v1); mat.shell is
    // a single object.
    val mat = parse_json(mat_json);
    val solid = mat["solid"], shell = mat["shell"];
    if (in.tets.size() > 0) {
        if (solid.isUndefined() || solid.isNull())
            return error_result("coupled topology optimization: mat.solid is required for a "
                                "domain with solid elements");
        val solid0 = solid["length"].isUndefined() ? solid : solid[0];
        in.solid_young = solid0["young_modulus"].as<double>();
        in.solid_poisson = solid0["poisson_ratio"].as<double>();
    }
    if (in.triangles.size() > 0) {
        if (shell.isUndefined() || shell.isNull())
            return error_result("coupled topology optimization: mat.shell is required for a "
                                "domain with shell elements");
        in.shell_young = shell["young_modulus"].as<double>();
        in.shell_poisson = shell["poisson_ratio"].as<double>();
    }

    // Couplings (CSR-style), matching solve_coupled's contract: optional per-coupling
    // `mpc` kind (0/absent distributing RBE3, 1 relaxed MPC, 2 kinematic RBE2), a
    // shared `relaxation` ψ, and per-coupling `dof_mask` for kinematic couplings.
    std::vector<int> cref = i32_vector(coupling["ref"], "coupling.ref");
    std::vector<int> coff = i32_vector(coupling["offsets"], "coupling.offsets");
    std::vector<int> csolid = i32_vector(coupling["solid"], "coupling.solid");
    std::vector<int> cmpc;
    val mpc_js = coupling["mpc"];
    if (!mpc_js.isUndefined() && !mpc_js.isNull()) cmpc = i32_vector(mpc_js, "coupling.mpc");
    std::vector<int> cdof;
    val dof_js = coupling["dof_mask"];
    if (!dof_js.isUndefined() && !dof_js.isNull()) cdof = i32_vector(dof_js, "coupling.dof_mask");
    double relaxation = 1.0;
    val relax_js = coupling["relaxation"];
    if (!relax_js.isUndefined() && !relax_js.isNull()) relaxation = relax_js.as<double>();
    for (size_t k = 0; k < cref.size(); ++k) {
        kofem::shell::Coupling cp;
        cp.ref_node = cref[k];
        for (int i = coff[k]; i < coff[k + 1]; ++i) cp.solid_nodes.push_back(csolid[i]);
        const int kind = k < cmpc.size() ? cmpc[k] : 0;
        if (kind == 1) {
            cp.kind = kofem::shell::CouplingKind::RelaxedMpc;
            cp.relaxation = relaxation;
        } else if (kind == 2) {
            cp.kind = kofem::shell::CouplingKind::Kinematic;
            cp.dof_mask = k < cdof.size() ? cdof[k] : kofem::shell::kAllDofs;
            if ((cp.dof_mask & kofem::shell::kAllDofs) == 0)
                return error_result("coupled topology optimization: coupling " +
                                    std::to_string(k) + " is kinematic but couples no DOF");
        } else if (kind != 0) {
            return error_result("coupled topology optimization: coupling " + std::to_string(k) +
                                " has unknown kind " + std::to_string(kind));
        }
        in.couplings.push_back(std::move(cp));
    }

    in.fixed_dofs = i32_vector(bcs["fixed_dofs"], "bcs.fixed_dofs");
    val pdofs_js = bcs["prescribed_dofs"];
    if (!pdofs_js.isUndefined() && !pdofs_js.isNull() && pdofs_js["length"].as<unsigned>() > 0)
        return error_result(
            "topology optimization does not support prescribed (non-zero) displacements — "
            "the minimum-compliance objective assumes homogeneous supports (u = 0)");
    std::vector<int> load_dofs = i32_vector(bcs["load_dofs"], "bcs.load_dofs");
    std::vector<double> load_vals = f64_vector(bcs["load_vals"], "bcs.load_vals");
    if (load_dofs.size() != load_vals.size())
        return error_result("coupled topology optimization: load_dofs and load_vals length "
                            "mismatch");
    for (size_t i = 0; i < load_dofs.size(); ++i) in.loads.emplace_back(load_dofs[i], load_vals[i]);
    if (in.fixed_dofs.empty())
        return error_result("topology optimization needs at least one fixed support");
    if (in.loads.empty())
        return error_result("topology optimization needs an applied load");

    kofem::topopt::ShellTopOptConfig cfg;
    const std::string err = parse_topopt_settings(parse_json(topopt_json), cfg);
    if (!err.empty()) return error_result(err);

    printf("[topopt] coupled min_compliance: %d tets + %d facets, %d nodes, %zu couplings, "
           "volfrac=%.3f, p=%.2f, maxit=%d\n",
           static_cast<int>(in.tets.size() / 4), static_cast<int>(in.triangles.size() / 3),
           in.n_nodes, in.couplings.size(), cfg.volume_fraction, cfg.penalty, cfg.max_iterations);
    fflush(stdout);
    log_mem("topopt-coupled: before loop");

    kofem::topopt::ShellTopOptResult result = kofem::topopt::optimize_shell_compliance(in, cfg);

    printf("[topopt] coupled complete: %d iteration(s), %s; returning %d densities\n",
           result.iterations, result.converged ? "converged" : "hit max_iterations",
           static_cast<int>(result.density.size()));
    fflush(stdout);
    log_mem("topopt-coupled: complete");
    return pack_result(result);
}
