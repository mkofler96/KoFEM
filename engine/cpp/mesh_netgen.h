// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Netgen volume meshing: build a tetrahedral FEM mesh either directly from the
// cached OCC geometry (preferred) or from an explicit surface mesh.
#pragma once

#include <emscripten/val.h>

#include <string>

// Mesh the cached CAD shape via Netgen's OCC integration (edge → surface →
// volume). Returns {vertices, tetrahedra, surfaceTriangles, surfaceFaceIds}
// as flat typed arrays (Float64 xyz per vertex, Int32 indices) — binary
// transfer, no JSON text (issue #166).
emscripten::val generate_fem_mesh(const std::string& opts_json);

// Fill an explicit surface mesh (vertices + triangles JSON) with tetrahedra.
// Returns {vertices, tetrahedra} JSON.
std::string generate_volume_mesh(const std::string& surface_json, const std::string& opts_json);
