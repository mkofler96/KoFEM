// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// OCCT surface tessellation: a fine chord-tolerant triangulation for display,
// and a coarser, element-size-matched re-tessellation used as meshing input.
#pragma once

#include <emscripten/val.h>

#include <string>

// Read + sew the CAD bytes, cache the shape, and return a display tessellation
// as {vertices: Float32Array, triangles: Uint32Array}.
emscripten::val tessellate_step(emscripten::val bytes_val, const std::string& opts_json);

// Re-tessellate the cached shape with parameters tied to the target element
// size; returns {vertices, triangles} JSON for use as Netgen surface input.
std::string tessellate_for_meshing(const std::string& opts_json);
