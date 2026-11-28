// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Which element size each solid, face and edge is meshed at. The user sets
// sizes on the CAD geometry only — the whole model, each body (KOF-257) and
// chosen faces (KOF-394) — and these tables carry them to whatever Netgen
// meshes: the solid bodies, and the mid-surfaces of the Shell bodies that take
// the CAD path (KOF-498). netgen_glue's kofem_apply_max_sizes applies a table.
#pragma once

#include "mid_surface.h"
#include "netgen_glue.h"

#include <TopoDS_Shape.hxx>

#include <vector>

// The sizes of one mesh request, validated against the whole shape.
struct MeshSizes {
    // Entry k is the max size (mm) of solid k + 1 of the whole shape; empty
    // when no body has a size of its own.
    std::vector<double> solid_max;
    // Face ids of the whole shape.
    std::vector<KofemFaceMaxSize> face_max;
};

// The sizes for meshing `part` — the whole shape, or some of its solids — as
// volumes. Each solid takes its body size; a face or edge between two solids
// the finer of theirs, so the finer region is fine right up to the cut; a sized
// face takes its own size, and so do its edges, which are meshed before it and
// would otherwise hand it a coarse rim.
std::vector<KofemShapeMaxSize> solid_mesh_sizes(const TopoDS_Shape& shape,
                                                const TopoDS_Shape& part,
                                                const MeshSizes& sizes);

// The sizes for meshing the mid-surface of `analysis`. A mid face takes the
// smallest of its body's size and the sizes of its top and bottom source
// faces; a rim edge also takes the size of the side face it came from.
std::vector<KofemShapeMaxSize> mid_surface_mesh_sizes(const ShellBodyAnalysis& analysis,
                                                      const MeshSizes& sizes);
