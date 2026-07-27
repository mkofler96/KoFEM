// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Coupled solid + shell solve (Option A). See solve_coupled.h.
//
// The solid tets are assembled by MFEM (reusing its mature elasticity element),
// and the assembled sparse stiffness is extracted as triplets over a 3-DOF/node
// numbering and handed to shell_core's solve_solid_shell_core, which adds the DKT
// shells (6 DOF/node) and the RBE3 distributing couplings and solves. This keeps
// the solid physics in MFEM while the shell + coupling live in the MFEM-free core.

#include "solve_coupled.h"

#include "json_util.h"
#include "shell_core.h"
#include "wasm_util.h"

#include <mfem.hpp>

#include <string>
#include <vector>

using emscripten::val;

namespace {

val error_result(const std::string& message) {
    val err = val::object();
    err.set("error", message);
    return err;
}

// Assemble the linear-elastic tet stiffness with MFEM and return it as triplets
// over a 3·node+component numbering (no essential BCs eliminated).
//
// `attributes[e]` is the 1-based index of tet e's material into `youngs` /
// `poissons`; empty ⇒ every tet takes material 1. The index rides on the MFEM
// element attribute, so a PWConstCoefficient picks λ and μ per element and one
// assembly covers an assembly of several materials.
std::vector<kofem::shell::SolidTriplet> assemble_solid_stiffness_mfem(
    const std::vector<double>& vertices, const std::vector<int>& tets,
    const std::vector<double>& youngs, const std::vector<double>& poissons,
    const std::vector<int>& attributes) {
    const int nv = static_cast<int>(vertices.size() / 3);
    const int nt = static_cast<int>(tets.size() / 4);
    const int nMat = static_cast<int>(youngs.size());
    mfem::Mesh mesh(3, nv, nt, /*NBdrElem=*/0, /*spaceDim=*/3);
    for (int i = 0; i < nv; ++i)
        mesh.AddVertex(vertices[3 * i], vertices[3 * i + 1], vertices[3 * i + 2]);
    for (int e = 0; e < nt; ++e)
        mesh.AddTet(tets[4 * e], tets[4 * e + 1], tets[4 * e + 2], tets[4 * e + 3],
                    attributes.empty() ? 1 : attributes[e]);
    mesh.FinalizeTopology(/*generate_bdr=*/true);
    mesh.Finalize(/*refine=*/false, /*fix_orientation=*/true);
    mesh.SetAttributes();

    mfem::H1_FECollection fec(1, 3);
    mfem::FiniteElementSpace fespace(&mesh, &fec, 3);
    // PWConstCoefficient indexes its constants by attribute − 1, so the vectors
    // must span every attribute present, not just the materials in use.
    mfem::Vector lam(nMat), mu(nMat);
    for (int m = 0; m < nMat; ++m) {
        lam(m) = youngs[m] * poissons[m] /
                 ((1.0 + poissons[m]) * (1.0 - 2.0 * poissons[m]));
        mu(m) = youngs[m] / (2.0 * (1.0 + poissons[m]));
    }
    mfem::PWConstCoefficient lam_c(lam), mu_c(mu);
    mfem::BilinearForm a(&fespace);
    a.AddDomainIntegrator(new mfem::ElasticityIntegrator(lam_c, mu_c));
    a.Assemble();
    a.Finalize();
    mfem::SparseMatrix& A = a.SpMat();

    // Map each MFEM vector DOF back to (vertex, component).
    std::vector<int> vdof_node(fespace.GetVSize(), -1), vdof_comp(fespace.GetVSize(), -1);
    for (int v = 0; v < nv; ++v) {
        mfem::Array<int> vd;
        fespace.GetVertexVDofs(v, vd);
        for (int c = 0; c < vd.Size(); ++c) {
            vdof_node[vd[c]] = v;
            vdof_comp[vd[c]] = c;
        }
    }
    const int* I = A.GetI();
    const int* J = A.GetJ();
    const double* D = A.GetData();
    std::vector<kofem::shell::SolidTriplet> out;
    out.reserve(A.NumNonZeroElems());
    for (int row = 0; row < A.Height(); ++row)
        for (int k = I[row]; k < I[row + 1]; ++k) {
            const int col = J[k];
            if (D[k] == 0.0) continue;
            out.push_back({3 * vdof_node[row] + vdof_comp[row],
                           3 * vdof_node[col] + vdof_comp[col], D[k]});
        }
    return out;
}

}  // namespace

val solve_coupled(const val& mesh, const val& coupling, const val& bcs,
                  const std::string& mat_json) {
    kofem::shell::CoupledInput in;
    in.vertices = f64_vector(mesh["vertices"], "mesh.vertices");
    in.n_nodes = static_cast<int>(in.vertices.size() / 3);
    std::vector<int> tets = i32_vector(mesh["tets"], "mesh.tets");
    in.triangles = i32_vector(mesh["triangles"], "mesh.triangles");
    val thick_js = mesh["thicknesses"];
    if (!thick_js.isUndefined() && !thick_js.isNull())
        in.thicknesses = f64_vector(thick_js, "mesh.thicknesses");

    if (in.vertices.size() % 3 != 0 || tets.size() % 4 != 0 || in.triangles.size() % 3 != 0)
        return error_result("coupled: bad mesh array lengths");

    // `mat.solid` is either one material object (every tet uses it) or an ARRAY
    // of materials selected per tet by `mesh.attributes` (1-based), matching
    // solve_linear_elastic's contract. Only the solid side is per-body: a solve
    // shells exactly one body (#376), so one shell material covers it.
    val mat = parse_json(mat_json);
    val solid = mat["solid"], shell = mat["shell"];
    std::vector<double> solidE, solidNu;
    if (solid["length"].isUndefined()) {
        solidE.push_back(solid["young_modulus"].as<double>());
        solidNu.push_back(solid["poisson_ratio"].as<double>());
    } else {
        const unsigned n = solid["length"].as<unsigned>();
        if (n == 0) return error_result("coupled: mat.solid is an empty material array");
        for (unsigned m = 0; m < n; ++m) {
            solidE.push_back(solid[m]["young_modulus"].as<double>());
            solidNu.push_back(solid[m]["poisson_ratio"].as<double>());
        }
    }
    std::vector<int> attributes;
    val attr_js = mesh["attributes"];
    if (!attr_js.isUndefined() && !attr_js.isNull())
        attributes = i32_vector(attr_js, "mesh.attributes");
    if (!attributes.empty() && attributes.size() != tets.size() / 4)
        return error_result("coupled: " + std::to_string(attributes.size()) +
                            " mesh.attributes for " + std::to_string(tets.size() / 4) +
                            " tets");
    for (size_t e = 0; e < attributes.size(); ++e)
        if (attributes[e] < 1 || static_cast<size_t>(attributes[e]) > solidE.size())
            return error_result("coupled: tet " + std::to_string(e) + " selects material " +
                                std::to_string(attributes[e]) + ", outside 1.." +
                                std::to_string(solidE.size()));
    in.shell_young = shell["young_modulus"].as<double>();
    in.shell_poisson = shell["poisson_ratio"].as<double>();

    // Couplings (CSR-style). Optional per-coupling `mpc` flags (1 ⇒ relaxed
    // shell-to-solid MPC, 0/absent ⇒ distributing RBE3) and a single `relaxation`
    // ψ shared by the MPC couplings.
    std::vector<int> cref = i32_vector(coupling["ref"], "coupling.ref");
    std::vector<int> coff = i32_vector(coupling["offsets"], "coupling.offsets");
    std::vector<int> csolid = i32_vector(coupling["solid"], "coupling.solid");
    std::vector<int> cmpc;
    val mpc_js = coupling["mpc"];
    if (!mpc_js.isUndefined() && !mpc_js.isNull()) cmpc = i32_vector(mpc_js, "coupling.mpc");
    double relaxation = 1.0;
    val relax_js = coupling["relaxation"];
    if (!relax_js.isUndefined() && !relax_js.isNull()) relaxation = relax_js.as<double>();
    for (size_t k = 0; k < cref.size(); ++k) {
        kofem::shell::Coupling cp;
        cp.ref_node = cref[k];
        for (int i = coff[k]; i < coff[k + 1]; ++i) cp.solid_nodes.push_back(csolid[i]);
        if (k < cmpc.size() && cmpc[k] != 0) {
            cp.mpc = true;
            cp.relaxation = relaxation;
        }
        in.couplings.push_back(std::move(cp));
    }

    in.fixed_dofs = i32_vector(bcs["fixed_dofs"], "bcs.fixed_dofs");
    std::vector<int> load_dofs = i32_vector(bcs["load_dofs"], "bcs.load_dofs");
    std::vector<double> load_vals = f64_vector(bcs["load_vals"], "bcs.load_vals");
    for (size_t i = 0; i < load_dofs.size(); ++i)
        in.loads.emplace_back(load_dofs[i], load_vals[i]);

    printf("[coupled] solid %zu tets (%zu material%s), shell %zu tris, %zu couplings, "
           "%zu fixed, %zu loads\n",
           tets.size() / 4, solidE.size(), solidE.size() == 1 ? "" : "s",
           in.triangles.size() / 3, in.couplings.size(), in.fixed_dofs.size(),
           in.loads.size());
    fflush(stdout);

    try {
        in.solid_stiffness =
            assemble_solid_stiffness_mfem(in.vertices, tets, solidE, solidNu, attributes);
    } catch (const std::exception& e) {
        printf("[coupled] solid assembly failed: %s\n", e.what());
        fflush(stdout);
        return error_result(std::string("coupled: solid assembly failed: ") + e.what());
    }
    printf("[coupled] MFEM solid stiffness: %zu triplets\n", in.solid_stiffness.size());
    fflush(stdout);

    kofem::shell::ShellResult r;
    try {
        r = kofem::shell::solve_solid_shell_core(in);
    } catch (const std::exception& e) {
        printf("[coupled] solve failed: %s\n", e.what());
        fflush(stdout);
        return error_result(std::string("coupled solve failed: ") + e.what());
    }
    if (!r.converged)
        return error_result("coupled CG did not converge: relative residual " +
                            std::to_string(r.rel_residual) + " after " +
                            std::to_string(r.iterations) + " iterations");
    printf("[coupled] converged: %d iterations, rel residual %.3e\n", r.iterations, r.rel_residual);
    fflush(stdout);

    std::vector<double> disp(3 * (size_t)in.n_nodes, 0.0);
    for (int v = 0; v < in.n_nodes; ++v)
        for (int c = 0; c < 3; ++c) disp[3 * v + c] = r.dofs[6 * v + c];

    // Von Mises stress: one value per solid tet (constant-strain recovery) and
    // one per shell facet (surface stress from membrane + bending, worse of the
    // two surfaces z = ±t/2) — the caller maps these onto its element list.
    const std::vector<double> vm_tets =
        kofem::shell::tet_von_mises(in.vertices, tets, solidE, solidNu, attributes, r.dofs);
    const std::vector<double> vm_tris = kofem::shell::shell_von_mises(
        in.vertices, in.triangles, in.thickness, in.thicknesses, in.shell_young,
        in.shell_poisson, r.dofs);

    val result = val::object();
    result.set("displacements", float64_array(disp));
    result.set("von_mises_tets", float64_array(vm_tets));
    result.set("von_mises_tris", float64_array(vm_tris));
    result.set("iterations", r.iterations);
    return result;
}
