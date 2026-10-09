// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Geometry editing on the loaded CAD shape: split faces or bodies with a plane,
// so a support or a load can be applied to part of a face (a bearing pad, a
// load patch) instead of the whole of it.
#pragma once

#include <emscripten/val.h>

#include <string>

// Split the cached CAD shape (loaded by tessellate_step) with a plane.
//
// opts_json:
//   { "mode":    "faces" | "bodies",
//     "origin":  [x, y, z],            a point on the cutting plane (mm)
//     "normal":  [nx, ny, nz],         the plane normal (any length > 0)
//     "faceIds": [..],                 "faces": the faces to split — 1-based ids
//                                      as tessellate_step's triangleFaceIds
//                                      reports them. Only these faces are cut;
//                                      the solid stays one body.
//     "bodyIds": [..] }                "bodies": the bodies to cut in two —
//                                      1-based solid ids; absent or empty cuts
//                                      every body the plane crosses.
//
// "faces" imprints the plane's intersection with each picked face as a new edge,
// so the face becomes two (or more) faces of the same solid. "bodies" cuts the
// solids themselves; the pieces are bonded again on reload, like any touching
// bodies of an assembly (imprint_touching_solids).
//
// Returns { bytes: Uint8Array (STEP AP214 of the edited shape), faceCount,
// bodyCount }. Every requested face or body must actually be split — a plane
// that misses it, runs along its boundary or lies parallel to it is an error
// naming the face or body, never a silent no-op.
//
// The edit is handed back as a STEP file rather than kept in memory: the app
// re-meshes from file bytes (the worker is torn down after every mesh), so the
// bytes are the geometry. The cached shape is released; load the returned bytes
// with tessellate_step before meshing or editing again, so face ids always
// refer to exactly what the file contains.
emscripten::val split_geometry(const std::string& opts_json);
