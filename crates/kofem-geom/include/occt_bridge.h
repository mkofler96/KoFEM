#pragma once
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/// Opaque handle to an OCCT TopoDS_Shape.
typedef void* OcctShape;

/// Options for incremental surface tessellation.
typedef struct {
    /// Chord-height tolerance (mm). Controls how closely flat triangles approximate
    /// curved surfaces.  Typical: 0.1–0.5 mm for mechanical parts.
    double linear_deflection;
    /// Maximum angular deviation of normals between adjacent triangles (radians).
    double angular_deflection;
    /// If non-zero, use relative deflection (fraction of bounding-box size).
    int relative_deflection;
} OcctTessOptions;

/// Load a STEP file from an in-memory buffer.
/// @param data   raw STEP file bytes
/// @param len    byte count
/// @param err    set to a non-NULL static error string on failure
/// @return opaque shape handle, or NULL on failure
OcctShape occt_load_step(const uint8_t* data, size_t len, const char** err);

/// Free a shape handle obtained from occt_load_step.
void occt_free_shape(OcctShape shape);

/// Tessellate the shape into a triangle surface mesh.
///
/// On success the caller owns the two output arrays and must free them
/// with occt_free_tessellation().
///
/// @param shape          shape to tessellate
/// @param opts           tessellation parameters
/// @param out_vertices   set to a flat array of 3*(*out_n_vertices) doubles
/// @param out_n_vertices number of vertices
/// @param out_triangles  set to a flat array of 3*(*out_n_triangles) int32_ts (0-based)
/// @param out_n_triangles number of triangles
/// @param err            set to a non-NULL static error string on failure
/// @return 0 on success
int occt_tessellate(
    OcctShape shape,
    const OcctTessOptions* opts,
    double**  out_vertices,   size_t* out_n_vertices,
    int32_t** out_triangles,  size_t* out_n_triangles,
    const char** err);

/// Free buffers returned by occt_tessellate.
void occt_free_tessellation(double* vertices, int32_t* triangles);

#ifdef __cplusplus
}
#endif
