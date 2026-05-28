#pragma once
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/// Opaque MFEM mesh handle.
typedef void* MfemMeshHandle;

/// Opaque handle to a completed solution.
typedef void* MfemSolutionHandle;

/// A Dirichlet constraint: pin all three displacement DOFs at a vertex to zero.
typedef struct {
    int32_t vertex_index;   // 0-based
} MfemFixedVertex;

/// A Neumann load: concentrated force at a vertex.
typedef struct {
    int32_t vertex_index;   // 0-based
    double  fx, fy, fz;     // force components (N)
} MfemPointLoad;

/// Parameters for linear-elastic solve.
typedef struct {
    double young_modulus;   // Pa
    double poisson_ratio;   // dimensionless
    int    order;           // FE polynomial order (1 = linear, 2 = quadratic)
} MfemElasticParams;

/// Build an MFEM mesh from raw tet data.
/// @param vertices    flat [x0,y0,z0, x1,…] array, n_vertices × 3 doubles
/// @param n_vertices  vertex count
/// @param tets        flat [a0,b0,c0,d0, …] array, n_tets × 4 int32_ts (0-based)
/// @param n_tets      tet count
/// @param err         set to a static error string on failure
MfemMeshHandle mfem_create_mesh(
    const double*  vertices,  size_t n_vertices,
    const int32_t* tets,      size_t n_tets,
    const char** err);

/// Solve linear elasticity on the mesh.
/// @param mesh         mesh handle
/// @param params       material and solver parameters
/// @param fixed        array of fixed-vertex constraints
/// @param n_fixed      length of fixed[]
/// @param loads        array of point loads
/// @param n_loads      length of loads[]
/// @param err          set to a static error string on failure
MfemSolutionHandle mfem_solve_linear_elastic(
    MfemMeshHandle mesh,
    const MfemElasticParams* params,
    const MfemFixedVertex* fixed,  size_t n_fixed,
    const MfemPointLoad*   loads,  size_t n_loads,
    const char** err);

/// Number of vertices in the (possibly refined) solution mesh.
size_t mfem_solution_n_vertices(MfemSolutionHandle sol);

/// Copy displacement vector: 3 doubles per vertex [ux, uy, uz].
void mfem_solution_get_displacements(MfemSolutionHandle sol, double* out);

/// Number of elements in the solution mesh (for per-element stress output).
size_t mfem_solution_n_elements(MfemSolutionHandle sol);

/// Copy von-Mises stress: 1 double per element.
void mfem_solution_get_von_mises(MfemSolutionHandle sol, double* out);

void mfem_free_mesh(MfemMeshHandle mesh);
void mfem_free_solution(MfemSolutionHandle sol);

#ifdef __cplusplus
}
#endif
