// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

#include "geometry_cache.h"

#include "wasm_util.h"

#include <BRepTools.hxx>

#include <cstdio>
#include <stdexcept>

// Stored by tessellate_step for reuse by tessellate_for_meshing and
// generate_fem_mesh, which build the Netgen OCC geometry directly from this
// shape (no CAD re-read).
static TopoDS_Shape g_step_shape;
static bool         g_has_step_shape = false;

bool has_cached_shape() {
    return g_has_step_shape;
}

const TopoDS_Shape& cached_shape() {
    if (!g_has_step_shape)
        throw std::runtime_error("no CAD shape cached — call tessellate_step first");
    return g_step_shape;
}

void set_cached_shape(const TopoDS_Shape& shape) {
    g_step_shape     = shape;
    g_has_step_shape = true;
}

void free_geometry_cache() {
    log_mem("free_geometry_cache: before");
    BRepTools::Clean(g_step_shape);  // detach BRepMesh triangulations from faces
    g_step_shape     = TopoDS_Shape();
    g_has_step_shape = false;
    printf("[kofem] geometry cache freed\n");
    fflush(stdout);
    log_mem("free_geometry_cache: after");
}
