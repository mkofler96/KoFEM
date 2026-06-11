// Thin wrappers around Netgen internal APIs that nglib does not expose.
// Implemented in netgen_glue.cpp, which is the only translation unit that
// includes Netgen's internal headers (keeping them out of engine.cpp, which
// already includes MFEM and Embind).
#pragma once

class TopoDS_Shape;

// Build a netgen::OCCGeometry directly from an already-transferred OCCT shape.
// Equivalent to Ng_OCC_Load_STEP but without re-reading and re-translating the
// STEP file. The returned pointer is an OCCGeometry* usable wherever nglib
// expects an Ng_OCC_Geometry*. Free with kofem_occ_geometry_delete.
void* kofem_occ_geometry_from_shape(const TopoDS_Shape& shape);

void kofem_occ_geometry_delete(void* geom);

// OCC face index (1-based) of surface element i (1-based) of an Ng_Mesh.
// Netgen records the owning CAD face of every surface element it generates;
// nglib has no accessor for it, but Ng_Mesh* is a netgen::Mesh* internally.
int kofem_surface_element_face_index(void* mesh, int i);
