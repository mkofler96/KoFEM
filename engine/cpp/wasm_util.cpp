// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

#include "wasm_util.h"

#include <emscripten.h>

#include <cstdio>
#include <malloc.h>
#include <stdexcept>
#include <string>

using emscripten::val;

// ── Memory diagnostics ────────────────────────────────────────────────────────
// Reports total WASM linear-memory size (grows with ALLOW_MEMORY_GROWTH) and
// the approximate amount of that memory currently in-use by malloc.
void log_mem(const char* label) {
    struct mallinfo mi = mallinfo();
    // HEAP8.length == current WASM linear-memory size in bytes.
    int wasm_mb = EM_ASM_INT({ return HEAP8.length >> 20; });
    // uordblks is bytes allocated by malloc (does not include mmap'd regions).
    int used_mb = (int)((unsigned)mi.uordblks >> 20);
    printf("[mem] %-44s  wasm=%d MB  alloc~%d MB\n", label, wasm_mb, used_mb);
    fflush(stdout);
}

// ── Binary output helpers ─────────────────────────────────────────────────────
// Return tessellation data as JS typed arrays instead of a JSON text string.
// The string path built a multi-MB buffer with ostringstream — formatting every
// coordinate to decimal text — which JS then re-parsed with JSON.parse.  Both are
// O(triangles) and dominated STEP-load time on large parts.  new Float32Array(view)
// copies the WASM-heap view into a JS-owned buffer synchronously (no intervening
// allocation under ALLOW_MEMORY_GROWTH), so the data survives the source vector's
// destruction when the function returns.

val float32_array(const std::vector<float>& v) {
    return val::global("Float32Array")
        .new_(val(emscripten::typed_memory_view(v.size(), v.data())));
}

val uint32_array(const std::vector<uint32_t>& v) {
    return val::global("Uint32Array")
        .new_(val(emscripten::typed_memory_view(v.size(), v.data())));
}

val float64_array(const std::vector<double>& v) {
    return val::global("Float64Array")
        .new_(val(emscripten::typed_memory_view(v.size(), v.data())));
}

val int32_array(const std::vector<int32_t>& v) {
    return val::global("Int32Array")
        .new_(val(emscripten::typed_memory_view(v.size(), v.data())));
}

// ── Binary input helpers ──────────────────────────────────────────────────────
// Copy a JS numeric array into a C++ vector with a single
// TypedArray.prototype.set call on a WASM-heap view over the vector's storage.
// The element-wise alternative (arr[i].as<double>()) crosses the JS↔WASM
// boundary once per element — hundreds of ms for a 50k-node mesh.  .set()
// accepts any numeric source (Float64Array, Int32Array, plain Array) and
// converts per JS semantics, so callers can pass whichever they hold.
// The heap view is created immediately before .set with no intervening
// allocation, so ALLOW_MEMORY_GROWTH cannot invalidate it.

namespace {
template <typename T>
std::vector<T> copy_js_array(const val& a, const char* what) {
    if (a.isUndefined() || a.isNull() || a["length"].isUndefined())
        throw std::runtime_error(std::string(what) +
                                 " is missing or not an array — expected a typed array "
                                 "(or Array) of numbers");
    std::vector<T> out(a["length"].as<size_t>());
    if (!out.empty())
        val(emscripten::typed_memory_view(out.size(), out.data())).call<void>("set", a);
    return out;
}
}  // namespace

std::vector<double> f64_vector(const val& a, const char* what) {
    return copy_js_array<double>(a, what);
}

std::vector<int32_t> i32_vector(const val& a, const char* what) {
    return copy_js_array<int32_t>(a, what);
}
