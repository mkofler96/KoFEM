// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Cross-call cache of the loaded CAD shape.
//
// The JS API loads geometry once (tessellate_step) and then issues several
// follow-up calls — tessellate_for_meshing, generate_fem_mesh — that each need
// the same OCCT shape. Rather than re-reading the CAD file every time, the shape
// is cached here between Embind calls.
//
// Ownership is explicit and one-directional: set_cached_shape is the sole writer
// (called only from tessellate_step), the mesher and re-tessellator are
// read-only consumers via cached_shape(), and free_geometry_cache releases it
// once meshing is done so the memory is available for the MFEM solve. Routing
// the former global g_step_shape through these accessors keeps that lifetime
// visible at every call site instead of buried in a mutable file-scope global.
#pragma once

#include <TopoDS_Shape.hxx>

// True once a shape has been loaded and not yet freed.
bool has_cached_shape();

// The cached shape. Const because consumers must not rebind it; the OCCT calls
// that re-tessellate it (BRepTools::Clean, BRepMesh_IncrementalMesh) take a
// const reference and mutate the shared TShape through the handle.
const TopoDS_Shape& cached_shape();

// Replace the cached shape (tessellate_step only).
void set_cached_shape(const TopoDS_Shape& shape);

// Embind export: release the OCCT shape cache.  Call this from JS after meshing
// is done so the memory is available for the MFEM solve.
void free_geometry_cache();
