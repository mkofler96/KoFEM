// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Netgen volume meshing: build a tetrahedral FEM mesh directly from the cached
// OCC geometry.
#pragma once

#include <emscripten/val.h>

#include <string>

// Mesh the cached CAD shape via Netgen's OCC integration (edge → surface →
// volume). Returns {vertices, tetrahedra, surfaceTriangles, surfaceFaceIds}
// as flat typed arrays (Float64 xyz per vertex, Int32 indices) — binary
// transfer, no JSON text (issue #166).
// When the surface mesh overlaps itself, or Netgen could not mesh some faces,
// no volume mesh exists: returns { overlaps: [..] } instead (see mesh_overlap.h;
// faces that failed to mesh have kind "unmeshed").
emscripten::val generate_fem_mesh(const std::string& opts_json);
