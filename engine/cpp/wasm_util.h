// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Emscripten-specific helpers shared across the pipeline stages: WASM linear
// memory diagnostics and zero-copy typed-array returns.
#pragma once

#include <emscripten/val.h>

#include <cstdint>
#include <vector>

// Report total WASM linear-memory size and the approximate amount currently
// in-use by malloc, tagged with `label`.
void log_mem(const char* label);

// Return a numeric vector as a JS typed array, copied out of the WASM-heap view
// into a JS-owned buffer (so the data survives the source vector's destruction).
emscripten::val float32_array(const std::vector<float>& v);
emscripten::val uint32_array(const std::vector<uint32_t>& v);
