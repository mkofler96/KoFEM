#pragma once
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/// Options controlling Netgen quality meshing.
typedef struct {
    double max_element_size;  // maximum tet edge length (mm)
    double min_element_size;  // minimum tet edge length (0 = auto)
    double grading;           // mesh grading 0.1 (fine) … 1.0 (coarse)
    int    second_order;      // 1 = generate quadratic tets (10-node)
} NgMeshOptions;

/// Opaque handle to a Netgen mesh in progress.
typedef void* NgMeshHandle;

/// Create a Netgen mesh and populate it with a closed surface.
/// @param vertices  flat array of 3*n_vertices doubles [x0,y0,z0, x1,y1,z1, …]
/// @param n_vertices number of surface vertices
/// @param triangles flat array of 3*n_triangles ints (0-based indices)
/// @param n_triangles number of surface triangles
/// @return opaque handle; caller must free with ng_mesh_free()
NgMeshHandle ng_mesh_create(
    const double* vertices,  size_t n_vertices,
    const int32_t* triangles, size_t n_triangles);

/// Generate the volume mesh for a previously created surface mesh handle.
/// Returns 0 on success, non-zero on failure.
int ng_mesh_generate_volume(NgMeshHandle mesh, const NgMeshOptions* opts);

/// Number of vertices in the generated volume mesh (including added interior nodes).
size_t ng_mesh_n_vertices(NgMeshHandle mesh);

/// Number of tetrahedra in the generated volume mesh.
size_t ng_mesh_n_tets(NgMeshHandle mesh);

/// Copy out volume mesh vertices.  @p out must have 3 * ng_mesh_n_vertices() doubles.
void ng_mesh_get_vertices(NgMeshHandle mesh, double* out);

/// Copy out tetrahedra.  @p out must have 4 * ng_mesh_n_tets() int32_ts (0-based).
void ng_mesh_get_tets(NgMeshHandle mesh, int32_t* out);

/// Release all resources.
void ng_mesh_free(NgMeshHandle mesh);

#ifdef __cplusplus
}
#endif
