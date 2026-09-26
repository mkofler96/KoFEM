// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Adapt the optional JS density callback the optimize_topology* Embind entries
// take into the JS-free DensityCallback the SIMP loops call (KOF-240).
#pragma once

#include "topology_stream.h"
#include "wasm_util.h"

#include <emscripten/val.h>

#include <stdexcept>
#include <string>
#include <vector>

namespace kofem::topopt {

// null/undefined → no streaming. Otherwise each call hands JS a fresh
// Float64Array copy of ρ (float64_array copies out of the WASM heap), so the
// receiver owns it and may transfer it onward.
inline DensityCallback js_density_callback(const emscripten::val& cb) {
    if (cb.isUndefined() || cb.isNull()) return {};
    if (cb.typeOf().as<std::string>() != "function")
        throw std::runtime_error(
            "optimize_topology: on_density must be a function, null or undefined");
    return [cb](int it, const std::vector<double>& rho) {
        cb(it, float64_array(rho));
    };
}

}  // namespace kofem::topopt
