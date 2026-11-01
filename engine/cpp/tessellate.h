// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// OCCT surface tessellation: a fine chord-tolerant triangulation for display.
#pragma once

#include <emscripten/val.h>

#include <string>

// Read + sew the CAD bytes, cache the shape, and return a display tessellation
// as {vertices: Float32Array, triangles: Uint32Array}.
emscripten::val tessellate_step(emscripten::val bytes_val, const std::string& opts_json);
