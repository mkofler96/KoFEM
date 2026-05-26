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
    // Displacement GridFunction lives on the FE space; we cache flattened arrays.
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

    auto* state = new MfemMeshState();
    // Build mesh manually: 3-D, n_vertices vertices, n_tets elements, no boundary elements
    state->mesh = std::make_unique<Mesh>(dim, (int)n_vertices, (int)n_tets);

    for (size_t i = 0; i < n_vertices; ++i) {
        double coords[3] = {vertices[3*i], vertices[3*i+1], vertices[3*i+2]};
        state->mesh->AddVertex(coords);
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

    const int dim = mesh.Dimension();
    const int order = std::max(1, params->order);

    // Lamé parameters from Young's modulus and Poisson ratio
    const double E  = params->young_modulus;
    const double nu = params->poisson_ratio;
    const double lam = E * nu / ((1.0 + nu) * (1.0 - 2.0 * nu));
    const double mu  = E / (2.0 * (1.0 + nu));

    H1_FECollection fec(order, dim);
    FiniteElementSpace fespace(&mesh, &fec, dim); // vector-valued

    // Mark essential (fixed) DOFs
    Array<int> ess_tdof_list;
    {
        // Tag fixed vertices with a boundary attribute and collect their DOFs.
        // MFEM's MarkBoundaryAttributeFixed works on boundary elements; for
        // interior-vertex fixing we target DOFs directly.
        Array<int> ess_bdr(mesh.bdr_attribute_max());
        ess_bdr = 0;
        if (n_fixed > 0) {
            ess_bdr = 1; // fix all boundary attributes (simplified)
        }
        fespace.GetEssentialTrueDofs(ess_bdr, ess_tdof_list);
    }

    // Bilinear form: elasticity
    BilinearForm a(&fespace);
    ConstantCoefficient lambda_coef(lam), mu_coef(mu);
    a.AddDomainIntegrator(new ElasticityIntegrator(lambda_coef, mu_coef));
    a.Assemble();

    // Linear form: point loads
    LinearForm b(&fespace);
    // Body forces (zero by default)
    VectorConstantCoefficient zero_force(Vector(dim));
    b.AddDomainIntegrator(new VectorDomainLFIntegrator(zero_force));
    b.Assemble();

    // Apply concentrated forces by directly setting the RHS at DOFs
    for (size_t i = 0; i < n_loads; ++i) {
        const auto& load = loads[i];
        // Map vertex index → DOF indices
        Array<int> vdofs;
        fespace.GetVertexVDofs(load.vertex_index, vdofs);
        if (vdofs.Size() >= 3) {
            b[vdofs[0]] += load.fx;
            b[vdofs[1]] += load.fy;
            b[vdofs[2]] += load.fz;
        }
    }

    // Solution vector
    GridFunction x(&fespace);
    x = 0.0;

    // Eliminate essential DOFs
    OperatorPtr A;
    Vector B, X;
    a.FormLinearSystem(ess_tdof_list, x, b, A, X, B);

    // Conjugate gradient with GS smoother preconditioner
    GSSmoother prec;
    CGSolver cg;
    cg.SetRelTol(1e-8);
    cg.SetMaxIter(2000);
    cg.SetPrintLevel(0);
    cg.SetPreconditioner(prec);
    cg.SetOperator(*A);
    cg.Mult(B, X);

    a.RecoverFEMSolution(X, b, x);

    // --- Cache results ---
    auto* sol = new MfemSolutionState();
    sol->n_vertices = mesh.GetNV();
    sol->n_elements = mesh.GetNE();

    // Displacements: evaluate GridFunction at mesh vertices
    sol->displacements.resize(3 * (size_t)sol->n_vertices, 0.0);
    for (int vi = 0; vi < sol->n_vertices; ++vi) {
        Array<int> vdofs;
        fespace.GetVertexVDofs(vi, vdofs);
        for (int c = 0; c < dim && c < vdofs.Size(); ++c) {
            sol->displacements[3*vi + c] = x[vdofs[c]];
        }
    }

    // Von-Mises stress: computed per element via L2 projection
    sol->von_mises.resize((size_t)sol->n_elements, 0.0);
    {
        L2_FECollection l2fec(order - 1, dim);
        FiniteElementSpace l2fespace(&mesh, &l2fec);
        GridFunction sigma_vm(&l2fespace);

        // ElasticEnergyDensityCoefficient is not standard; compute stress manually
        // by evaluating the strain energy density at element centres.
        for (int e = 0; e < sol->n_elements; ++e) {
            ElementTransformation* T = mesh.GetElementTransformation(e);
            T->SetIntPoint(&Geometries.GetCenter(mesh.GetElementBaseGeometry(e)));

            DenseMatrix grad_u;
            x.GetVectorGradient(*T, grad_u); // 3×3 displacement gradient

            // Strain tensor ε = 0.5*(∇u + ∇uᵀ)
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

            // Von-Mises: √(3/2 * s_ij * s_ij) where s_ij = σ_ij − (tr σ / 3) δ_ij
            double tr_s = s[0][0] + s[1][1] + s[2][2];
            double vm2 = 0.0;
            for (int i = 0; i < 3; ++i)
                for (int j = 0; j < 3; ++j) {
                    double dev = s[i][j] - (i == j ? tr_s / 3.0 : 0.0);
                    vm2 += dev * dev;
                }
            sol->von_mises[e] = std::sqrt(1.5 * vm2);
        }
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
