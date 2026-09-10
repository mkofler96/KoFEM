// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// MFEM: linear-elastic FEM solve. See solve_mfem.h.
//
// solve_linear_elastic is a thin orchestrator over the pipeline stages below
// (issue #293): copy in the mesh typed arrays → build the MFEM mesh → collect essential
// (Dirichlet) DOFs → assemble loads → CG solve → recover displacements and
// von Mises stress. Two orderings are load-bearing and owned by the
// orchestrator, not the helpers: the surface-load coefficient/marker storage
// must outlive b.Assemble(), and prescribed displacement values must be seeded
// into the solution GridFunction before FormLinearSystem.

#include "solve_mfem.h"

#include "bc_validation.h"
#include "fem_bc_io.h"
#include "fem_mesh_io.h"
#include "json_util.h"
#include "wasm_util.h"

#include <mfem.hpp>

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdio>
#include <deque>
#include <map>
#include <memory>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

using emscripten::val;

namespace {

constexpr int dim = 3;

// Streams CG convergence to the browser log panel (issue #278), giving the
// solve the same live progress feed the mesher has. MFEM's own per-iteration
// report goes to mfem::out (C++ iostreams), which this build avoids (see the
// mesh-construction note below) — printf matches the rest of the pipeline and
// reliably reaches the worker's log stream. The norm MFEM hands the monitor is
// (B·r, r), the squared preconditioned residual, so the relative residual
// shown is √(norm / norm₀).
class CGLogMonitor : public mfem::IterativeSolverMonitor {
    double norm0_ = 0.0;
    int stride_;

public:
    explicit CGLogMonitor(int stride) : stride_(stride) {}

    void MonitorResidual(int it, mfem::real_t norm, const mfem::Vector& /*r*/,
                         bool final) override {
        if (it == 0)
            norm0_ = (double)norm;
        // The final call repeats the last in-loop iteration; the summary
        // printed after cg.Mult reports it instead.
        if (final || it % stride_ != 0)
            return;
        double rel = norm0_ > 0.0 ? std::sqrt((double)norm / norm0_) : 0.0;
        printf("[mfem] CG iteration %4d: relative residual %.3e\n", it, rel);
        fflush(stdout);
    }
};

// ── Solve / post-processing ───────────────────────────────────────────────────

void run_cg_solve(mfem::SparseMatrix& A_mat, const mfem::Vector& B, mfem::Vector& X) {
    // GSSmoother (Gauss-Seidel) is numerically robust for 3D elasticity after
    // Dirichlet BC elimination.  DSmoother (Jacobi) diverges on ill-conditioned
    // tet systems, producing NaN residuals that crash the WASM worker.
    mfem::GSSmoother prec(A_mat);
    mfem::CGSolver cg;
    // 1e-6 for both element orders: anything looser leaves visible noise in the
    // recovered stress field (#192, #306). MaxIter 5000 gives large or
    // ill-conditioned meshes room to actually reach that tolerance; hitting the
    // cap without converging is an error (checked after Mult below), not a
    // silently returned best iterate (#313).
    cg.SetRelTol(1e-6);
    cg.SetMaxIter(5000);
    // Errors/warnings only: iteration progress is streamed by CGLogMonitor via
    // printf so it reaches the browser log panel (mfem::out iostream output
    // does not survive this WASM build — see the mesh-construction note above).
    cg.SetPrintLevel(0);
    CGLogMonitor cg_monitor(/*stride=*/10);
    cg.SetMonitor(cg_monitor);
    cg.SetPreconditioner(prec);
    cg.SetOperator(A_mat);
    printf("[mfem] starting CG solve (%d rows)…\n", A_mat.Height()); fflush(stdout);
    log_mem("solve: before CG solve");
    cg.Mult(B, X);
    // MFEM's CGSolver does not throw on hitting MaxIter — it returns the best
    // iterate. Using that under-converged field would silently show wrong
    // displacements/stresses, so fail the solve instead (#192, #313). The
    // worker decodes this exception and the UI shows it in the error banner.
    if (!cg.GetConverged()) {
        std::array<char, 192> msg;
        snprintf(msg.data(), msg.size(),
                 "CG solver did not converge: relative residual %g after %d "
                 "iterations (target 1e-6). The partial result was discarded — "
                 "check that the model is fully constrained, or refine the mesh.",
                 (double)cg.GetFinalRelNorm(), cg.GetNumIterations());
        throw std::runtime_error(msg.data());
    }
    printf("[mfem] CG converged: %d iterations, relative residual %.3e\n",
           cg.GetNumIterations(), (double)cg.GetFinalRelNorm());
    fflush(stdout);
}

std::vector<double> extract_displacements(mfem::FiniteElementSpace& fespace,
                                          const mfem::GridFunction& x, int n_verts) {
    std::vector<double> displacements(3 * (size_t)n_verts, 0.0);
    for (int vi = 0; vi < n_verts; ++vi) {
        mfem::Array<int> vdofs;
        fespace.GetVertexVDofs(vi, vdofs);
        for (int c = 0; c < dim && c < vdofs.Size(); ++c)
            displacements[3*vi + c] = x[vdofs[c]];
    }
    return displacements;
}

// Per-element von Mises stress at the element center: strain from the
// displacement gradient, Cauchy stress via the Lamé constants of the element's
// material (attribute = 1-based index into lam/mu), then the deviatoric second
// invariant √(3/2 s:s).
std::vector<double> compute_von_mises(mfem::Mesh& mesh, const mfem::GridFunction& x,
                                      const mfem::Vector& lam_by_mat,
                                      const mfem::Vector& mu_by_mat) {
    int n_elems = mesh.GetNE();
    std::vector<double> von_mises(n_elems);
    for (int e = 0; e < n_elems; ++e) {
        const double lam = lam_by_mat(mesh.GetAttribute(e) - 1);
        const double mu  = mu_by_mat(mesh.GetAttribute(e) - 1);
        mfem::ElementTransformation* T = mesh.GetElementTransformation(e);
        const mfem::IntegrationRule& ir =
            mfem::IntRules.Get(mesh.GetElementGeometry(e), 1);
        T->SetIntPoint(&ir.IntPoint(0));

        mfem::DenseMatrix grad_u;
        x.GetVectorGradient(*T, grad_u);

        std::array<std::array<double, 3>, 3> eps;
        for (int i = 0; i < 3; ++i)
            for (int j = 0; j < 3; ++j)
                eps[i][j] = 0.5 * (grad_u(i,j) + grad_u(j,i));

        double tr_eps = eps[0][0] + eps[1][1] + eps[2][2];
        std::array<std::array<double, 3>, 3> s;
        for (int i = 0; i < 3; ++i)
            for (int j = 0; j < 3; ++j)
                s[i][j] = (i == j ? lam * tr_eps : 0.0) + 2.0 * mu * eps[i][j];

        double tr_s = s[0][0] + s[1][1] + s[2][2];
        double vm2  = 0.0;
        for (int i = 0; i < 3; ++i)
            for (int j = 0; j < 3; ++j) {
                double dev = s[i][j] - (i == j ? tr_s / 3.0 : 0.0);
                vm2 += dev * dev;
            }
        von_mises[e] = std::sqrt(1.5 * vm2);
    }
    return von_mises;
}

}  // namespace

namespace {
// Explicit error object for input validation, mirroring the previous JSON
// {"error": ...} contract (issue #344) — the worker checks for the key and
// surfaces the message without tripping the C++-exception decode path.
val error_result(const char* message) {
    val err = val::object();
    err.set("error", std::string(message));
    return err;
}
}  // namespace

val solve_linear_elastic(
    val mesh_js,
    const std::string& mat_json,
    const std::string& bcs_json,
    int order)
{
    using namespace mfem;

    log_mem("solve: start");
    printf("[mfem] solve_linear_elastic: parsing inputs\n"); fflush(stdout);
    val mat_js  = parse_json(mat_json);
    val bcs_js  = parse_json(bcs_json);

    kofem::fem::MeshArrays mesh_arrays = kofem::fem::parse_mesh(mesh_js);

    // mat_json is either an array of materials — element attribute k selects
    // the k-th entry (multibody per-body materials, issue #353) — or a single
    // material object, the pre-#353 contract still used by direct callers.
    const bool is_mat_array =
        val::global("Array").call<bool>("isArray", mat_js);
    const unsigned n_mats =
        is_mat_array ? mat_js["length"].as<unsigned>() : 1U;
    if (n_mats == 0) {
        return error_result("materials array is empty — at least one material is required");
    }
    std::vector<double> E_by_mat(n_mats);
    std::vector<double> nu_by_mat(n_mats);
    for (unsigned k = 0; k < n_mats; ++k) {
        val mat    = is_mat_array ? mat_js[k] : mat_js;
        val E_val  = mat["young_modulus"];
        val nu_val = mat["poisson_ratio"];
        if (E_val.isNull() || E_val.isUndefined()) {
            return error_result(
                ("material " + std::to_string(k + 1) + " is missing young_modulus").c_str());
        }
        if (nu_val.isNull() || nu_val.isUndefined()) {
            return error_result(
                ("material " + std::to_string(k + 1) + " is missing poisson_ratio").c_str());
        }
        E_by_mat[k]  = E_val.as<double>();
        nu_by_mat[k] = nu_val.as<double>();
    }
    for (int a : mesh_arrays.attrs) {
        if ((unsigned)a > n_mats) {
            return error_result(
                ("mesh.attributes references material " + std::to_string(a) +
                 " but only " + std::to_string(n_mats) + " material(s) were provided").c_str());
        }
    }

    val loads_js = bcs_js["point_loads"];
    printf("[mfem] BCs: %u fixed vertices, %u point loads\n",
           bcs_js["fixed_vertices"]["length"].as<unsigned>(),
           loads_js["length"].as<unsigned>());
    fflush(stdout);
    log_mem("solve: after extracting mesh data");

    Mesh mfem_mesh = kofem::fem::build_mfem_mesh(mesh_arrays);

    order = std::max(1, order);
    // Lamé constants per material, indexed by (element attribute − 1) — the
    // layout PWConstCoefficient expects.
    Vector lam_by_mat((int)n_mats), mu_by_mat((int)n_mats);
    for (unsigned k = 0; k < n_mats; ++k) {
        const double E  = E_by_mat[k];
        const double nu = nu_by_mat[k];
        lam_by_mat((int)k) = E * nu / ((1.0 + nu) * (1.0 - 2.0*nu));
        mu_by_mat((int)k)  = E / (2.0 * (1.0 + nu));
    }
    if (n_mats > 1) {
        printf("[mfem] %u materials (per-element attributes)\n", n_mats);
        fflush(stdout);
    }

    printf("[mfem] setting up H1 FE space (order=%d, dim=%d)…\n", order, dim);
    fflush(stdout);
    H1_FECollection fec(order, dim);
    FiniteElementSpace fespace(&mfem_mesh, &fec, dim);
    printf("[mfem] FE space: %d dofs\n", fespace.GetTrueVSize());
    fflush(stdout);
    log_mem("solve: after FE space setup");

    kofem::fem::EssentialBcs ess =
        kofem::fem::collect_essential_dofs(bcs_js, mfem_mesh, fespace, order);

    GridFunction x(&fespace);
    x = 0.0;
    // Seed the prescribed components before FormLinearSystem so the eliminated
    // essential DOFs carry the requested displacement instead of zero.
    for (const auto& pv : ess.prescribed_vals)
        x[pv.first] = pv.second;

    LinearForm b(&fespace);
    // Coefficients/markers referenced by b's integrators — must outlive
    // b.Assemble(), hence owned here rather than inside apply_surface_loads.
    kofem::fem::SurfaceLoadStorage surf_storage;
    kofem::fem::apply_surface_loads(bcs_js["surface_loads"], mfem_mesh, b, surf_storage);

    b.Assemble();

    kofem::fem::apply_point_loads(loads_js, fespace, b);

    BilinearForm a(&fespace);
    // Piecewise-constant over element attributes: attribute k reads entry k−1.
    // With a single material every element has attribute 1, reproducing the
    // former ConstantCoefficient behaviour exactly.
    PWConstCoefficient lam_c(lam_by_mat), mu_c(mu_by_mat);
    a.AddDomainIntegrator(new ElasticityIntegrator(lam_c, mu_c));
    printf("[mfem] assembling stiffness matrix…\n"); fflush(stdout);
    a.Assemble();
    printf("[mfem] assembly done\n"); fflush(stdout);
    log_mem("solve: after stiffness assembly");

    OperatorPtr A;
    Vector B, X;
    a.FormLinearSystem(ess.ess_tdof, x, b, A, X, B);

    run_cg_solve(*A.As<SparseMatrix>(), B, X);
    a.RecoverFEMSolution(X, b, x);
    printf("[mfem] CG done — computing von Mises stress…\n"); fflush(stdout);
    log_mem("solve: after CG solve");

    std::vector<double> displacements =
        extract_displacements(fespace, x, mfem_mesh.GetNV());
    std::vector<double> von_mises =
        compute_von_mises(mfem_mesh, x, lam_by_mat, mu_by_mat);

    printf("[mfem] solve complete: %d vertex displacements, %d element stresses\n",
           mfem_mesh.GetNV(), mfem_mesh.GetNE());
    fflush(stdout);
    log_mem("solve: complete");

    // Flat typed arrays instead of JSON text (issue #166): three Float64
    // displacement components per vertex, one Float64 von Mises value per
    // element. The worker transfers both buffers to the main thread zero-copy.
    val result = val::object();
    result.set("displacements", float64_array(displacements));
    result.set("von_mises",     float64_array(von_mises));
    return result;
}
