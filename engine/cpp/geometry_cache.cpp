// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

#include "geometry_cache.h"

#include "wasm_util.h"

#include <BRepTools.hxx>

#include <cstdio>
#include <stdexcept>

// Stored by tessellate_step for reuse by tessellate_for_meshing and
// generate_fem_mesh, which build the Netgen OCC geometry directly from this
// shape (no CAD re-read). Held in a function-local static so the mutable
// state has a single named access path instead of file-scope globals.
namespace {
struct ShapeCache {
    TopoDS_Shape shape;
    bool valid = false;
};

ShapeCache& shape_cache() {
    static ShapeCache cache;
    return cache;
}
}  // namespace

bool has_cached_shape() {
    return shape_cache().valid;
}

const TopoDS_Shape& cached_shape() {
    if (!shape_cache().valid)
        throw std::runtime_error("no CAD shape cached — call tessellate_step first");
    return shape_cache().shape;
}

void set_cached_shape(const TopoDS_Shape& shape) {
    shape_cache().shape = shape;
    shape_cache().valid = true;
}

void free_geometry_cache() {
    log_mem("free_geometry_cache: before");
    BRepTools::Clean(shape_cache().shape);  // detach BRepMesh triangulations from faces
    shape_cache().shape = TopoDS_Shape();
    shape_cache().valid = false;
    printf("[kofem] geometry cache freed\n");
    fflush(stdout);
    log_mem("free_geometry_cache: after");
}
