// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Per-face properties of the cached CAD shape (KOF-493): what each CAD face is,
// measured on its exact surface rather than on a tessellation. A general query
// for every caller that needs to know a face — the status bar describes the
// selected face with it, and a load or support can read its area.
#pragma once

#include <emscripten/val.h>

#include <cstdint>

// The surface type codes in the result's surfaceTypes array.
enum class FaceSurfaceType : uint8_t {
    Plane = 0,
    Cylinder = 1,
    Cone = 2,
    Other = 3,
};

// Embind export: properties of every face of the cached shape, in CAD face id
// order (entry i is face id i + 1, the ids tessellate_step reports), as
// {surfaceTypes: Uint8Array, areas: Float64Array (mm²),
//  directions: Float64Array (3 per face), radii: Float64Array (mm)}.
// directions holds a plane's outward unit normal and a cylinder's or cone's
// unit axis direction; radii a cylinder's radius. Both are zero where they do
// not apply. Throws when no shape is cached.
emscripten::val cad_face_properties();
