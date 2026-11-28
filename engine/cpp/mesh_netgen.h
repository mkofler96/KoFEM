// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Netgen meshing: build a tetrahedral FEM mesh directly from the cached OCC
// geometry, and the surface mesh of the CAD mid-surfaces of Shell bodies.
#pragma once

#include <emscripten/val.h>

#include <string>

// Mesh the cached CAD shape via Netgen's OCC integration (edge → surface →
// volume). Returns {vertices, tetrahedra, bodyIds, surfaceTriangles,
// surfaceFaceIds} as flat typed arrays (Float64 xyz per vertex, Int32 indices)
// — binary transfer, no JSON text (issue #166).
//
// opts.shell_bodies lists the bodies marked Shell, and then opts.thin_wall is
// required (mid_surface.h). The result adds shellRoutes, one route per Shell
// body. A body on the CAD path is not volume-meshed: its mid-surface is meshed
// as a surface only and returned as
//   midSurface { vertices: Float64Array, triangles: Int32Array (wound so each
//     normal points to the top side), midFace: Int32Array (per triangle, index
//     into faces), faces: [{ body, top, bottom, thickness, topAreaRatio,
//     bottomAreaRatio }] (the area of each source face per unit mid-surface
//     area: 1 when flat, r_face / r_mid when cylindrical), rimEdges:
//     Int32Array ([a, b, sideFace] per rim edge) }
// with its own vertex numbering. The other arrays then hold only the bodies
// meshed as volumes, and are empty when there are none.
//
// When the surface mesh overlaps itself, or Netgen could not mesh some faces,
// no volume mesh exists: returns { overlaps: [..] } instead (see mesh_overlap.h;
// faces that failed to mesh have kind "unmeshed"; a mid face is named by its
// top face).
emscripten::val generate_fem_mesh(const std::string& opts_json);
