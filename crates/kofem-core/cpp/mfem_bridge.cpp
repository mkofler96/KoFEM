#include "mfem_bridge.h"
#include "mfem.hpp"

#include <cmath>
#include <cstring>
#include <memory>
#include <vector>

using namespace mfem;

struct MfemMeshState {
    std::unique_ptr<Mesh> mesh;
};

struct MfemSolutionState {
    std::vector<double> displacements; // 3 * n_vertices
    std::vector<double> von_mises;     // n_elements
    int n_vertices;
    int n_elements;
};

extern "C" {

MfemMeshHandle mfem_create_mesh(
    const double*  vertices,  size_t n_vertices,
    const int32_t* tets,      size_t n_tets,
    const char** err)
{
    *err = nullptr;
    constexpr int dim = 3;

    // Mesh(Dim, NVert, NElem, NBdrElem, spaceDim)
    auto* state = new MfemMeshState();
    state->mesh = std::make_unique<Mesh>(
        dim,
        static_cast<int>(n_vertices),
        static_cast<int>(n_tets),
        /*NBdrElem=*/0,
        /*spaceDim=*/dim);

    for (size_t i = 0; i < n_vertices; ++i) {
        state->mesh->AddVertex(vertices + 3*i);
    }

    for (size_t i = 0; i < n_tets; ++i) {
        int vi[4] = {
            (int)tets[4*i],   (int)tets[4*i+1],
            (int)tets[4*i+2], (int)tets[4*i+3]
        };
        state->mesh->AddTet(vi, /*attr=*/1);
    }

    state->mesh->FinalizeTetMesh(/*generate_edges=*/1, /*refine=*/0, /*fix_orientation=*/true);
    return static_cast<MfemMeshHandle>(state);
}

MfemSolutionHandle mfem_solve_linear_elastic(
    MfemMeshHandle raw_mesh,
    const MfemElasticParams* params,
    const MfemFixedVertex* fixed, size_t n_fixed,
    const MfemPointLoad*   loads, size_t n_loads,
    const char** err)
{
    *err = nullptr;
    auto* ms = static_cast<MfemMeshState*>(raw_mesh);
    Mesh& mesh = *ms->mesh;

    const int dim   = mesh.Dimension();
    const int order = std::max(1, params->order);

    // Lamé parameters
    const double E  = params->young_modulus;
    const double nu = params->poisson_ratio;
    const double lam = E * nu / ((1.0 + nu) * (1.0 - 2.0 * nu));
    const double mu  = E / (2.0 * (1.0 + nu));

    H1_FECollection fec(order, dim);
    FiniteElementSpace fespace(&mesh, &fec, dim);

    // Collect essential (Dirichlet) DOFs directly from fixed vertex indices.
    // In a serial H1 space, local DOF == true DOF.
    Array<int> ess_tdof_list;
    for (size_t i = 0; i < n_fixed; ++i) {
        Array<int> vdofs;
        fespace.GetVertexVDofs(fixed[i].vertex_index, vdofs);
        for (int j = 0; j < vdofs.Size(); ++j)
            ess_tdof_list.Append(vdofs[j]);
    }
    ess_tdof_list.Sort();
    ess_tdof_list.Unique();

    // Zero-initialised solution vector (satisfies u=0 at fixed vertices)
    GridFunction x(&fespace);
    x = 0.0;

    // Linear form: start from zero, then add point loads at specific DOFs
    LinearForm b(&fespace);
    b.Assemble(); // initialises to zero

    for (size_t i = 0; i < n_loads; ++i) {
        const auto& load = loads[i];
        Array<int> vdofs;
        fespace.GetVertexVDofs(load.vertex_index, vdofs);
        if (vdofs.Size() >= 3) {
            b[vdofs[0]] += load.fx;
            b[vdofs[1]] += load.fy;
            b[vdofs[2]] += load.fz;
        }
    }

    // Bilinear form: linear elasticity
    BilinearForm a(&fespace);
    ConstantCoefficient lambda_coef(lam), mu_coef(mu);
    a.AddDomainIntegrator(new ElasticityIntegrator(lambda_coef, mu_coef));
    a.Assemble();

    // Apply essential BCs and form the reduced system
    OperatorPtr A;
    Vector B, X;
    a.FormLinearSystem(ess_tdof_list, x, b, A, X, B);

    // Solve with preconditioned CG
    SparseMatrix& A_mat = *A.As<SparseMatrix>();
    GSSmoother prec(A_mat);
    CGSolver cg;
    cg.SetRelTol(1e-8);
    cg.SetMaxIter(3000);
    cg.SetPrintLevel(0);
    cg.SetPreconditioner(prec);
    cg.SetOperator(A_mat);
    cg.Mult(B, X);

    a.RecoverFEMSolution(X, b, x);

    // --- Cache results ---
    auto* sol = new MfemSolutionState();
    sol->n_vertices = mesh.GetNV();
    sol->n_elements = mesh.GetNE();

    // Displacements at mesh vertices
    sol->displacements.resize(3 * static_cast<size_t>(sol->n_vertices), 0.0);
    for (int vi = 0; vi < sol->n_vertices; ++vi) {
        Array<int> vdofs;
        fespace.GetVertexVDofs(vi, vdofs);
        for (int c = 0; c < dim && c < vdofs.Size(); ++c)
            sol->displacements[3*vi + c] = x[vdofs[c]];
    }

    // Von-Mises stress: evaluated at element barycentre via displacement gradient
    sol->von_mises.resize(static_cast<size_t>(sol->n_elements), 0.0);
    for (int e = 0; e < sol->n_elements; ++e) {
        ElementTransformation* T = mesh.GetElementTransformation(e);

        // Integration point at the reference-element barycentre (order-1 rule)
        const IntegrationRule& ir = IntRules.Get(mesh.GetElementGeometry(e), 1);
        T->SetIntPoint(&ir.IntPoint(0));

        DenseMatrix grad_u;
        x.GetVectorGradient(*T, grad_u); // 3×3 displacement gradient

        // Symmetric strain ε = 0.5(∇u + ∇uᵀ)
        double eps[3][3];
        for (int i = 0; i < 3; ++i)
            for (int j = 0; j < 3; ++j)
                eps[i][j] = 0.5 * (grad_u(i,j) + grad_u(j,i));

        // Cauchy stress σ = λ tr(ε) I + 2μ ε
        double tr_eps = eps[0][0] + eps[1][1] + eps[2][2];
        double s[3][3];
        for (int i = 0; i < 3; ++i)
            for (int j = 0; j < 3; ++j)
                s[i][j] = (i == j ? lam * tr_eps : 0.0) + 2.0 * mu * eps[i][j];

        // Von-Mises = √(3/2 · sᵢⱼ sᵢⱼ) where s is the deviatoric stress
        double tr_s = s[0][0] + s[1][1] + s[2][2];
        double vm2  = 0.0;
        for (int i = 0; i < 3; ++i)
            for (int j = 0; j < 3; ++j) {
                double dev = s[i][j] - (i == j ? tr_s / 3.0 : 0.0);
                vm2 += dev * dev;
            }
        sol->von_mises[e] = std::sqrt(1.5 * vm2);
    }

    return static_cast<MfemSolutionHandle>(sol);
}

size_t mfem_solution_n_vertices(MfemSolutionHandle sol)
{
    return static_cast<size_t>(static_cast<MfemSolutionState*>(sol)->n_vertices);
}

size_t mfem_solution_n_elements(MfemSolutionHandle sol)
{
    return static_cast<size_t>(static_cast<MfemSolutionState*>(sol)->n_elements);
}

void mfem_solution_get_displacements(MfemSolutionHandle sol, double* out)
{
    auto* s = static_cast<MfemSolutionState*>(sol);
    std::memcpy(out, s->displacements.data(), s->displacements.size() * sizeof(double));
}

void mfem_solution_get_von_mises(MfemSolutionHandle sol, double* out)
{
    auto* s = static_cast<MfemSolutionState*>(sol);
    std::memcpy(out, s->von_mises.data(), s->von_mises.size() * sizeof(double));
}

void mfem_free_mesh(MfemMeshHandle mesh)
{
    delete static_cast<MfemMeshState*>(mesh);
}

void mfem_free_solution(MfemSolutionHandle sol)
{
    delete static_cast<MfemSolutionState*>(sol);
}

} // extern "C"
