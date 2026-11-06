// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Thin wrappers around Netgen internal APIs that nglib does not expose.
// Implemented in netgen_glue.cpp, which is the only translation unit that
// includes Netgen's internal headers (keeping them out of engine.cpp, which
// already includes MFEM and Embind).
#pragma once

#include <array>
#include <vector>

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

// Domain (subdomain) index (1-based) of volume element i (1-based) of an
// Ng_Mesh. For OCC-meshed geometry each solid of the shape is one meshing
// domain in TopExp order, so this is the body the tetrahedron belongs to
// (issue #353). Sibling of kofem_surface_element_face_index: nglib exposes no
// accessor for it either.
int kofem_volume_element_domain_index(void* mesh, int i);

// A surface element Netgen's overlap check flagged: its corners and the 1-based
// OCC face it belongs to.
struct KofemSurfaceTriangle {
    std::array<std::array<double, 3>, 3> points;
    int face;
};

// The surface elements of an Ng_Mesh that intersect another surface element.
std::vector<KofemSurfaceTriangle> kofem_overlapping_surface_elements(void* mesh);

// The 1-based OCC faces Netgen's surface mesher gave up on, from the
// netgen::OCCGeometry the surface mesh was generated from. Netgen reports a
// failed face only on stdout and still returns NG_OK, keeping whatever it made
// of the face, so the caller has to ask.
std::vector<int> kofem_unmeshed_faces(void* geom);

// Destroy an Ng_Mesh. Use this instead of nglib::Ng_DeleteMesh, which calls
// Mesh::DeleteMesh() AND then ~Mesh(): both loops `delete` every bcnames /
// materials / cd2names string* (NgArray<string*> holds raw pointers), so the
// strings allocated by Mesh::SetBCName during OCC surface meshing are freed
// twice. The resulting heap-freelist corruption is benign or fatal depending
// on the exact WASM binary layout — a rebuild can flip it from passing to a
// trap mid-pipeline. Running only the destructor frees each string once.
void kofem_delete_mesh(void* mesh);
