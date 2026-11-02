// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Where and why a surface mesh overlaps itself, from the elements Netgen flagged.
#pragma once

#include "netgen_glue.h"

#include <emscripten/val.h>

#include <vector>

class TopoDS_Shape;

// Group the flagged surface elements into regions and describe each one:
//
//   { kind:      "hinge" | "surface",
//     faceIds:   [..],                 1-based OCC faces of the flagged elements
//     bodyId:    1-based solid owning the first of them
//     positions: Float64Array,         xyz of 3 corners per flagged element
//     hinge?:    { start, end, normal, length } }  "hinge" only (mm)
//
// A "hinge" is a straight tangent contact between two faces facing each other:
// the solid pinches to zero thickness along that line, which no tetrahedron can
// fill. It is located exactly from the CAD faces, so it can be repaired
// (repair_hinges). Anything else is a "surface" overlap, located only by its
// elements.
emscripten::val describe_mesh_overlaps(const std::vector<KofemSurfaceTriangle>& triangles,
                                       const TopoDS_Shape& shape);
