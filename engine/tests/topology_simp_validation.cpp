// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Native validation of the SIMP topology-optimization core
// (engine/cpp/topology_simp_core.{h,cpp}) — KOF-228.
//
// Unlike bc_validation / shell_validation, the SIMP core solves a real elastic
// problem, so this test links MFEM and runs under node via Emscripten (see
// scripts/test-topology.sh). It builds a small tetrahedral cantilever, fixes one
// end, loads the other, and checks the three properties the issue asks for:
//   1. a uniform density ρ≡1 reproduces the plain linear-elastic compliance
//      assembled with MFEM's ElasticityIntegrator (validates that the cached
//      per-element assembly equals a direct assembly);
//   2. the SIMP E-scaling is exact — compliance(ρ) = compliance(1) / s(ρ);
//   3. the analytic self-adjoint sensitivity dc/dρ_e matches a central finite
//      difference of the compliance to < 1e-5 relative.
// It also checks the element volumes sum to the box volume. Exits non-zero on
// any failure so it can gate CI.

#include "topology_simp_core.h"

#include <mfem.hpp>

#include <array>
#include <cmath>
#include <cstdio>
#include <vector>

using namespace kofem::topopt;

namespace {

constexpr int dim = 3;

void check(int& failures, const char* name, bool ok, double got, double want) {
    if (!ok) ++failures;
    printf("  [%s] %-52s got %.12g  want %.12g\n", ok ? "PASS" : "FAIL", name, got,
           want);
}

// Reference compliance of a uniform-modulus solve, assembled directly with
// MFEM's ElasticityIntegrator (an independent path from the cached, scaled
// assembly the SIMP core uses).
double reference_compliance(mfem::FiniteElementSpace& fespace,
                            const mfem::Array<int>& ess_tdof,
                            const mfem::LinearForm& load, double E, double nu) {
    const double lam = E * nu / ((1.0 + nu) * (1.0 - 2.0 * nu));
    const double mu = E / (2.0 * (1.0 + nu));
    mfem::ConstantCoefficient lam_c(lam), mu_c(mu);

    mfem::BilinearForm a(&fespace);
    a.AddDomainIntegrator(new mfem::ElasticityIntegrator(lam_c, mu_c));
    a.Assemble();

    mfem::GridFunction x(&fespace);
    x = 0.0;
    mfem::Vector f_ext(load);  // external nodal forces, before BC elimination
    mfem::Vector b(load);
    mfem::OperatorPtr A;
    mfem::Vector B, X;
    a.FormLinearSystem(ess_tdof, x, b, A, X, B);

    mfem::GSSmoother prec(*A.As<mfem::SparseMatrix>());
    mfem::CGSolver cg;
    cg.SetRelTol(1e-10);
    cg.SetMaxIter(10000);
    cg.SetPrintLevel(0);
    cg.SetPreconditioner(prec);
    cg.SetOperator(*A.As<mfem::SparseMatrix>());
    cg.Mult(B, X);
    a.RecoverFEMSolution(X, b, x);

    return mfem::InnerProduct(f_ext, x);  // c = fᵀu
}

}  // namespace

int main() {
    int failures = 0;

    // ── Cantilever: a 6×1×1 box meshed into tets, clamped at x=0, tip load ─────
    const double Lx = 6.0, Ly = 1.0, Lz = 1.0;
    const int nx = 6, ny = 2, nz = 2;
    mfem::Mesh mesh = mfem::Mesh::MakeCartesian3D(
        nx, ny, nz, mfem::Element::TETRAHEDRON, Lx, Ly, Lz);

    mfem::H1_FECollection fec(1, dim);
    mfem::FiniteElementSpace fespace(&mesh, &fec, dim);  // default (byNODES) — as solve_mfem
    const int ne = fespace.GetNE();
    printf("SIMP core validation (KOF-228): %d elements, %d dofs\n", ne,
           fespace.GetTrueVSize());

    // Clamp every DOF of the vertices on the x=0 face.
    mfem::Array<int> ess_tdof;
    const double tol = 1e-9;
    for (int vi = 0; vi < mesh.GetNV(); ++vi) {
        const double* xv = mesh.GetVertex(vi);
        if (xv[0] < tol) {
            mfem::Array<int> vdofs;
            fespace.GetVertexVDofs(vi, vdofs);
            for (int d = 0; d < vdofs.Size(); ++d) ess_tdof.Append(vdofs[d]);
        }
    }
    ess_tdof.Sort();
    ess_tdof.Unique();

    // Downward unit force spread over the vertices of the loaded (x=Lx) face.
    mfem::LinearForm load(&fespace);
    load = 0.0;
    std::vector<int> tip_vertices;
    for (int vi = 0; vi < mesh.GetNV(); ++vi) {
        const double* xv = mesh.GetVertex(vi);
        if (xv[0] > Lx - tol) tip_vertices.push_back(vi);
    }
    const double total_force = 1.0;
    for (int vi : tip_vertices) {
        mfem::Array<int> vdofs;
        fespace.GetVertexVDofs(vi, vdofs);
        load[vdofs[1]] -= total_force / (double)tip_vertices.size();  // -y
    }

    const double E0 = 1.0, nu = 0.3;
    const double penalty = 3.0, emin_rel = 1e-9;
    ElementStiffnessCache cache = build_element_stiffness_cache(fespace, E0, nu);

    // ── Element volumes sum to the box volume ─────────────────────────────────
    printf("\nElement volumes:\n");
    double vol_sum = 0.0;
    for (double v : cache.volume) vol_sum += v;
    check(failures, "Σ element volume == box volume",
          std::abs(vol_sum - Lx * Ly * Lz) < 1e-9, vol_sum, Lx * Ly * Lz);

    // ── (1) Uniform ρ≡1 reproduces the plain linear-elastic compliance ────────
    printf("\nUniform density ρ≡1 vs. direct ElasticityIntegrator solve:\n");
    std::vector<double> rho_one(ne, 1.0);
    ComplianceEvaluation ev1 =
        evaluate_compliance(fespace, cache, ess_tdof, load, rho_one, penalty, emin_rel);
    const double s1 = simp_scale(1.0, penalty, emin_rel);
    const double c_ref = reference_compliance(fespace, ess_tdof, load, E0 * s1, nu);
    check(failures, "compliance == direct-assembly reference",
          std::abs(ev1.compliance - c_ref) <= 1e-9 * std::abs(c_ref), ev1.compliance,
          c_ref);

    // ── (2) SIMP E-scaling is exact: c(ρ) = c(1) / s(ρ) ───────────────────────
    printf("\nSIMP E-scaling (ρ≡0.5):\n");
    std::vector<double> rho_half(ne, 0.5);
    ComplianceEvaluation ev_half =
        evaluate_compliance(fespace, cache, ess_tdof, load, rho_half, penalty, emin_rel);
    const double s_half = simp_scale(0.5, penalty, emin_rel);
    const double c_expect = ev1.compliance / s_half;
    check(failures, "compliance(0.5) == compliance(1) / s(0.5)",
          std::abs(ev_half.compliance - c_expect) <= 1e-9 * std::abs(c_expect),
          ev_half.compliance, c_expect);

    // ── (3) Analytic sensitivity vs. central finite difference ────────────────
    printf("\nSensitivity dc/dρ_e vs. central finite difference (base ρ≡0.5):\n");
    const double h = 1e-4;
    bool all_nonpos = true, all_energy_nonneg = true;
    for (double d : ev_half.dcompliance)
        if (d > 0.0) all_nonpos = false;
    for (double q : ev_half.strain_energy)
        if (q < 0.0) all_energy_nonneg = false;
    check(failures, "all dc/dρ_e <= 0", all_nonpos, all_nonpos ? 1 : 0, 1);
    check(failures, "all strain energy q_e >= 0", all_energy_nonneg,
          all_energy_nonneg ? 1 : 0, 1);

    const std::vector<int> sample = {0, ne / 4, ne / 2, (3 * ne) / 4, ne - 1};
    for (int e : sample) {
        std::vector<double> rp = rho_half, rm = rho_half;
        rp[e] += h;
        rm[e] -= h;
        const double cp =
            evaluate_compliance(fespace, cache, ess_tdof, load, rp, penalty, emin_rel)
                .compliance;
        const double cm =
            evaluate_compliance(fespace, cache, ess_tdof, load, rm, penalty, emin_rel)
                .compliance;
        const double fd = (cp - cm) / (2.0 * h);
        const double an = ev_half.dcompliance[e];
        const double rel = std::abs(fd - an) / std::max(std::abs(an), 1e-30);
        std::array<char, 64> name;
        std::snprintf(name.data(), name.size(), "element %d: FD vs analytic (rel %.2e)", e,
                      rel);
        check(failures, name.data(), rel < 1e-5, fd, an);
    }

    printf(failures != 0 ? "\n%d check(s) FAILED\n" : "\nall checks passed\n", failures);
    return failures != 0 ? 1 : 0;
}
