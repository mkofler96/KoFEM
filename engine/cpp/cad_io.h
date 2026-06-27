// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// OCCT data-exchange: read STEP/IGES bytes into a TopoDS_Shape and repair
// surface-only geometry into a watertight solid the volume mesher can fill.
#pragma once

#include <TopoDS_Shape.hxx>

#include <cstdint>
#include <string>
#include <vector>

// Read a CAD file (STEP or IGES) from raw bytes into an OCCT shape.
// `format` is "step" (default) or "iges".
TopoDS_Shape read_cad_shape(const std::vector<uint8_t>& bytes, const std::string& format);

// Sew loose surface faces into shells and promote every watertight shell to a
// solid, so the volume mesher has a region to fill (issue #276). Returns the
// shape unchanged when it already contains a solid or when no closed shell forms.
TopoDS_Shape sew_faces_into_solid(const TopoDS_Shape& shape);

// Longest diagonal of the shape's axis-aligned bounding box (mm), or 0 if empty.
// Used to scale the tessellation chord tolerance with model size.
double shape_bbox_diagonal(const TopoDS_Shape& shape);
