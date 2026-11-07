// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Where and why a surface mesh overlaps itself, from the elements Netgen flagged.
#pragma once

#include "netgen_glue.h"

#include <emscripten/val.h>

#include <vector>

class TopoDS_Face;
class TopoDS_Shape;

// Group the flagged surface elements into regions and describe each one:
//
//   { kind:      "hinge" | "cone" | "surface",
//     faceIds:   [..],                 1-based OCC faces of the flagged elements
//     bodyId:    1-based solid owning the first of them
//     positions: Float64Array,         xyz of 3 corners per flagged element
//     hinge?:    { start, end, normal, length } }  "hinge" only (mm)
//
// A "hinge" is a straight tangent contact between two faces facing each other:
// the solid pinches to zero thickness along that line, which no tetrahedron can
// fill. It is located exactly from the CAD faces, so it can be repaired
// (repair_hinges). A "cone" region holds a full cone face closing at its tip,
// which Netgen can fail to mesh at any element size; dividing it fixes that
// (split_cone_tips). Anything else is a "surface" overlap, located only by its
// elements.
emscripten::val describe_mesh_overlaps(const std::vector<KofemSurfaceTriangle>& triangles,
                                       const TopoDS_Shape& shape);

// Describe the faces Netgen could not mesh (kofem_unmeshed_faces) in the same
// shape as overlaps: two failed faces touching along a hinge, with the failed
// faces sharing an edge with them, as one "hinge"; every other face on its own,
// as "cone" if it is a closed cone tip (split_cone_tips repairs it), otherwise
// as "unmeshed". Positions are the faces' display tessellation, so a face with
// no surface elements at all is still highlighted. A cone or unmeshed entry also
// carries the face's width (mm, 2·area / perimeter): failed faces are mostly
// slivers far narrower than an element.
emscripten::val describe_unmeshed_faces(const std::vector<int>& face_ids,
                                        const TopoDS_Shape& shape);

// A face's width (mm): 2·area / perimeter, the width of a strip, the radius of
// a disc.
double face_width(const TopoDS_Face& face);

// A cone face going all the way around and closing at its tip.
bool is_closed_cone_tip(const TopoDS_Face& face);
